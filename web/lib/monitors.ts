// Continuous monitoring: a saved search that re-runs on a cadence, diffs each run's leads against
// what the monitor has already surfaced, and records the new ones. Monitor runs are real scans:
// they go through the same pipeline and verifier, and they count toward the monthly scan quota.
// Caps keep a free account from burning its quota in its sleep: free plans get 2 monitors running
// at most weekly; pro gets 10 running at most daily.
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getPlan, scanQuota } from './plans.ts'
import { createQueryJob, countActiveJobs } from './scan/store.ts'

export const MONITOR_LIMITS: Record<string, { maxMonitors: number; minIntervalHours: number }> = {
  free: { maxMonitors: 2, minIntervalHours: 168 }, // weekly: 2 x ~4 runs/mo fits in the 50-scan quota
  pro: { maxMonitors: 10, minIntervalHours: 24 },
}

export function migrateMonitors(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitors (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL,
      query          TEXT NOT NULL CHECK (length(query) BETWEEN 3 AND 600),
      icp            TEXT,
      sources        TEXT,
      interval_hours INTEGER NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 1,
      paused_reason  TEXT,
      last_run_at    INTEGER,
      next_run_at    INTEGER,
      created_at     INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
    CREATE INDEX IF NOT EXISTS monitors_due ON monitors (enabled, next_run_at);
    CREATE TABLE IF NOT EXISTS monitor_runs (
      id         TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      job_id     TEXT NOT NULL,
      ran_at     INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      processed  INTEGER NOT NULL DEFAULT 0,
      new_count  INTEGER
    );
    CREATE INDEX IF NOT EXISTS monitor_runs_monitor ON monitor_runs (monitor_id, ran_at);
    CREATE TABLE IF NOT EXISTS monitor_seen (
      monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      dedup_key  TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (monitor_id, dedup_key)
    );
  `)
}

export type MonitorError = 'limit' | 'interval'
export function createMonitor(db: Database.Database, userId: string, input: { query: string; icp?: string | null; sources?: string | null; intervalHours?: number }): { id: string } | { error: MonitorError; limit?: number; min?: number } {
  const plan = getPlan(db, userId)
  const lim = MONITOR_LIMITS[plan]
  if (input.intervalHours !== undefined && input.intervalHours < lim.minIntervalHours) return { error: 'interval', min: lim.minIntervalHours }
  const n = (db.prepare('SELECT count(*) AS n FROM monitors WHERE user_id = ?').get(userId) as { n: number }).n
  if (n >= lim.maxMonitors) return { error: 'limit', limit: lim.maxMonitors }
  const interval = Math.max(lim.minIntervalHours, Math.floor(input.intervalHours ?? lim.minIntervalHours))
  const id = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO monitors (id, user_id, query, icp, sources, interval_hours, next_run_at) VALUES (?, ?, ?, ?, ?, ?, CAST(strftime(\'%s\',\'now\') AS INTEGER))').run(
    id, userId, input.query, input.icp ?? null, input.sources ?? null, interval,
  )
  return { id }
}

export function listMonitors(db: Database.Database, userId: string) {
  return db.prepare(
    `SELECT m.id, m.query, m.interval_hours, m.enabled, m.paused_reason, m.last_run_at, m.next_run_at, m.created_at,
       (SELECT new_count FROM monitor_runs r WHERE r.monitor_id = m.id ORDER BY r.ran_at DESC LIMIT 1) AS last_new_count,
       (SELECT count(*) FROM monitor_runs r WHERE r.monitor_id = m.id) AS run_count
     FROM monitors m WHERE m.user_id = ? ORDER BY m.created_at DESC`,
  ).all(userId)
}

export function setMonitorEnabled(db: Database.Database, userId: string, id: string, enabled: boolean): boolean {
  return db.prepare('UPDATE monitors SET enabled = ?, paused_reason = CASE WHEN ? = 1 THEN NULL ELSE paused_reason END WHERE id = ? AND user_id = ?').run(enabled ? 1 : 0, enabled ? 1 : 0, id, userId).changes === 1
}

export function deleteMonitor(db: Database.Database, userId: string, id: string): boolean {
  return db.prepare('DELETE FROM monitors WHERE id = ? AND user_id = ?').run(id, userId).changes === 1
}

// Runs every due monitor as a normal scan. A monitor whose owner is out of monthly quota pauses
// itself (reason 'quota') instead of failing scans; re-enabling clears the reason.
export function runDueMonitors(db: Database.Database, nowS = Math.floor(Date.now() / 1000)): string[] {
  const due = db.prepare('SELECT id, user_id, query, icp, sources FROM monitors WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?').all(nowS) as { id: string; user_id: string; query: string; icp: string | null; sources: string | null }[]
  const jobs: string[] = []
  for (const m of due) {
    if (!scanQuota(db, m.user_id).allowed) {
      db.prepare("UPDATE monitors SET enabled = 0, paused_reason = 'quota' WHERE id = ?").run(m.id)
      continue
    }
    if (countActiveJobs(db, m.user_id) >= 2) continue // user's own scans win; try again next tick
    const jobId = createQueryJob(db, m.user_id, { query: m.query, icp: m.icp, sources: m.sources })
    db.prepare('INSERT INTO monitor_runs (id, monitor_id, job_id) VALUES (?, ?, ?)').run(randomBytes(12).toString('hex'), m.id, jobId)
    db.prepare('UPDATE monitors SET last_run_at = ?, next_run_at = ? + interval_hours * 3600 WHERE id = ?').run(nowS, nowS, m.id)
    jobs.push(jobId)
  }
  return jobs
}

// Marks finished runs and counts leads the monitor has not surfaced before (verified and
// review-lane both count - a new company appearing is the alert, whatever lane it landed in).
export function collectMonitorResults(db: Database.Database): number {
  const runs = db.prepare(
    `SELECT r.id, r.monitor_id, r.job_id FROM monitor_runs r JOIN scan_jobs j ON j.id = r.job_id
     WHERE r.processed = 0 AND j.status IN ('done','failed')`,
  ).all() as { id: string; monitor_id: string; job_id: string }[]
  let alerts = 0
  for (const r of runs) {
    const keys = db.prepare('SELECT dedup_key FROM leads WHERE scan_job_id = ? AND dedup_key IS NOT NULL').all(r.job_id) as { dedup_key: string }[]
    let fresh = 0
    const ins = db.prepare('INSERT OR IGNORE INTO monitor_seen (monitor_id, dedup_key) VALUES (?, ?)')
    for (const { dedup_key } of keys) if (ins.run(r.monitor_id, dedup_key).changes === 1) fresh++
    db.prepare('UPDATE monitor_runs SET processed = 1, new_count = ? WHERE id = ?').run(fresh, r.id)
    // Monitor jobs reuse the query pipeline; stamp the producing channel now that the run is recorded.
    db.prepare("UPDATE leads SET source_kind = 'monitor' WHERE scan_job_id = ?").run(r.job_id)
    if (fresh > 0) alerts++
  }
  return alerts
}
