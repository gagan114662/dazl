// A trial scan finalized by a stale-job reaper (its worker died: failed accounting_uncertain / timeout, lib/scan/store*.ts, lib/queue/scan-claimer.ts,
// lib/scan/queue-runner.ts, lib/db/leads-read-pg.ts) never reaches the runner's last step, so its reservation was never settled: it kept a free scan
// forever and counted its full reserve toward every later day. This settles such reservations at the job's final attempt, keeping the scan's RECORDED
// spend (settled rows cost the job's one recorded cost, lib/scan/job-cost.ts via trial-budget.ts reservationCost; never less than recorded). Idempotent, portable SQL (epoch seconds are parameters). The synchronous-SQLite and raw-Postgres reapers run SETTLE_REAPED_TRIAL_SQL themselves (this module stays on the Db layer).
// Only scan reservations of jobs that are already terminal failures; a running, queued or done scan is untouched.
// A retry can inherit an older settlement, which does not settle the attempt the reaper just ended.
export const SETTLE_REAPED_TRIAL_SQL = `UPDATE trial_reservations
  SET settled_at = ?, settled_attempt = (SELECT j.attempts FROM scan_jobs j WHERE j.id = trial_reservations.job_id)
  WHERE kind = 'scan' AND EXISTS (
    SELECT 1 FROM scan_jobs j WHERE j.id = trial_reservations.job_id AND j.user_id = trial_reservations.tenant_id
      AND j.status = 'failed' AND j.error IN ('accounting_uncertain', 'timeout')
      AND (trial_reservations.settled_attempt IS NULL OR trial_reservations.settled_attempt < j.attempts
        OR (trial_reservations.settled_attempt = j.attempts AND trial_reservations.settled_at IS NULL))
  )`
// #1727/#1862: a scan that failed as accounting_uncertain with NO spend rows at all never started a paid step, so
// what its job row holds in the two reservation columns is the reserve alone, never recorded spend. The release
// is not limited to trial-funded scans: with no spend rows, nothing was spent whatever funded the scan, so a
// user-funded job that failed the same way is cleared too. Clearing it
// (same terminal jobs the settle above covers) makes the settled reservation count as what the scan recorded -
// $0 - in the trial ledger (reservationCost reads those columns), so the scan leaves the account, daily and
// per-account trial totals entirely, and the jobs read stops quoting the reserve as its cost. A job with any
// spend row is untouched: its recorded spend stays.
export const RELEASE_CREATION_RESERVE_SQL = `UPDATE scan_jobs SET spend_reserved_usd = 0, spend_cap_reserved_usd = 0
  WHERE status = 'failed' AND error = 'accounting_uncertain'
    AND NOT EXISTS (SELECT 1 FROM scan_spend_calls c WHERE c.scan_job_id = scan_jobs.id)
    AND (COALESCE(spend_reserved_usd, 0) > 0 OR COALESCE(spend_cap_reserved_usd, 0) > 0)`
type AsyncDb = { run(sql: string, p?: unknown[]): Promise<unknown> }
const nowS = () => Math.floor(Date.now() / 1000)
// #1932: a scan that failed as provider_rejected had a paid call REFUSED by the provider (an HTTP 4xx answer -
// credit balance too low, an invalid request): the provider ran nothing and billed nothing, but the refused
// call's hold settled 'kept' at its reserve, so the job showed ~$0.03 and the trial attempt stayed used. When
// every spend row on the job is the refused call itself, the job's columns hold only the refusal's reserve:
// clearing them makes the settled reservation count $0 in the trial ledger and gives the attempt back
// (trial-budget.ts releasedBeforeCost / trial.ts TRIAL_USED_SQL: a failed, non-cancelled scan whose
// spend_reserved_usd is 0). A row blocks the release if it carries money that is not the refusal's own:
// a 'settled' row with an actual cost above $0, a still-'reserved' row priced above $0 (its call's outcome
// never settled - it may yet be billed), or a SECOND money-carrying 'kept' row. 'kept' means the provider
// may have run and billed the call (a request sent, no answer read back); the refused call always records
// exactly one such row of its own, so any other kept row is an earlier call whose cost is unknown - wiping
// its reserve would wipe a possible charge (Ziggy's 0.1102 case: a kept $0.0847 call, then the refusal).
// A settled $0 free step recorded nothing, and a $0 reservation can only ever settle at $0, so neither
// blocks: a refused scan never charges. A lost or unanswered call takes the accounting_uncertain path
// instead, never this one. A job with any recorded spend is untouched: its charge and its attempt stay.
export const RELEASE_REFUSAL_RESERVE_SQL = `UPDATE scan_jobs SET spend_reserved_usd = 0, spend_cap_reserved_usd = 0
  WHERE status = 'failed' AND error = 'provider_rejected'
    AND NOT EXISTS (SELECT 1 FROM scan_spend_calls c WHERE c.scan_job_id = scan_jobs.id AND ((c.status = 'settled' AND COALESCE(c.actual_usd, 0) > 0) OR (c.status = 'reserved' AND COALESCE(c.reserve_usd, 0) > 0)))
    AND (SELECT COUNT(*) FROM scan_spend_calls c WHERE c.scan_job_id = scan_jobs.id AND c.status = 'kept' AND COALESCE(c.reserve_usd, 0) > 0) <= 1
    AND (COALESCE(spend_reserved_usd, 0) > 0 OR COALESCE(spend_cap_reserved_usd, 0) > 0)`
