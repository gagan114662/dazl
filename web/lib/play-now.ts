// #1042: a saved play's "Find leads now" and its "what's new since you last checked" list.
//
// Find leads now PULLS THE NEXT SCHEDULED RUN FORWARD; it never adds a run on top of the schedule. The run is the same
// job the scheduler would queue for that play (lib/watch.ts runDueWatches, lib/monitors.ts runDueMonitors): the same
// request, profile, confirmed offer (#349), per-run budget (watches) and run record, and the play's next run moves to
// now + its interval. Admission is the scheduled run's rules, made stricter so a click can never spend more than the
// schedule would have:
//   - the play is this tenant's and is live (a paused play never runs: resume it first);
//   - it is funded the way the scheduled run is (lib/play-funding.ts): the account's OWN AI key; or, only for the
//     automatic repeat of a new account's first play with no key, the free trial through its existing admission and
//     caps (unchanged; a refused admission is a refusal here, never a run on anything else);
//   - the monthly scan quota allows one more scan;
//   - no other scan of the tenant is queued, running or finishing (the one-at-a-time rule of POST /api/scan);
//   - not within RUN_NOW_MIN_GAP_S of the play's last run (no click-spamming the quota or the trial).
// Key, quota and the active-scan count are read first (a fast refusal that reserves nothing); the active-scan check and
// the schedule move are repeated inside the one write transaction that creates the job, under the per-tenant admission
// lock the scheduler takes too (lib/play-funding.ts lockScanAdmission), compare-and-set on the play's next_run_at, so
// a click and a scheduler tick (or two clicks) that race create ONE job. A refusal writes nothing and pauses nothing
// (unlike the scheduler, which pauses a keyless or out-of-quota play); a trial reservation made for a run that then
// did not happen is released.
//
// The "new" list uses the same definition as each run's "new" count on the Plays page (lib/play-runs.ts): a weekly
// watch's leads first seen by that watch (leads.watch_new, visible as the Leads list shows them), and a monitor's
// alerts (#387: novel, dated, in-window, verified events). Read-only, tenant-scoped, no network and no paid call.
import { randomBytes } from 'node:crypto'
import type { Db, Tx, TxBody } from './db/client.ts'
import { countActiveJobs, countActiveJobsStep, queryJobStep } from './scan/store-db.ts'
import { readHasKey } from './llm/key-store.ts'
import { readScanQuota } from './plans.ts'
import { scheduledPlayOffer } from './scan/play-offer.ts'
import { admitTrialRun, lockScanAdmission, markTrialJobStep, releaseTrialRun, trialFunder, type TrialRun } from './play-funding.ts'
import { VISIBLE_LEAD } from './play-mail.ts'
import type { PlayKind } from './play-runs.ts'

export const RUN_NOW_MIN_GAP_S = 3600
const WEEK_S = 7 * 86400 // a watch's cadence (lib/watch.ts)
const nowS = () => Math.floor(Date.now() / 1000)

export type RunNowRefusal = 'not_found' | 'paused' | 'no_api_key' | 'quota_exceeded' | 'scan_active' | 'too_soon' | 'trial_used' | 'trial_busy'
export type RunNowResult = { job_id: string; next_run_at: number; funded_by: 'user' | 'trial' } | { error: RunNowRefusal; retry_at?: number }

interface PlayRow { query: string; icp: string | null; sources: string | null; run_budget: string | null; on: number; last_run_at: number | null; next_run_at: number | null; interval_s: number }
const WATCH_SQL = 'SELECT query, icp, NULL AS sources, run_budget, active AS "on", last_run_at, next_run_at, 604800 AS interval_s FROM watches WHERE id = ? AND user_id = ?'
const MONITOR_SQL = 'SELECT query, icp, sources, NULL AS run_budget, enabled AS "on", last_run_at, next_run_at, interval_hours * 3600 AS interval_s FROM monitors WHERE id = ? AND user_id = ?'
const readPlay = async (db: Db, userId: string, kind: PlayKind, id: string): Promise<PlayRow | undefined> => {
  const r = await db.get<PlayRow>(kind === 'watch' ? WATCH_SQL : MONITOR_SQL, [id, userId])
  return r && { ...r, on: Number(r.on), last_run_at: r.last_run_at == null ? null : Number(r.last_run_at), next_run_at: r.next_run_at == null ? null : Number(r.next_run_at), interval_s: Number(r.interval_s) }
}

