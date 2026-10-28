// Continuous monitoring: a saved search that re-runs on a cadence, diffs each run's leads against
// what the monitor has already surfaced, and records the new ones. Monitor runs are real scans:
// they go through the same pipeline and verifier, and they count toward the monthly scan quota.
// Caps keep a free account from burning its quota in its sleep: free plans get 2 monitors running
// at most weekly; pro gets 10 running at most daily.
// On the Db layer (SQLite or Postgres); migrateMonitors is the SQLite schema setup.
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from './db/client.ts'
import { readPlan, readScanQuota } from './plans.ts'
import { countActiveJobs, queryJobStep } from './scan/store-db.ts'
import type { Fence } from './watch.ts'

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

const nowS = () => Math.floor(Date.now() / 1000)
const noFence: Fence = function* () { /* not fenced */ }

export type MonitorError = 'limit' | 'interval'
export async function createMonitor(db: Db, userId: string, input: { query: string; icp?: string | null; sources?: string | null; intervalHours?: number }, now = nowS()): Promise<{ id: string } | { error: MonitorError; limit?: number; min?: number }> {
  const plan = await readPlan(db, userId)
  const lim = MONITOR_LIMITS[plan]
  if (input.intervalHours !== undefined && input.intervalHours < lim.minIntervalHours) return { error: 'interval', min: lim.minIntervalHours }
  const n = Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM monitors WHERE user_id = ?', [userId]))!.n)
  if (n >= lim.maxMonitors) return { error: 'limit', limit: lim.maxMonitors }
  const interval = Math.max(lim.minIntervalHours, Math.floor(input.intervalHours ?? lim.minIntervalHours))
  const id = randomBytes(12).toString('hex')
  await db.run('INSERT INTO monitors (id, user_id, query, icp, sources, interval_hours, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, userId, input.query, input.icp ?? null, input.sources ?? null, interval, now, now])
  return { id }
}

export function listMonitors(db: Db, userId: string) {
  return db.all(
    `SELECT m.id, m.query, m.interval_hours, m.enabled, m.paused_reason, m.last_run_at, m.next_run_at, m.created_at,
       (SELECT new_count FROM monitor_runs r WHERE r.monitor_id = m.id ORDER BY r.ran_at DESC LIMIT 1) AS last_new_count,
       (SELECT count(*) FROM monitor_runs r WHERE r.monitor_id = m.id) AS run_count
     FROM monitors m WHERE m.user_id = ? ORDER BY m.created_at DESC, m.id DESC`, [userId])
}

export async function setMonitorEnabled(db: Db, userId: string, id: string, enabled: boolean): Promise<boolean> {
  return (await db.run('UPDATE monitors SET enabled = ?, paused_reason = CASE WHEN ? = 1 THEN NULL ELSE paused_reason END WHERE id = ? AND user_id = ?', [enabled ? 1 : 0, enabled ? 1 : 0, id, userId])).changes === 1
}

export async function deleteMonitor(db: Db, userId: string, id: string): Promise<boolean> {
  return (await db.run('DELETE FROM monitors WHERE id = ? AND user_id = ?', [id, userId])).changes === 1
}

// Runs every due monitor as a normal scan. A monitor whose owner is out of monthly quota pauses
// itself (reason 'quota') instead of failing scans; re-enabling clears the reason.
// Each monitor's writes are one transaction (fenced by the caller's lease, if any), and only while the monitor is still
// the due one this run read: the job, its run record and the next run commit together, or none does.
export async function runDueMonitors(db: Db, o: { now?: number; fence?: Fence } = {}): Promise<string[]> {
  const now = o.now ?? nowS(), fence = o.fence ?? noFence
  const due = await db.all<{ id: string; user_id: string; query: string; icp: string | null; sources: string | null; next_run_at: number }>(
    'SELECT id, user_id, query, icp, sources, next_run_at FROM monitors WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id', [now])
  const jobs: string[] = []
  for (const m of due) {
    if (!(await readScanQuota(db, m.user_id)).allowed) {
      await db.tx(function* (t) { yield* fence(t); yield* t.run("UPDATE monitors SET enabled = 0, paused_reason = 'quota' WHERE id = ? AND enabled = 1 AND next_run_at = ?", [m.id, m.next_run_at]) })
      continue
    }
    if (await countActiveJobs(db, m.user_id) >= 2) continue // user's own scans win; try again next tick
    const jobId = await db.tx(function* (t: Tx): TxBody<string | null> {
      yield* fence(t)
      const r = yield* t.run('UPDATE monitors SET last_run_at = ?, next_run_at = ? + interval_hours * 3600 WHERE id = ? AND enabled = 1 AND next_run_at = ?', [now, now, m.id, m.next_run_at])
      if (r.changes !== 1) return null
      const job = yield* queryJobStep(t, m.user_id, { query: m.query, icp: m.icp, sources: m.sources }, now)
      yield* t.run('INSERT INTO monitor_runs (id, monitor_id, job_id, ran_at) VALUES (?, ?, ?, ?)', [randomBytes(12).toString('hex'), m.id, job, now])
      return job
    })
    if (jobId) jobs.push(jobId)
  }
  return jobs
}

// Marks finished runs and counts leads the monitor has not surfaced before (verified and
// review-lane both count - a new company appearing is the alert, whatever lane it landed in).
// Each run is folded in one transaction (fenced by the caller's lease, if any), at most once.
export async function collectMonitorResults(db: Db, o: { fence?: Fence } = {}): Promise<number> {
  const fence = o.fence ?? noFence
  const runs = await db.all<{ id: string; monitor_id: string; job_id: string }>(
    `SELECT r.id, r.monitor_id, r.job_id FROM monitor_runs r JOIN scan_jobs j ON j.id = r.job_id
     WHERE r.processed = 0 AND j.status IN ('done','failed') ORDER BY r.ran_at, r.id`)
  let alerts = 0
  for (const r of runs) {
    const fresh = await db.tx(function* (t: Tx): TxBody<number | null> {
      yield* fence(t)
      const claim = yield* t.run('UPDATE monitor_runs SET processed = 1 WHERE id = ? AND processed = 0', [r.id])
      if (claim.changes !== 1) return null
      const keys = yield* t.all<{ dedup_key: string }>('SELECT dedup_key FROM leads WHERE scan_job_id = ? AND dedup_key IS NOT NULL', [r.job_id])
      let n = 0
      for (const { dedup_key } of keys) if ((yield* t.run('INSERT INTO monitor_seen (monitor_id, dedup_key) VALUES (?, ?) ON CONFLICT (monitor_id, dedup_key) DO NOTHING', [r.monitor_id, dedup_key])).changes === 1) n++
      yield* t.run('UPDATE monitor_runs SET new_count = ? WHERE id = ?', [n, r.id])
      // Monitor jobs reuse the query pipeline; stamp the producing channel now that the run is recorded.
      yield* t.run("UPDATE leads SET source_kind = 'monitor' WHERE scan_job_id = ?", [r.job_id])
      return n
    })
    if (fresh) alerts++
  }
  return alerts
}
