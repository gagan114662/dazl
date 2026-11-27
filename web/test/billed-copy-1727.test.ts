import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'
import { historyJobs } from '../lib/scan/history-jobs.ts'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'
import { interruptedTrialAttemptRestored } from '../lib/billing/trial-budget.ts'
import { seedInterruptedMidRun, seedFailedAtCreation } from './fixtures/scan-billing-1727.ts'
import { createJob } from '../lib/scan/store-db.ts'

// #1727 / #1862: what the user sees (Past scans card, Home, Leads) must never say 'counted as billed' unless
// spend was actually recorded for that scan, and a scan that failed at creation must not use a free search.
// The three surfaces share scanOutcome; they differ in what they feed it - the status read (Leads) reads the
// still-reserved spend rows, the history list (Past scans) reads recorded spend and the trial restoration, and
// Home's journey feeds it the job row alone. Each surface is exercised the way it actually reads.

bothEngines('#1727 control: an interrupted scan WITH a recorded reserved spend step says counted as billed, with its amount', async ({ db }) => {
  const job = await seedInterruptedMidRun(db, 'A')
  const o = (await readScanStatus(db, 'A', job))?.outcome as { label: string; detail?: string }
  assert.match(o.label, /one paid step counted as billed \(\$0\.0847\)/, 'the billed claim is backed by the recorded reserved step')
})

bothEngines('#1862: a scan that failed at creation (no paid step ever ran, no spend recorded) never says counted as billed - status read', async ({ db }) => {
  const job = await seedFailedAtCreation(db, 'A')
  const o = (await readScanStatus(db, 'A', job))?.outcome as { label: string; detail?: string }
  assert.doesNotMatch(`${o.label} ${o.detail ?? ''}`, /counted as billed/, 'no spend was recorded for this scan, so no billed claim')
})

bothEngines('#1862: a scan that failed at creation never says counted as billed - Past scans card', async ({ db }) => {
  const job = await seedFailedAtCreation(db, 'A')
  const rec = (await historyJobs(db, 'A')).find(j => j.id === job) as unknown as Parameters<typeof scanOutcome>[0]
  assert.ok(rec, 'the job is in the history list')
  const o = scanOutcome(rec) // the client renders the outcome from this record (leads-client.tsx)
  assert.doesNotMatch(`${o.label} ${o.detail ?? ''}`, /counted as billed/)
})

bothEngines('#1862: a scan that failed at creation never says counted as billed - Home', async ({ db }) => {
  const job = await seedFailedAtCreation(db, 'A')
  const rec = (await historyJobs(db, 'A')).find(j => j.id === job) as unknown as Record<string, unknown>
  // Home's journey (lib/journey.ts) calls scanOutcome on the job row itself, with no spend reads at all.
  const o = scanOutcome({ ...(rec as object), uncertain_usd: undefined, uncertain_steps: undefined, spend_usd: undefined, trial_attempt_restored: undefined } as never)
  assert.doesNotMatch(`${o.label} ${o.detail ?? ''}`, /counted as billed/)
})

bothEngines('#1862: a scan that failed at creation uses no free search - the trial attempt is given back', async ({ db }) => {
  const job = await seedFailedAtCreation(db, 'A')
  // Read through the status surface first: it settles this job on the read path (Z2), so the restoration the
  // flag reports is the settled one the trial counter also reads - never a promise ahead of the ledger.
  const o = (await readScanStatus(db, 'A', job))?.outcome as { label: string; detail?: string }
  assert.match(o.detail ?? '', /didn't use a free search/, 'the status copy gives the free search back')
  assert.equal(await interruptedTrialAttemptRestored(db, 'A', job), true, 'the attempt is restored, so the free search is not used')
  const rec = (await historyJobs(db, 'A')).find(j => j.id === job) as unknown as { trial_attempt_restored?: boolean }
  assert.equal(rec.trial_attempt_restored, true, 'the history record carries the restoration, so the card can say the free scan was not used')
})

bothEngines('#1932 copy: a kept paid call ($0.0847) before the refusal - the provider copy stays counted, never nothing was charged', async ({ db }) => {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES ('A', 'a@gmail.com', 'n', 'b', 'x', 'y')")
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', 'sub-A', 'A')")
  const now = Math.floor(Date.now() / 1000)
  const job = await createJob(db, 'A', { business_name: 'b', industry: 'cleaning', location: 'Toronto' }, null, now)
  await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = ?, attempts = 1 WHERE id = ?", [now, job])
  await db.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES ('k1', 'A', ?, 1, 'llm.anthropic', 0.0847, NULL, 'kept', NULL, ?, ?)", [job, now + 1, now + 2])
  await db.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES ('k2', 'A', ?, 1, 'llm.anthropic', 0.0255, NULL, 'kept', NULL, ?, ?)", [job, now + 3, now + 4])
  await db.run("UPDATE scan_jobs SET status = 'failed', error = 'provider_rejected', finished_at = ?, claimed_at = NULL, funded_by = 'trial', spend_reserved_usd = 0.1102, spend_cap_reserved_usd = 0.1102 WHERE id = ?", [now + 5, job])
  await db.run("INSERT INTO trial_reservations (id, tenant_id, job_id, reserve_usd, day, created_at, settled_at, settled_attempt) VALUES ('r-kept-first', 'A', ?, 0.75, ?, ?, ?, 1)", [job, Math.floor(now / 86400), now, now + 6])
  const o = (await readScanStatus(db, 'A', job))?.outcome as { label: string; detail?: string }
  assert.doesNotMatch(o.detail ?? '', /nothing was charged/, 'a kept row may have been billed - the job still holds its cost')
  assert.match(o.detail ?? '', /counted against your limits/)
})

bothEngines('#1727 copy: accounting_uncertain with one kept $0.05 row does not say You weren\'t charged', async ({ db }) => {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES ('A', 'a@gmail.com', 'n', 'b', 'x', 'y')")
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', 'sub-A', 'A')")
  const now = Math.floor(Date.now() / 1000)
  const job = await createJob(db, 'A', { business_name: 'b', industry: 'cleaning', location: 'Toronto' }, null, now)
  await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = ?, attempts = 1 WHERE id = ?", [now, job])
  await db.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES ('k1', 'A', ?, 1, 'llm.anthropic', 0.05, NULL, 'kept', NULL, ?, ?)", [job, now + 1, now + 2])
  await db.run("UPDATE scan_jobs SET status = 'failed', error = 'accounting_uncertain', finished_at = ?, claimed_at = NULL, funded_by = 'trial', spend_reserved_usd = 0.05, spend_cap_reserved_usd = 0.05 WHERE id = ?", [now + 5, job])
  await db.run("INSERT INTO trial_reservations (id, tenant_id, job_id, reserve_usd, day, created_at, settled_at, settled_attempt) VALUES ('r-kept-acct', 'A', ?, 0.75, ?, ?, NULL, NULL)", [job, Math.floor(now / 86400), now])
  const o = (await readScanStatus(db, 'A', job))?.outcome as { label: string; detail?: string }
  assert.doesNotMatch(`${o.label} ${o.detail ?? ''}`, /weren't charged/, 'the kept row may have been billed and the ledger still counts the job cost')
  assert.match(`${o.label} ${o.detail ?? ''}`, /counted as billed/)
})