export async function runPlayNow(db: Db, userId: string, kind: PlayKind, id: string, now = nowS(), env: Record<string, string | undefined> = process.env): Promise<RunNowResult> {
  if (kind !== 'watch' && kind !== 'monitor') return { error: 'not_found' }
  const p = await readPlay(db, userId, kind, id)
  if (!p) return { error: 'not_found' }
  if (p.on !== 1 || p.next_run_at === null) return { error: 'paused' }
  if (p.last_run_at !== null && p.last_run_at > now - RUN_NOW_MIN_GAP_S) return { error: 'too_soon', retry_at: p.last_run_at + RUN_NOW_MIN_GAP_S }
  const keyed = await readHasKey(db, userId)
  const funder = keyed || kind !== 'watch' ? null : await trialFunder(db, userId, id, env)
  if (!keyed && !funder) return { error: 'no_api_key' }
  if (!(await readScanQuota(db, userId)).allowed) return { error: 'quota_exceeded' }
  if (await countActiveJobs(db, userId, now) >= 1) return { error: 'scan_active' } // before any trial reservation
  let trial: TrialRun | null = null
  if (funder) {
    const a = await admitTrialRun(db, funder, now, env)
    if (!a.ok) return { error: a.reason === 'global_daily_cap' ? 'trial_busy' : a.reason === 'attempts_cap' || a.reason === 'account_total_cap' ? 'trial_used' : 'no_api_key' }
    trial = a.run
  }
  // the offer already confirmed for this play's request (#349), as the scheduled run reads it
  const play = await scheduledPlayOffer(db, userId, p.query)
  const offer = play ? { offer: play.offer, seller: play.seller ?? undefined } : {}
  const next = now + (kind === 'watch' ? WEEK_S : p.interval_s)
  const read = p.next_run_at
  let out: RunNowResult = { error: 'scan_active' }
  try {
    out = await db.tx(function* (t: Tx): TxBody<RunNowResult> {
      yield* lockScanAdmission(t, userId)
      if ((yield* countActiveJobsStep(t, userId, now)) >= 1) return { error: 'scan_active' }
      if (kind === 'watch') {
        const r = yield* t.run('UPDATE watches SET last_run_at = ?, next_run_at = ? WHERE id = ? AND user_id = ? AND active = 1 AND next_run_at = ?', [now, next, id, userId, read])
        if (r.changes !== 1) return { error: 'scan_active' } // the tick (or another click) ran it in between: that run is the one
        const job = yield* queryJobStep(t, userId, { id: trial?.jobId, query: p.query, icp: p.icp, watchId: id, runBudget: p.run_budget, ...offer }, now)
        if (trial) yield* markTrialJobStep(t, userId, job)
        return { job_id: job, next_run_at: next, funded_by: trial ? 'trial' : 'user' }
      }
      const r = yield* t.run('UPDATE monitors SET last_run_at = ?, next_run_at = ? WHERE id = ? AND user_id = ? AND enabled = 1 AND next_run_at = ?', [now, next, id, userId, read])
      if (r.changes !== 1) return { error: 'scan_active' }
      const job = yield* queryJobStep(t, userId, { query: p.query, icp: p.icp, sources: p.sources, ...offer }, now)
      // missed_runs 0: a run the user asked for stands in for no scheduled run
      yield* t.run('INSERT INTO monitor_runs (id, monitor_id, job_id, ran_at, missed_runs) VALUES (?, ?, ?, ?, 0)', [randomBytes(12).toString('hex'), id, job, now])
      return { job_id: job, next_run_at: next, funded_by: 'user' }
    })
  } finally {
    if (trial && !('job_id' in out)) await releaseTrialRun(db, userId, trial) // refused or threw: the attempt goes back
  }
  return out
}

