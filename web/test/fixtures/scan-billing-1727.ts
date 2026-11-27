// Fixtures for #1727 / #1862, shaped from the prod rows the issues cite. Seeding only - no production code.
// #1862 (prod 0162cec9, jobs f32826215e0c and 9e9650340fdf): status failed, error accounting_uncertain,
// created_at == finished_at, candidates/verified/enrich all null, lead_count 0, spend_usd 0.75 funded by trial -
// a scan that ended the second it started, with no paid step ever run.
// #1727 (prod, testdazl681): scans stopped mid-run by an interruption, with a paid step's reservation still held.
import { createJob } from '../../lib/scan/store-db.ts'
import type { Db } from '../../lib/db/client.ts'

const SPEND_CALL = "INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, ?)"

// A scan interrupted mid-run: it ran, one paid call settled, and one paid call (US$0.084666, the #1157 staging
// ledger shape) was still reserved when the run stopped as accounting_uncertain. Spend WAS recorded for it.
export async function seedInterruptedMidRun(db: Db, tenant: string): Promise<string> {
  const job = await createJob(db, tenant, { business_name: 'b', industry: 'manufacturing', location: 'Toronto' }, '{}')
  await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = 1000, attempts = 1 WHERE id = ?", [job])
  await db.run(SPEND_CALL, ['m1', tenant, job, 'llm.anthropic', 0.0211, 0.0019, 'settled', 1001, 1003])
  await db.run(SPEND_CALL, ['m2', tenant, job, 'llm.anthropic', 0.084666, null, 'reserved', 1008, null])
  await db.run("UPDATE scan_jobs SET status = 'failed', error = 'accounting_uncertain', finished_at = 2213, claimed_at = NULL WHERE id = ?", [job])
  return job
}

// A scan that failed at creation: created and finished in the same second, no paid step ever started (no
// scan_spend_calls rows at all), the $0.75 trial reserve recorded against the job and its trial reservation
// never settled - so the reserve still counts against the account and daily totals, as in prod.
export async function seedFailedAtCreation(db: Db, tenant: string): Promise<string> {
  const T = 1764117553 // the prod rows' shape: one instant, start and end
  const job = await createJob(db, tenant, { business_name: 'b', industry: 'contractors', location: 'Greater Toronto Area' }, null, T)
  await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = ?, attempts = 1 WHERE id = ?", [T, job]) // the status guard requires the running step; the prod row's end state is what matters
  await db.run("UPDATE scan_jobs SET status = 'failed', error = 'accounting_uncertain', finished_at = ?, claimed_at = NULL, funded_by = 'trial', spend_reserved_usd = 0.75 WHERE id = ?", [T, job])
  await db.run("INSERT INTO trial_reservations (id, tenant_id, job_id, reserve_usd, day, created_at) VALUES ('r-creation', ?, ?, 0.75, 1, ?)", [tenant, job, T])
  return job
}

// #1932 (prod 46a6c244, jobs 749c3ed8736d1929, c5482094887f, 37395f59ab07): a scan whose only paid call was
// REFUSED by the AI provider (HTTP 400, no tokens used, the provider billed nothing): status failed, error
// provider_rejected, funded by trial, ONE spend row llm.anthropic status 'kept' with reserve_usd 0.0255 and
// actual_usd NULL - the reserve stayed as the scan's recorded cost ($0.03 shown) and the trial reservation,
// settled by the runner's finalizer, still counts the attempt and the $0.0255 against the trial.
export async function seedProviderRejected(db: Db, tenant: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const job = await createJob(db, tenant, { business_name: 'b', industry: 'cleaning', location: 'Toronto' }, null, now)
  await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = ?, attempts = 1 WHERE id = ?", [now, job])
  await db.run(SPEND_CALL, ['p1', tenant, job, 'llm.anthropic', 0.0255, null, 'kept', now + 2, now + 3])
  await db.run("UPDATE scan_jobs SET status = 'failed', error = 'provider_rejected', finished_at = ?, claimed_at = NULL, funded_by = 'trial', spend_reserved_usd = 0.0255, spend_cap_reserved_usd = 0.0255 WHERE id = ?", [now + 4, job])
  await db.run("INSERT INTO trial_reservations (id, tenant_id, job_id, reserve_usd, day, created_at, settled_at, settled_attempt) VALUES ('r-refused', ?, ?, 0.75, ?, ?, ?, 1)",
    [tenant, job, Math.floor(now / 86400), now, now + 5])
  return job
}
