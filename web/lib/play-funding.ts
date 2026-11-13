// #1042: who pays for a saved play's run, and the one admission rule every path that queues a play run shares.
//
// Admission (scan_admit lock): the scheduler (lib/watch.ts runDueWatches, lib/monitors.ts runDueMonitors) and "Find
// leads now" (lib/play-now.ts) each re-check the account's active scans INSIDE the transaction that creates the job,
// after taking this per-tenant lock on Postgres (SQLite's transaction is synchronous from BEGIN to COMMIT). So a click
// and a tick, or two instances' ticks, are ordered: the second one sees the first one's job.
//
// Funding. A play run is funded by the account's own AI key, as before. The ONE exception is the repeat dazl creates
// for a new account's first play (lib/play-repeat.ts): with no key of its own, its runs may draw on the free trial
// (owner scope, Gagan via Quest 2026-11-11 11:48, made daily by the 2026-11-12 decision in lib/play-cadence.ts: the
// first play repeats automatically under the EXISTING trial caps). They are admitted by the existing trial admission, unchanged (lib/billing/trial-budget.ts
// admitTrialScan: off unless the trial is configured, a Google sign-in, one trial per company domain, 3 scans per
// account in total, the per-account total and the global daily ceiling), and the runner then holds each one to the
// per-scan reserve, as it does every trial scan. Nothing here changes a cap; a run the caps refuse does not happen.
import { randomBytes } from 'node:crypto'
import type { Db, Tx, TxBody } from './db/client.ts'
import { admitTrialScan, linkTrialReservation, releaseTrialReservation, trialFundable, trialPrincipal, type TrialRefusal } from './billing/trial-budget.ts'
import { ipHash } from './scan/trial.ts'
import { captureError } from './ops/errors.ts'

export function* lockScanAdmission(t: Tx, userId: string): TxBody<void> {
  if (t.kind === 'pg') yield* t.get("SELECT pg_advisory_xact_lock(hashtextextended('scan_admit:' || ?, 0)) AS x", [userId])
}

// The repeat of the account's first play: a watch that one of the account's jobs ran BEFORE the watch existed (the
// first play's own job, which lib/play-repeat.ts links to the repeat it creates). A watch made with "Watch this weekly"
// never has a job older than itself.
const FIRST_PLAY_REPEAT_SQL = `SELECT 1 AS x FROM watches w WHERE w.id = ? AND w.user_id = ?
  AND EXISTS (SELECT 1 FROM scan_jobs j WHERE j.watch_id = w.id AND j.user_id = w.user_id AND j.created_at < w.created_at)`
export async function isFirstPlayRepeat(db: Db, userId: string, watchId: string): Promise<boolean> {
  return !!(await db.get(FIRST_PLAY_REPEAT_SQL, [watchId, userId]))
}
export function* isFirstPlayRepeatStep(t: Tx, userId: string, watchId: string): TxBody<boolean> {
  return !!(yield* t.get(FIRST_PLAY_REPEAT_SQL, [watchId, userId]))
}

export type Principal = { id: string; email: string }
// The account whose free trial would fund this keyless play's run, or null (no trial run: the caller pauses or refuses
// exactly as for any keyless play). Read only; nothing is reserved here.
export async function trialFunder(db: Db, userId: string, watchId: string, env: Record<string, string | undefined> = process.env): Promise<Principal | null> {
  if (!trialFundable(env as NodeJS.ProcessEnv)) return null
  if (!(await isFirstPlayRepeat(db, userId, watchId))) return null
  // only the founder of a personal workspace has a trial (lib/billing/trial-budget.ts trialPrincipal); the scheduler acts
  // for the account, so actor = tenant
  return trialPrincipal(db, { tenantId: userId, actorId: userId })
}

export type TrialRun = { reservation: string; jobId: string }
export type TrialAdmission = { ok: true; run: TrialRun } | { ok: false; reason: TrialRefusal }
// Reserves one trial scan through the existing admission and fixes the job id it is linked to BEFORE the job exists
// (as POST /api/scan does), so the reservation is never counted against a scan that cannot be found.
export async function admitTrialRun(db: Db, principal: Principal, now: number, env: Record<string, string | undefined> = process.env): Promise<TrialAdmission> {
  const a = await admitTrialScan(db, principal, { now, env })
  if (!a.ok) return a
  const jobId = randomBytes(12).toString('hex')
  try { await linkTrialReservation(db, principal.id, a.reservation, jobId) } catch (e) { await releaseTrialRun(db, principal.id, { reservation: a.reservation, jobId }); throw e }
  return { ok: true, run: { reservation: a.reservation, jobId } }
}

// Inside the job's transaction, right after the job row: the funding mark and the trial counter row, as POST /api/scan
// writes them (recordTrialScan). A scheduled run has no visitor IP: one fixed hash, so it never counts against a real
// network's daily throttle.
export const SCHEDULED_IP_HASH = ipHash('scheduled-play-run')
export function* markTrialJobStep(t: Tx, userId: string, jobId: string): TxBody<void> {
  yield* t.run("UPDATE scan_jobs SET funded_by = 'trial' WHERE id = ? AND user_id = ?", [jobId, userId])
  yield* t.run('INSERT INTO trial_scans (tenant_id, job_id, ip_hash) VALUES (?, ?, ?)', [userId, jobId, SCHEDULED_IP_HASH])
}

// The run did not happen (refused inside the transaction, or the transaction threw): the attempt and reserve go back,
// only if the job really does not exist (releaseTrialReservation checks). A failed release keeps the full reserve on
// the account (never less than it could spend) and is recorded.
export async function releaseTrialRun(db: Db, userId: string, run: TrialRun): Promise<void> {
  try { await releaseTrialReservation(db, userId, run.reservation, run.jobId) }
  catch (e) { captureError(e, { source: 'worker', where: 'play-funding:release', tenantId: userId }) }
}

// What a refused trial admission does to the scheduled play: pause it with a reason the Plays page explains, or (the
// global daily ceiling, which frees up tomorrow) leave it due so a later tick runs it.
export function trialPauseReason(r: TrialRefusal): 'trial_used' | 'no_api_key' | null {
  if (r === 'global_daily_cap') return null
  if (r === 'attempts_cap' || r === 'account_total_cap') return 'trial_used'
  return 'no_api_key'
}