// What a play found since the given instant (unix seconds; 0 = ever). An item's time is when it became visible: a
// weekly play's run finishing (scan_jobs.finished_at), a monitor's alert being raised (monitor_alerts.at), so a run that
// started earlier but finished later is never older than a marker set before it finished.
// One statement: the page (oldest first, at most NEW_LIMIT), the total and the newest time come from the same snapshot.
// seen_through is what "Mark as seen" may store: the newest time up to which EVERY item is in this page. When the page
// is cut at NEW_LIMIT it stops before the time group that was cut, so leads that were never shown are never marked seen
// (null when even the first time group did not fit: then nothing can be marked and the page says to open Leads). It is
// also kept below the current second, so an item that becomes visible in the same second is shown again, never lost.
// items come back newest first (a stable sort: within one time, best first), for display. A finished run with no
// finished_at recorded (older rows) counts from when it started.
export const NEW_LIMIT = 50
export interface NewItem { job_id: string; at: number; company: string; what: string }
export interface PlayNew { since: number; total: number; latest_at: number | null; seen_through: number | null; truncated: boolean; items: NewItem[] }

const WATCH_NEW_SQL = `SELECT j.id AS job_id, COALESCE(j.finished_at, j.created_at) AS at, l.company, l.signal AS what, count(*) OVER () AS total, max(COALESCE(j.finished_at, j.created_at)) OVER () AS latest
  FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
  WHERE j.watch_id = ? AND j.user_id = ? AND j.status = 'done' AND l.watch_new = 1 AND ${VISIBLE_LEAD} AND COALESCE(j.finished_at, j.created_at) > ?
  ORDER BY COALESCE(j.finished_at, j.created_at), j.insert_seq, l.score DESC, l.id LIMIT ?`
const MONITOR_NEW_SQL = `SELECT r.job_id, a.at AS at, a.company, a.kind AS what, count(*) OVER () AS total, max(a.at) OVER () AS latest
  FROM monitor_alerts a JOIN monitor_runs r ON r.id = a.run_id AND r.monitor_id = a.monitor_id
  WHERE a.monitor_id = ? AND a.user_id = ? AND a.at > ?
  ORDER BY a.at, r.ran_at, r.id, a.id LIMIT ?`
const ALERT_WHAT: Record<string, string> = { new_company: 'New company with a dated signal', new_signal: 'New signal for a company you already have', now_reachable: 'Now reachable: contact route confirmed' }

// ats: the page's item times, oldest first.
export function seenThrough(ats: number[], truncated: boolean, now: number): number | null {
  if (ats.length === 0) return null
  const last = ats[ats.length - 1]
  const through = truncated ? ats.filter(a => a < last).reduce<number | null>((m, a) => m === null || a > m ? a : m, null) : last
  if (through === null || through <= 0) return null
  return Math.min(through, now - 1)
}

export async function playNew(db: Db, userId: string, kind: PlayKind, id: string, since: number, now = nowS()): Promise<PlayNew | null> {
  if (kind !== 'watch' && kind !== 'monitor') return null
  if (!Number.isSafeInteger(since) || since < 0) return null
  const owner = await db.get(kind === 'watch' ? 'SELECT 1 AS x FROM watches WHERE id = ? AND user_id = ?' : 'SELECT 1 AS x FROM monitors WHERE id = ? AND user_id = ?', [id, userId])
  if (!owner) return null
  type Row = NewItem & { total: number; latest: number | null }
  const rows = await db.all<Row>(kind === 'watch' ? WATCH_NEW_SQL : MONITOR_NEW_SQL, [id, userId, since, NEW_LIMIT])
  const total = rows.length ? Number(rows[0].total) : 0
  const latest = rows.length && rows[0].latest != null ? Number(rows[0].latest) : null
  const items = rows.map(r => ({ job_id: r.job_id, at: Number(r.at), company: String(r.company ?? ''), what: kind === 'monitor' ? ALERT_WHAT[String(r.what)] ?? 'New alert' : String(r.what ?? '') }))
  const truncated = total > items.length
  return { since, total, latest_at: latest, seen_through: seenThrough(items.map(i => i.at), truncated, now), truncated, items: items.slice().sort((a, b) => b.at - a.at) }
}
