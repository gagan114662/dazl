// #1042: a saved play's "Find leads now" and its "what's new since you last checked" list.
//
// Find leads now PULLS THE NEXT SCHEDULED RUN FORWARD; it never adds a run on top of the schedule. The run is the same
// job the scheduler would queue for that play (lib/watch.ts runDueWatches, lib/monitors.ts runDueMonitors): the same
// request, profile, confirmed offer (#349), per-run budget (watches) and run record, and the play's next run moves to
// now + its interval. Admission is the scheduled run's rules, made stricter so a click can never spend more than the
// schedule would have:
//   - the play is this tenant's and is live (a paused play never runs: resume it first);
//   - the tenant's OWN AI key funds it (never the shared trial key: the runner only claims keyed or trial-marked jobs,
//     and this job is never trial-marked), and the monthly scan quota allows one more scan;
//   - no other scan of the tenant is queued, running or finishing (the one-at-a-time rule of POST /api/scan);
//   - not within RUN_NOW_MIN_GAP_S of the play's last run (no click-spamming the quota).
// Quota and key are read first (a fast refusal); the active-scan check and the schedule move are repeated inside the one
// write transaction that creates the job, compare-and-set on the play's next_run_at, so a click and a scheduler tick
// (or two clicks) that race create ONE job. On Postgres a per-tenant advisory lock orders concurrent admissions.
// A refusal writes nothing and pauses nothing (unlike the scheduler, which pauses a keyless or out-of-quota play).
//
// The "new" list uses the same definition as each run's "new" count on the Plays page (lib/play-runs.ts): a weekly
// watch's leads first seen by that watch (leads.watch_new), and a monitor's alerts (#387: novel, dated, in-window,
// verified events). Read-only, tenant-scoped, no network and no paid call.
import { randomBytes } from 'node:crypto'
import type { Db, Tx, TxBody } from './db/client.ts'
import { countActiveJobsStep, queryJobStep } from './scan/store-db.ts'
import { readHasKey } from './llm/key-store.ts'
import { readScanQuota } from './plans.ts'
import { scheduledPlayOffer } from './scan/play-offer.ts'
import type { PlayKind } from './play-runs.ts'

export const RUN_NOW_MIN_GAP_S = 3600
const WEEK_S = 7 * 86400 // a watch's cadence (lib/watch.ts)
const nowS = () => Math.floor(Date.now() / 1000)

export type RunNowRefusal = 'not_found' | 'paused' | 'no_api_key' | 'quota_exceeded' | 'scan_active' | 'too_soon'
export type RunNowResult = { job_id: string; next_run_at: number } | { error: RunNowRefusal; retry_at?: number }

interface PlayRow { query: string; icp: string | null; sources: string | null; run_budget: string | null; on: number; last_run_at: number | null; next_run_at: number | null; interval_s: number }
const WATCH_SQL = 'SELECT query, icp, NULL AS sources, run_budget, active AS "on", last_run_at, next_run_at, 604800 AS interval_s FROM watches WHERE id = ? AND user_id = ?'
const MONITOR_SQL = 'SELECT query, icp, sources, NULL AS run_budget, enabled AS "on", last_run_at, next_run_at, interval_hours * 3600 AS interval_s FROM monitors WHERE id = ? AND user_id = ?'
const readPlay = async (db: Db, userId: string, kind: PlayKind, id: string): Promise<PlayRow | undefined> => {
  const r = await db.get<PlayRow>(kind === 'watch' ? WATCH_SQL : MONITOR_SQL, [id, userId])
  return r && { ...r, on: Number(r.on), last_run_at: r.last_run_at == null ? null : Number(r.last_run_at), next_run_at: r.next_run_at == null ? null : Number(r.next_run_at), interval_s: Number(r.interval_s) }
}