export async function settleReapedTrial(db: AsyncDb, now = nowS()): Promise<void> { try { await db.run(SETTLE_REAPED_TRIAL_SQL, [now]); await db.run(RELEASE_CREATION_RESERVE_SQL); await db.run(RELEASE_REFUSAL_RESERVE_SQL) } catch { /* a store without the trial table: nothing to settle */ } }
// Z2 (#1921): the same settle and releases, scoped to one job. A scan that died before the runner's finalizer
// (failed at creation, refused, or reaped after its worker died) can sit terminal with its trial reservation
// unsettled: the outcome copy would promise the free search back while the trial counter and the allowance
// still count it. The status read paths (status-read-service.ts, history-jobs.ts) settle the job they are
// about to describe, so the copy, the counter and the allowance all read the same settled state. Each
// statement keeps its own gates (terminal failure, the matching error, no recorded spend), so a job that
// does not qualify is untouched, and every statement is idempotent.
export const SETTLE_REAPED_TRIAL_FOR_JOB_SQL = `UPDATE trial_reservations
  SET settled_at = ?, settled_attempt = (SELECT j.attempts FROM scan_jobs j WHERE j.id = trial_reservations.job_id)
  WHERE kind = 'scan' AND EXISTS (
    SELECT 1 FROM scan_jobs j WHERE j.id = trial_reservations.job_id AND j.user_id = trial_reservations.tenant_id
      AND j.status = 'failed' AND j.error IN ('accounting_uncertain', 'timeout')
      AND (trial_reservations.settled_attempt IS NULL OR trial_reservations.settled_attempt < j.attempts
        OR (trial_reservations.settled_attempt = j.attempts AND trial_reservations.settled_at IS NULL))
  ) AND trial_reservations.job_id = ?`
export const RELEASE_CREATION_RESERVE_FOR_JOB_SQL = `UPDATE scan_jobs SET spend_reserved_usd = 0, spend_cap_reserved_usd = 0
  WHERE status = 'failed' AND error = 'accounting_uncertain'
    AND NOT EXISTS (SELECT 1 FROM scan_spend_calls c WHERE c.scan_job_id = scan_jobs.id)
    AND (COALESCE(spend_reserved_usd, 0) > 0 OR COALESCE(spend_cap_reserved_usd, 0) > 0)
    AND scan_jobs.id = ?`
export const RELEASE_REFUSAL_RESERVE_FOR_JOB_SQL = `UPDATE scan_jobs SET spend_reserved_usd = 0, spend_cap_reserved_usd = 0
  WHERE status = 'failed' AND error = 'provider_rejected'
    AND NOT EXISTS (SELECT 1 FROM scan_spend_calls c WHERE c.scan_job_id = scan_jobs.id AND ((c.status = 'settled' AND COALESCE(c.actual_usd, 0) > 0) OR (c.status = 'reserved' AND COALESCE(c.reserve_usd, 0) > 0)))
    AND (SELECT COUNT(*) FROM scan_spend_calls c WHERE c.scan_job_id = scan_jobs.id AND c.status = 'kept' AND COALESCE(c.reserve_usd, 0) > 0) <= 1
    AND (COALESCE(spend_reserved_usd, 0) > 0 OR COALESCE(spend_cap_reserved_usd, 0) > 0)
    AND scan_jobs.id = ?`
export async function settleReapedTrialForJob(db: AsyncDb, jobId: string, now = nowS()): Promise<void> { try { await db.run(SETTLE_REAPED_TRIAL_FOR_JOB_SQL, [now, jobId]); await db.run(RELEASE_CREATION_RESERVE_FOR_JOB_SQL, [jobId]); await db.run(RELEASE_REFUSAL_RESERVE_FOR_JOB_SQL, [jobId]) } catch { /* a store without the trial table: nothing to settle */ } }
