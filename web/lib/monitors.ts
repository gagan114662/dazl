// Continuous monitoring: a saved search that re-runs on a cadence; each finished run is folded into the tenant's event
// state (lib/monitor-events.ts, #387) and only novel, dated, in-window, verified events alert. Monitor runs are real scans:
// they go through the same pipeline and verifier, and they count toward the monthly scan quota.
// Caps keep a free account from burning its quota in its sleep: free plans get 2 monitors running
// at most weekly; pro gets 10 running at most daily.
// On the Db layer (SQLite or Postgres); migrateMonitors is the SQLite schema setup.
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from './db/client.ts'
import { readPlan, readScanQuota } from './plans.ts'
import { countActiveJobs, queryJobStep } from './scan/store-db.ts'
import { scheduledPlayOffer } from './scan/play-offer.ts'
import type { Fence } from './watch.ts'
import { ENRICH_STALE_S } from './scan/enrichment.ts'
import { jobWindowDays } from './scan/window.ts'
import { DEFAULT_EVENT_WINDOW_DAYS, foldRunEvents, migrateMonitorEvents, missedRuns, type AlertPolicy, type RunLead } from './monitor-events.ts'

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
  // static admin statements only (lib/db/sql-audit.ts keeps a module off the raw-SQLite list only when they are)
  const has = (rows: unknown[], c: string) => (rows as { name: string }[]).some(r => r.name === c)
  // the selected alert policy (lib/monitor-events.ts ALERT_POLICIES); every existing monitor alerts on all three kinds
  if (!has(db.prepare('PRAGMA table_info(monitors)').all(), 'alert_policy')) db.exec("ALTER TABLE monitors ADD COLUMN alert_policy TEXT NOT NULL DEFAULT 'all' CHECK (alert_policy IN ('all','reachable','new_companies'))")
  // how many scheduled runs this (late) run stands in for: missed-run recovery is reported, never replayed as extra scans
  if (!has(db.prepare('PRAGMA table_info(monitor_runs)').all(), 'missed_runs')) db.exec('ALTER TABLE monitor_runs ADD COLUMN missed_runs INTEGER NOT NULL DEFAULT 0')
  migrateMonitorEvents(db)
}

// The play's own window ("in the past 30 days") else the default: events older than it are old news, never alerted.
export const monitorWindowDays = (m: { query: string | null; icp: string | null }): number => jobWindowDays(m) ?? DEFAULT_EVENT_WINDOW_DAYS

const nowS = () => Math.floor(Date.now() / 1000)
const noFence: Fence = function* () { /* not fenced */ }

