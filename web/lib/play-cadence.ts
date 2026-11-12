// #1042: how often a saved play repeats, and the free plan's daily cap on the first play's repeat.
//
// Owner decision (Hermes, delegated by Gagan, 2026-11-12, on #1042): "Daily, not weekly. The first play keeps finding new
// leads every day, on every plan including free, with a hard per-tenant cap: free plan 1 scan/day, at most $0.30, counted
// against the existing trial/spend caps; paid plans follow their quota. If the cap is hit, skip that day and say so on
// Home."
//
// How the code holds it:
//   - cadence: the repeat dazl creates for a new account's first play (lib/play-repeat.ts) runs every DAY_S; a watch made
//     by hand ("Watch this weekly") keeps WEEK_S. Which one a watch is comes from lib/play-funding.ts isFirstPlayRepeat
//     (its only job older than the watch), so no column or migration is needed.
//   - free plan, 1 scan a day: a scheduled run or a "Find leads now" of that repeat does not start when the account has
//     already started a scan this UTC day (any scan: a search in Leads, a play run, trial-funded or not; a genuine failure
//     gives its slot back, as the monthly count does, lib/plans.ts). It is checked inside the transaction that would create
//     the job, under the account's scan admission lock, so a click and a tick cannot both pass it.
//   - a skipped scheduled run moves to the same time on the next UTC day (never a burst of catch-up runs) and leaves one
//     audit event (action PLAY_SKIPPED) in the same transaction; Home and Plays read the latest one (skipNotice) and say
//     the run was skipped until the play runs again.
//   - at most $0.30: every free-plan run of the repeat carries run_budget.max_usd = FREE_RUN_MAX_USD (lower if the play
//     already had a lower one). The runner holds the run to it (lib/scan/runner.ts: a trial scan's reserve can only be
//     lowered by it). The existing trial caps (3 trial scans per account, $ per account, global daily) are unchanged and
//     still apply on top: a repeat with no key of its own stops when the free searches are used (paused 'trial_used').
//   - paid plans: no daily cap here; their monthly quota (lib/plans.ts readScanQuota) is the limit, as before.
import type { Db, Tx, TxBody } from './db/client.ts'
import { readPlan } from './plans.ts'
import { recordTx } from './audit.ts'

export const DAY_S = 86400
export const WEEK_S = 7 * DAY_S
export const FREE_DAILY_RUNS = 1
export const FREE_RUN_MAX_USD = 0.3
export const PLAY_SKIPPED = 'play.run_skipped'
export const SKIP_DAILY_CAP = 'free_daily_cap'

// How often a watch repeats: the first play's automatic repeat every day, any other watch every week.
export const watchIntervalS = (auto: boolean): number => auto ? DAY_S : WEEK_S

export const utcDayStart = (now: number): number => Math.floor(now / DAY_S) * DAY_S
// A skipped run's next time: the same time of day, on the first UTC day after `now`'s.
export function nextDayRun(due: number, now: number): number {
  const tomorrow = utcDayStart(now) + DAY_S
  return due >= tomorrow ? due : due + Math.ceil((tomorrow - due) / DAY_S) * DAY_S
}

// Scans the account started since the UTC day began. Same rule as the monthly count (lib/plans.ts SCANS_THIS_MONTH_SQL)
// except that trial-funded scans count too: every scan is a scan for the daily cap. Uses scan_jobs_user (user_id, created_at).
const SCANS_TODAY_SQL = "SELECT count(*) AS n FROM scan_jobs WHERE user_id = ? AND created_at >= ? AND (status != 'failed' OR error = 'cancelled')"
export function* scansTodayStep(t: Tx, userId: string, now: number): TxBody<number> {
  return Number((yield* t.get<{ n: number }>(SCANS_TODAY_SQL, [userId, utcDayStart(now)]))!.n)
}

// Whether the free plan's daily cap applies to this account's run of its first play's repeat. Paid plans: never.
export async function freeCapApplies(db: Db, userId: string, auto: boolean): Promise<boolean> {
  return auto && (await readPlan(db, userId)) === 'free'
}

// The run budget a capped run carries: the play's own controls, with max_usd at most FREE_RUN_MAX_USD. A stored budget
// that does not parse is replaced by the cap alone (stricter, never wider).
export function cappedRunBudget(stored: string | null | undefined): string {
  let o: Record<string, unknown> = {}
  if (typeof stored === 'string' && stored !== '') {
    try { const p = JSON.parse(stored) as unknown; if (p && typeof p === 'object' && !Array.isArray(p)) o = p as Record<string, unknown> } catch { /* replaced */ }
  }
  const had = typeof o.max_usd === 'number' && Number.isFinite(o.max_usd) && o.max_usd > 0 ? o.max_usd : Infinity
  return JSON.stringify({ ...o, max_usd: Math.min(had, FREE_RUN_MAX_USD) })
}

// Inside the scheduler's transaction (fenced, under the admission lock): move the due run to the next day and record why,
// only while the watch is still the due one this tick read. Returns whether it was skipped.
export function* skipWatchRunStep(t: Tx, w: { id: string; user_id: string; next_run_at: number }, now: number): TxBody<boolean> {
  const next = nextDayRun(Number(w.next_run_at), now)
  const r = yield* t.run('UPDATE watches SET next_run_at = ? WHERE id = ? AND user_id = ? AND active = 1 AND next_run_at = ?', [next, w.id, w.user_id, w.next_run_at])
  if (r.changes !== 1) return false
  yield* recordTx(t, { tenantId: w.user_id, actorId: 'scheduler', actorKind: 'service', action: PLAY_SKIPPED, resourceType: 'watch', resourceId: w.id, decision: 'denied',
    summary: { reason: SKIP_DAILY_CAP, due_at: Number(w.next_run_at), next_run_at: next, daily_runs: FREE_DAILY_RUNS } }, now)
  return true
}

// The skip a play's page should still mention: its latest skip, if the play has not run since (a run, scheduled or
// "Find leads now", sets last_run_at). Reads audit_events_tenant_at (tenant_id, at), bounded to the last two days.
export type SkipNotice = { at: number; reason: string; next_run_at: number | null }
export async function skipNotice(db: Db, userId: string, watch: { id: string; last_run_at: number | null }, now: number): Promise<SkipNotice | null> {
  const r = await db.get<{ at: number; summary: string }>(
    'SELECT at, summary FROM audit_events WHERE tenant_id = ? AND at >= ? AND action = ? AND resource_type = ? AND resource_id = ? ORDER BY at DESC, seq DESC LIMIT 1',
    [userId, now - 2 * DAY_S, PLAY_SKIPPED, 'watch', watch.id])
  if (!r) return null
  const at = Number(r.at)
  if (watch.last_run_at !== null && Number(watch.last_run_at) >= at) return null
  let s: Record<string, unknown> = {}
  try { s = JSON.parse(r.summary) as Record<string, unknown> } catch { /* reason unknown */ }
  return { at, reason: typeof s.reason === 'string' ? s.reason : SKIP_DAILY_CAP, next_run_at: typeof s.next_run_at === 'number' ? s.next_run_at : null }
}