export async function runPlayNow(db: Db, userId: string, kind: PlayKind, id: string, now = nowS()): Promise<RunNowResult> {
  if (kind !== 'watch' && kind !== 'monitor') return { error: 'not_found' }
  const p = await readPlay(db, userId, kind, id)
  if (!p) return { error: 'not_found' }
  if (p.on !== 1 || p.next_run_at === null) return { error: 'paused' }
  if (p.last_run_at !== null && p.last_run_at > now - RUN_NOW_MIN_GAP_S) return { error: 'too_soon', retry_at: p.last_run_at + RUN_NOW_MIN_GAP_S }
  if (!(await readHasKey(db, userId))) return { error: 'no_api_key' }
  if (!(await readScanQuota(db, userId)).allowed) return { error: 'quota_exceeded' }
  // the offer already confirmed for this play's request (#349), as the scheduled run reads it
  const play = await scheduledPlayOffer(db, userId, p.query)
  const offer = play ? { offer: play.offer, seller: play.seller ?? undefined } : {}
  const next = now + (kind === 'watch' ? WEEK_S : p.interval_s)
  const read = p.next_run_at
  return db.tx(function* (t: Tx): TxBody<RunNowResult> {
    if (t.kind === 'pg') yield* t.get("SELECT pg_advisory_xact_lock(hashtextextended('play_run_now:' || ?, 0)) AS x", [userId])
    if ((yield* countActiveJobsStep(t, userId, now)) >= 1) return { error: 'scan_active' }
    if (kind === 'watch') {
      const r = yield* t.run('UPDATE watches SET last_run_at = ?, next_run_at = ? WHERE id = ? AND user_id = ? AND active = 1 AND next_run_at = ?', [now, next, id, userId, read])
      if (r.changes !== 1) return { error: 'scan_active' } // the tick (or another click) ran it in between: that run is the one
      const job = yield* queryJobStep(t, userId, { query: p.query, icp: p.icp, watchId: id, runBudget: p.run_budget, ...offer }, now)
      return { job_id: job, next_run_at: next }
    }
    const r = yield* t.run('UPDATE monitors SET last_run_at = ?, next_run_at = ? WHERE id = ? AND user_id = ? AND enabled = 1 AND next_run_at = ?', [now, next, id, userId, read])
    if (r.changes !== 1) return { error: 'scan_active' }
    const job = yield* queryJobStep(t, userId, { query: p.query, icp: p.icp, sources: p.sources, ...offer }, now)
    // missed_runs 0: a run the user asked for stands in for no scheduled run
    yield* t.run('INSERT INTO monitor_runs (id, monitor_id, job_id, ran_at, missed_runs) VALUES (?, ?, ?, ?, 0)', [randomBytes(12).toString('hex'), id, job, now])
    return { job_id: job, next_run_at: next }
  })
}

// What a play found since the given instant (unix seconds; 0 = ever): the new items of its finished runs that started
// after it, newest run first, at most NEW_LIMIT, the total, and the newest such run's time (what "Mark as seen" stores).
export const NEW_LIMIT = 50
export interface NewItem { job_id: string; at: number; company: string; what: string }
export interface PlayNew { since: number; total: number; latest_at: number | null; items: NewItem[] }

const WATCH_NEW_SQL = `SELECT j.id AS job_id, j.created_at AS at, l.company, l.signal AS what FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
  WHERE j.watch_id = ? AND j.user_id = ? AND j.status = 'done' AND l.watch_new = 1 AND j.created_at > ? ORDER BY j.created_at DESC, j.insert_seq DESC, l.score DESC, l.id LIMIT ?`
const WATCH_NEW_COUNT_SQL = `SELECT count(*) AS n, max(j.created_at) AS latest FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
  WHERE j.watch_id = ? AND j.user_id = ? AND j.status = 'done' AND l.watch_new = 1 AND j.created_at > ?`
const MONITOR_NEW_SQL = `SELECT r.job_id, r.ran_at AS at, a.company, a.kind AS what FROM monitor_alerts a JOIN monitor_runs r ON r.id = a.run_id AND r.monitor_id = a.monitor_id
  WHERE a.monitor_id = ? AND a.user_id = ? AND r.ran_at > ? ORDER BY r.ran_at DESC, r.id DESC, a.at DESC, a.id LIMIT ?`
const MONITOR_NEW_COUNT_SQL = `SELECT count(*) AS n, max(r.ran_at) AS latest FROM monitor_alerts a JOIN monitor_runs r ON r.id = a.run_id AND r.monitor_id = a.monitor_id
  WHERE a.monitor_id = ? AND a.user_id = ? AND r.ran_at > ?`
const ALERT_WHAT: Record<string, string> = { new_company: 'New company with a dated signal', new_signal: 'New signal for a company you already have', now_reachable: 'Now reachable: contact route confirmed' }

export async function playNew(db: Db, userId: string, kind: PlayKind, id: string, since: number): Promise<PlayNew | null> {
  if (kind !== 'watch' && kind !== 'monitor') return null
  if (!Number.isSafeInteger(since) || since < 0) return null
  const owner = await db.get(kind === 'watch' ? 'SELECT 1 AS x FROM watches WHERE id = ? AND user_id = ?' : 'SELECT 1 AS x FROM monitors WHERE id = ? AND user_id = ?', [id, userId])
  if (!owner) return null
  const [rows, c] = kind === 'watch'
    ? [await db.all<NewItem>(WATCH_NEW_SQL, [id, userId, since, NEW_LIMIT]), await db.get<{ n: number; latest: number | null }>(WATCH_NEW_COUNT_SQL, [id, userId, since])]
    : [await db.all<NewItem>(MONITOR_NEW_SQL, [id, userId, since, NEW_LIMIT]), await db.get<{ n: number; latest: number | null }>(MONITOR_NEW_COUNT_SQL, [id, userId, since])]
  const items = rows.map(r => ({ job_id: r.job_id, at: Number(r.at), company: String(r.company ?? ''), what: kind === 'monitor' ? ALERT_WHAT[r.what] ?? 'New alert' : String(r.what ?? '') }))
  return { since, total: Number(c?.n ?? 0), latest_at: c?.latest == null ? null : Number(c.latest), items }
}
