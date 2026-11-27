import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import type { Db } from '../lib/db/client.ts'
import { scanOutcome, type ScanRecord } from '../lib/scan/scan-outcome.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'
import { historyJobs } from '../lib/scan/history-jobs.ts'
import { createJob } from '../lib/scan/store-db.ts'
import { ledger, trialDay, type LedgerRow } from '../lib/billing/trial-budget.ts'
import { settleReapedTrial } from '../lib/billing/trial-reap.ts'
import { seedProviderRejected } from './fixtures/scan-billing-1727.ts'

// #1932: the AI provider REFUSED the scan's only paid call (HTTP 400 - credit balance too low; no tokens used,
// the provider billed nothing). Prod kept the call's reserve as spend: the job showed $0.03 and the trial
// attempt stayed used. A provider-rejected call with no recorded spend releases both, the #1921 rule.
const TRIAL_ENV = { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-fixture', DAZL_TRIAL_SCAN_RESERVE_USD: '0.75', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '10', DAZL_TRIAL_GLOBAL_DAILY_USD: '100' }
const ledgerRows = (db: Db, tenant: string) => db.all<LedgerRow>("SELECT r.tenant_id, r.kind, r.reserve_usd, r.spent_usd, r.day, r.created_at, r.settled_at, r.settled_attempt, j.status, j.error, j.candidates, j.attempts, j.spend_reserved_usd, j.spend_cap_reserved_usd, CASE WHEN j.error = 'accounting_uncertain' THEN EXISTS (SELECT 1 FROM leads l WHERE l.scan_job_id = j.id) END AS has_saved_leads FROM trial_reservations r LEFT JOIN scan_jobs j ON j.id = r.job_id AND j.user_id = r.tenant_id WHERE r.tenant_id = ?", [tenant])
const today = () => trialDay(Math.floor(Date.now() / 1000), 'UTC') // #2054: the fixture accounts save no zone, so their day is the UTC fallback day
const withTrialEnv = async (fn: () => Promise<void>) => {
  const saved = Object.fromEntries(Object.keys(TRIAL_ENV).map(k => [k, process.env[k]]))
  Object.assign(process.env, TRIAL_ENV)
  try { await fn() } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const mkUser = async (db: Db) => {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES ('A', 'a@gmail.com', 'n', 'b', 'x', 'y')")
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', 'sub-A', 'A')")
}

bothEngines('#1932: a provider-refused scan releases its charge and its trial search', async ({ db }) => {
  await mkUser(db)
  await withTrialEnv(async () => {
    const job = await seedProviderRejected(db, 'A')
    const before = ledger(await ledgerRows(db, 'A'), 'A', today())
    assert.deepEqual([before.account, before.attempts], [0.0255, 1], 'prod shape: the refusal reserve counts until the release runs')
    await settleReapedTrial(db)
    const after = ledger(await ledgerRows(db, 'A'), 'A', today())
    assert.deepEqual([after.account, after.today, after.attempts], [0, 0, 0], 'the charge and the trial search are both released')
    const j = await db.get<{ r: number; c: number }>('SELECT spend_reserved_usd AS r, spend_cap_reserved_usd AS c FROM scan_jobs WHERE id = ?', [job])
    assert.deepEqual([j?.r, j?.c], [0, 0], 'the reservation columns are cleared')
    const o = (await readScanStatus(db, 'A', job))?.outcome as { label: string; detail?: string }
    assert.equal(o.label, 'Stopped - the AI provider refused a request')
    assert.doesNotMatch(o.detail ?? '', /counted against your limits/)
    assert.match(o.detail ?? '', /nothing was charged/)
    assert.match(o.detail ?? '', /didn't use a free search/)
    const rec = (await historyJobs(db, 'A')).find(x => x.id === job) as unknown as ScanRecord
    assert.equal(rec.trial_attempt_restored, true, 'Past scans agrees: the free search was given back')
    assert.equal(scanOutcome(rec).detail, o.detail, 'status page and Past scans phrase it the same way')
    // a second pass is a no-op: the ledger stays released, the columns stay cleared, the settled reservation is untouched
    const res1 = await db.get<{ s: number | null; a: number | null }>('SELECT settled_at AS s, settled_attempt AS a FROM trial_reservations WHERE job_id = ?', [job])
    assert.ok(res1?.s != null, 'the reservation is settled')
    await settleReapedTrial(db)
    const again = ledger(await ledgerRows(db, 'A'), 'A', today())
    assert.deepEqual([again.account, again.today, again.attempts], [0, 0, 0], 'the second pass changes no total')
    const j2 = await db.get<{ r: number; c: number }>('SELECT spend_reserved_usd AS r, spend_cap_reserved_usd AS c FROM scan_jobs WHERE id = ?', [job])
    assert.deepEqual([j2?.r, j2?.c], [0, 0], 'the second pass leaves the columns cleared')
    const res2 = await db.get<{ s: number | null; a: number | null }>('SELECT settled_at AS s, settled_attempt AS a FROM trial_reservations WHERE job_id = ?', [job])
    assert.deepEqual([res2?.s, res2?.a], [res1?.s, res1?.a], 'the second pass leaves the settled reservation unchanged')
  })
})

bothEngines('#1932: a settled $0 free step before the refusal does not block the release - a refused scan never charges', async ({ db }) => {
  await mkUser(db)
  await withTrialEnv(async () => {
    const now = Math.floor(Date.now() / 1000)
    const job = await createJob(db, 'A', { business_name: 'b', industry: 'cleaning', location: 'Toronto' }, null, now)
    await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = ?, attempts = 1 WHERE id = ?", [now, job])
    await db.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES ('f1', 'A', ?, 1, 'tinyfish.search', 0, 0, 'settled', NULL, ?, ?)", [job, now + 1, now + 2])
    await db.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES ('f2', 'A', ?, 1, 'llm.anthropic', 0.0255, NULL, 'kept', NULL, ?, ?)", [job, now + 3, now + 4])
    await db.run("UPDATE scan_jobs SET status = 'failed', error = 'provider_rejected', finished_at = ?, claimed_at = NULL, funded_by = 'trial', spend_reserved_usd = 0.0255, spend_cap_reserved_usd = 0.0255 WHERE id = ?", [now + 5, job])
    await db.run("INSERT INTO trial_reservations (id, tenant_id, job_id, reserve_usd, day, created_at, settled_at, settled_attempt) VALUES ('r-free', 'A', ?, 0.75, ?, ?, ?, 1)", [job, Math.floor(now / 86400), now, now + 6])
    await settleReapedTrial(db)
    const l = ledger(await ledgerRows(db, 'A'), 'A', today())
    assert.deepEqual([l.account, l.attempts], [0, 0], 'the $0 step recorded nothing, so the refusal releases in full')
    const j = await db.get<{ r: number; c: number }>('SELECT spend_reserved_usd AS r, spend_cap_reserved_usd AS c FROM scan_jobs WHERE id = ?', [job])
    assert.deepEqual([j?.r, j?.c], [0, 0], 'the reservation columns are cleared')
  })
})

bothEngines('#1932 (negative): a provider-rejected job with recorded spend keeps its charge and its attempt', async ({ db }) => {
  await mkUser(db)
  await withTrialEnv(async () => {
    const now = Math.floor(Date.now() / 1000)
    const job = await createJob(db, 'A', { business_name: 'b', industry: 'cleaning', location: 'Toronto' }, null, now)
    await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = ?, attempts = 1 WHERE id = ?", [now, job])
    await db.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES ('n1', 'A', ?, 1, 'llm.anthropic', 0.02, 0.01, 'settled', NULL, ?, ?)", [job, now + 1, now + 2])
    await db.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES ('n2', 'A', ?, 1, 'llm.anthropic', 0.0255, NULL, 'kept', NULL, ?, ?)", [job, now + 3, now + 4])
    await db.run("UPDATE scan_jobs SET status = 'failed', error = 'provider_rejected', finished_at = ?, claimed_at = NULL, funded_by = 'trial', spend_reserved_usd = 0.0355, spend_cap_reserved_usd = 0.0355 WHERE id = ?", [now + 5, job])
    await db.run("INSERT INTO trial_reservations (id, tenant_id, job_id, reserve_usd, day, created_at, settled_at, settled_attempt) VALUES ('r-mixed', 'A', ?, 0.75, ?, ?, ?, 1)", [job, Math.floor(now / 86400), now, now + 6])
    await settleReapedTrial(db)
    const j = await db.get<{ r: number; c: number }>('SELECT spend_reserved_usd AS r, spend_cap_reserved_usd AS c FROM scan_jobs WHERE id = ?', [job])
    assert.deepEqual([j?.r, j?.c], [0.0355, 0.0355], 'recorded spend recorded: the columns are kept')
    const l = ledger(await ledgerRows(db, 'A'), 'A', today())
    assert.equal(l.attempts, 1, 'the attempt stays used')
    const o = (await readScanStatus(db, 'A', job))?.outcome as { detail?: string }
    assert.match(o.detail ?? '', /counted against your limits/, 'the counted wording stays when spend was recorded')
  })
})

bothEngines('#1932 (negative): a kept call from an earlier request, then the refusal - the possibly billed reserve is NOT released', async ({ db }) => {
  await mkUser(db)
  await withTrialEnv(async () => {
    const now = Math.floor(Date.now() / 1000)
    const job = await createJob(db, 'A', { business_name: 'b', industry: 'cleaning', location: 'Toronto' }, null, now)
    await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = ?, attempts = 1 WHERE id = ?", [now, job])
    // Ziggy's 0.1102 case: an earlier request's call was never answered, so spend-cap kept it at its reserve -
    // the provider may have run and billed it. The refusal that ended the job is the second kept row.
    await db.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES ('k1', 'A', ?, 1, 'llm.anthropic', 0.0847, NULL, 'kept', NULL, ?, ?)", [job, now + 1, now + 2])
    await db.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES ('k2', 'A', ?, 1, 'llm.anthropic', 0.0255, NULL, 'kept', NULL, ?, ?)", [job, now + 3, now + 4])
    await db.run("UPDATE scan_jobs SET status = 'failed', error = 'provider_rejected', finished_at = ?, claimed_at = NULL, funded_by = 'trial', spend_reserved_usd = 0.1102, spend_cap_reserved_usd = 0.1102 WHERE id = ?", [now + 5, job])
    await db.run("INSERT INTO trial_reservations (id, tenant_id, job_id, reserve_usd, day, created_at, settled_at, settled_attempt) VALUES ('r-kept-first', 'A', ?, 0.75, ?, ?, ?, 1)", [job, Math.floor(now / 86400), now, now + 6])
    await settleReapedTrial(db)
    const j = await db.get<{ r: number; c: number }>('SELECT spend_reserved_usd AS r, spend_cap_reserved_usd AS c FROM scan_jobs WHERE id = ?', [job])
    assert.deepEqual([j?.r, j?.c], [0.1102, 0.1102], 'a kept row that is not the refused call itself blocks the release: its reserve may be billed')
    const l = ledger(await ledgerRows(db, 'A'), 'A', today())
    assert.deepEqual([l.account, l.attempts], [0.1102, 1], 'the charge and the attempt stay')
    const o = (await readScanStatus(db, 'A', job))?.outcome as { detail?: string }
    assert.match(o.detail ?? '', /counted against your limits/, 'the counted wording stays')
    assert.doesNotMatch(o.detail ?? '', /didn't use a free search/, 'no free-search promise while a kept call may have billed')
  })
})

bothEngines('#1932 (guard): a still-running job is never released', async ({ db }) => {
  await mkUser(db)
  const now = Math.floor(Date.now() / 1000)
  const job = await createJob(db, 'A', { business_name: 'b', industry: 'cleaning', location: 'Toronto' }, null, now)
  await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = ?, attempts = 1, spend_reserved_usd = 0.0255, spend_cap_reserved_usd = 0.0255 WHERE id = ?", [now, job])
  await settleReapedTrial(db)
  const j = await db.get<{ r: number; c: number }>('SELECT spend_reserved_usd AS r, spend_cap_reserved_usd AS c FROM scan_jobs WHERE id = ?', [job])
  assert.deepEqual([j?.r, j?.c], [0.0255, 0.0255], 'a running job keeps its reserve columns')
})

test('#1932 copy control: without a spend read, the provider_rejected wording stays the counted one', () => {
  const o = scanOutcome({ id: 'j', status: 'failed', error: 'provider_rejected', funded_by: 'trial' } as ScanRecord)
  assert.match(o.detail ?? '', /counted against your limits/)
})