export type MonitorError = 'limit' | 'interval'
export async function createMonitor(db: Db, userId: string, input: { query: string; icp?: string | null; sources?: string | null; intervalHours?: number; alertPolicy?: AlertPolicy }, now = nowS()): Promise<{ id: string } | { error: MonitorError; limit?: number; min?: number }> {
  const plan = await readPlan(db, userId)
  const lim = MONITOR_LIMITS[plan]
  if (input.intervalHours !== undefined && input.intervalHours < lim.minIntervalHours) return { error: 'interval', min: lim.minIntervalHours }
  const n = Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM monitors WHERE user_id = ?', [userId]))!.n)
  if (n >= lim.maxMonitors) return { error: 'limit', limit: lim.maxMonitors }
  const interval = Math.max(lim.minIntervalHours, Math.floor(input.intervalHours ?? lim.minIntervalHours))
  const id = randomBytes(12).toString('hex')
  await db.run('INSERT INTO monitors (id, user_id, query, icp, sources, interval_hours, next_run_at, created_at, alert_policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, userId, input.query, input.icp ?? null, input.sources ?? null, interval, now, now, input.alertPolicy ?? 'all'])
  return { id }
}

export function listMonitors(db: Db, userId: string) {
  return db.all(
    `SELECT m.id, m.query, m.icp, m.interval_hours, m.alert_policy, m.enabled, m.paused_reason, m.last_run_at, m.next_run_at, m.created_at,
       (SELECT new_count FROM monitor_runs r WHERE r.monitor_id = m.id ORDER BY r.ran_at DESC LIMIT 1) AS last_new_count,
       (SELECT job_id FROM monitor_runs r WHERE r.monitor_id = m.id ORDER BY r.ran_at DESC LIMIT 1) AS last_job_id,
       (SELECT count(*) FROM monitor_runs r WHERE r.monitor_id = m.id) AS run_count
     FROM monitors m WHERE m.user_id = ? ORDER BY m.created_at DESC, m.id DESC`, [userId])
}

// true when this tenant's monitor was in the other state and is now `enabled`; false when it is missing or already
// there. The decision is made in the statement itself, so two interleaved toggles cannot both see "unchanged" or both
// see "changed" for one flip: the caller that changed the row is the one that records it.
export async function setMonitorEnabled(db: Db, userId: string, id: string, enabled: boolean): Promise<boolean> {
  return (await db.run('UPDATE monitors SET enabled = ?, paused_reason = CASE WHEN ? = 1 THEN NULL ELSE paused_reason END WHERE id = ? AND user_id = ? AND enabled <> ?', [enabled ? 1 : 0, enabled ? 1 : 0, id, userId, enabled ? 1 : 0])).changes === 1
}

export async function deleteMonitor(db: Db, userId: string, id: string): Promise<boolean> {
  return (await db.run('DELETE FROM monitors WHERE id = ? AND user_id = ?', [id, userId])).changes === 1
}

// Runs every due monitor as a normal scan. A monitor whose owner is out of monthly quota pauses
// itself (reason 'quota') instead of failing scans; re-enabling clears the reason. A monitor that is late (the tick did
// not run, or the user's own scans held it) runs ONCE and records how many scheduled runs it stands in for: no catch-up
// burst of paid scans, and the one run still covers every event inside the play's window.
// Each monitor's writes are one transaction (fenced by the caller's lease, if any), and only while the monitor is still
// the due one this run read: the job, its run record and the next run commit together, or none does.
export async function runDueMonitors(db: Db, o: { now?: number; fence?: Fence } = {}): Promise<string[]> {
  const now = o.now ?? nowS(), fence = o.fence ?? noFence
  const due = await db.all<{ id: string; user_id: string; query: string; icp: string | null; sources: string | null; next_run_at: number; interval_hours: number }>(
    'SELECT id, user_id, query, icp, sources, next_run_at, interval_hours FROM monitors WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id', [now])
  const jobs: string[] = []
  for (const m of due) {
    if (!(await readScanQuota(db, m.user_id)).allowed) {
      await db.tx(function* (t) { yield* fence(t); yield* t.run("UPDATE monitors SET enabled = 0, paused_reason = 'quota' WHERE id = ? AND enabled = 1 AND next_run_at = ?", [m.id, m.next_run_at]) })
      continue
    }
    if (await countActiveJobs(db, m.user_id) >= 2) continue // user's own scans win; try again next tick
    // the offer already confirmed for this play's request (#349), with the snapshot it was confirmed beside; else the
    // profile snapshot as it is now (#687), as a manual run records
    const play = await scheduledPlayOffer(db, m.user_id, m.query)
    const jobId = await db.tx(function* (t: Tx): TxBody<string | null> {
      yield* fence(t)
      const r = yield* t.run('UPDATE monitors SET last_run_at = ?, next_run_at = ? + interval_hours * 3600 WHERE id = ? AND enabled = 1 AND next_run_at = ?', [now, now, m.id, m.next_run_at])
      if (r.changes !== 1) return null
      const job = yield* queryJobStep(t, m.user_id, { query: m.query, icp: m.icp, sources: m.sources, offer: play.offer, seller: play.seller ?? undefined }, now)
      yield* t.run('INSERT INTO monitor_runs (id, monitor_id, job_id, ran_at, missed_runs) VALUES (?, ?, ?, ?, ?)', [randomBytes(12).toString('hex'), m.id, job, now, missedRuns(Number(m.next_run_at), now, Number(m.interval_hours))])
      return job
    })
    if (jobId) jobs.push(jobId)
  }
  return jobs
}

// Folds finished runs into the tenant's event state (lib/monitor-events.ts) and sets the run's new_count to the alerts
// it raised: novel, dated, in-window, verified events under the monitor's policy. A review-lane, blocked, held or
// quarantined lead, an undated one, old news and an event another play already surfaced never count. monitor_seen still
// records every company key the monitor returned (company-level history). A done run waits while its enrichment is
// still running (up to ENRICH_STALE_S), so a contact the scan is about to confirm is read as reachable the first time.
// Each run is folded in one transaction (fenced by the caller's lease, if any), at most once.
export async function collectMonitorResults(db: Db, o: { fence?: Fence; now?: number } = {}): Promise<number> {
  const fence = o.fence ?? noFence, now = o.now ?? nowS()
  const runs = await db.all<{ id: string; monitor_id: string; job_id: string; user_id: string; query: string; icp: string | null; alert_policy: AlertPolicy }>(
    `SELECT r.id, r.monitor_id, r.job_id, m.user_id, m.query, m.icp, m.alert_policy FROM monitor_runs r JOIN scan_jobs j ON j.id = r.job_id JOIN monitors m ON m.id = r.monitor_id
     WHERE r.processed = 0 AND (j.status = 'failed' OR (j.status = 'done' AND (j.enrich_finished_at IS NOT NULL OR COALESCE(j.enrich_started_at, j.finished_at, 0) <= ?)))
     ORDER BY r.ran_at, r.id`, [now - ENRICH_STALE_S])
  let alerts = 0
  for (const r of runs) {
    const fresh = await db.tx(function* (t: Tx): TxBody<number | null> {
      yield* fence(t)
      const claim = yield* t.run('UPDATE monitor_runs SET processed = 1 WHERE id = ? AND processed = 0', [r.id])
      if (claim.changes !== 1) return null
      const keys = yield* t.all<{ dedup_key: string }>('SELECT dedup_key FROM leads WHERE scan_job_id = ? AND dedup_key IS NOT NULL', [r.job_id])
      for (const { dedup_key } of keys) yield* t.run('INSERT INTO monitor_seen (monitor_id, dedup_key) VALUES (?, ?) ON CONFLICT (monitor_id, dedup_key) DO NOTHING', [r.monitor_id, dedup_key])
      // held: the scan:gate marker (a required gate failed and its review write was rejected), read the same way as every
      // user-facing lead read (scan/store-db.ts); reachable: the scan's own end-to-end actionability verdict for this tenant
      const leads = (yield* t.all<Omit<RunLead, 'held' | 'reachable'> & { held: number; reachable: number }>(
        `SELECT l.company, l.company_domain, l.event_date, l.date_status, l.signal_kind, l.source_url, l.review_reason, l.confidence, l.quarantined_at,
           CASE WHEN EXISTS (SELECT 1 FROM lead_enrichments h WHERE h.lead_id = l.id AND h.connector = 'scan:gate' AND h.kind = 'gate_failed') THEN 1 ELSE 0 END AS held,
           CASE WHEN EXISTS (SELECT 1 FROM lead_enrichments a WHERE a.lead_id = l.id AND a.tenant_id = ? AND a.connector = 'scan:actionable' AND a.kind = 'actionability' AND a.value LIKE 'Actionable:%') THEN 1 ELSE 0 END AS reachable
         FROM leads l WHERE l.scan_job_id = ? ORDER BY l.score DESC, l.id`, [r.user_id, r.job_id]))
        .map(l => ({ ...l, confidence: l.confidence == null ? null : Number(l.confidence), quarantined_at: l.quarantined_at == null ? null : Number(l.quarantined_at), held: Number(l.held) === 1, reachable: Number(l.reachable) === 1 }))
      const { alerts } = yield* foldRunEvents(t, { userId: r.user_id, monitorId: r.monitor_id, runId: r.id, leads, policy: r.alert_policy, windowDays: monitorWindowDays(r), now })
      const n = alerts.length
      yield* t.run('UPDATE monitor_runs SET new_count = ? WHERE id = ?', [n, r.id])
      // Monitor jobs reuse the query pipeline; stamp the producing channel now that the run is recorded.
      yield* t.run("UPDATE leads SET source_kind = 'monitor' WHERE scan_job_id = ?", [r.job_id])
      return n
    })
    if (fresh) alerts++
  }
  return alerts
}
