import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { admitTrialScan, linkTrialReservation, settleTrialReservation, trialAllowanceLeft, trialRefusal } from '../lib/billing/trial-budget.ts'
import { historyJobs } from '../lib/scan/history-jobs.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'
import { reserveScanSpend, runWithScanSpend, scanCapConfig, scanSpendRow } from '../lib/scan/spend-cap.ts'
import { createJob, reapStaleRunningJobs } from '../lib/scan/store-db.ts'
import { readTrialStatus } from '../lib/scan/trial.ts'
import { bothEngines } from './helpers/engines.ts'

const now = 1_800_000_000
const tenant = { id: 'a'.repeat(32), email: 'owner@example.test' }
const env = { DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10',
  DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-fixture', TINYFISH_API_KEY: 'tf-fixture',
  DAZL_TRIAL_TINYFISH_SEARCH_USD: '0', DAZL_TRIAL_TINYFISH_FETCH_USD: '0' }
const estimate = JSON.stringify({ payer: 'trial', total: { min: 0.10, max: 1 }, cap: null, rows: [], trial_scan_cap_usd: 1 })

async function seed(db: Db, saved = false) {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'Owner', 'Fixture', 'x', 'y')", [tenant.id, tenant.email])
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', 'fixture', ?)", [tenant.id])
  const admitted = await admitTrialScan(db, tenant, { env, now })
  assert.ok(admitted.ok, JSON.stringify(admitted))
  const id = await createJob(db, tenant.id, { business_name: 'Fixture', industry: 'industry', location: 'location' }, '{}')
  await linkTrialReservation(db, tenant.id, admitted.reservation, id)
  await db.run("INSERT INTO trial_scans (tenant_id, job_id, ip_hash) VALUES (?, ?, 'fixture')", [tenant.id, id])
  await settleTrialReservation(db, id, 1, now - 3800)
  await db.run("UPDATE scan_jobs SET funded_by = 'trial', status = 'running', claimed_at = ?, attempts = 2, spend_reserved_usd = 0.80, spend_cap_usd = 1, spend_cap_reserved_usd = 0.80, estimate = ? WHERE id = ?", [now - 3600, estimate, id])
  await db.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, created_at) VALUES (?, ?, ?, 2, 'llm.anthropic', 0.80, 'reserved', ?)", [id, tenant.id, id, now - 3500])
  if (saved) await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url) VALUES (?, ?, 'Fixture', 'Public signal', 'https://example.test/signal')", [id, id])
  return id
}

async function reap(db: Db) {
  assert.equal(await reapStaleRunningJobs(db, now), 1)
}

async function actual(db: Db, id: string) {
  const status = await readScanStatus(db, tenant.id, id)
  assert.equal(status?.error, 'accounting_uncertain')
  const cost = status?.cost as { actual?: { final_usd?: number; summary?: string } } | undefined
  return cost?.actual
}

bothEngines('interrupted paid work remains charged against the $1 per-run cap', async ({ db }) => {
  const id = await seed(db)
  // A run with $0.80 already held cannot make another $0.21 request under a $1 cap.
  await assert.rejects(runWithScanSpend({ db, jobId: id, tenantId: tenant.id, attempt: 2, cap: scanCapConfig({}),
    accountLimits: null, clock: () => now - 3400 }, () => reserveScanSpend('llm.anthropic', () => 0.21)), { reason: 'over_cap' })
  await reap(db)
  assert.equal((await scanSpendRow(db, id, tenant.id))?.spend_cap_reserved_usd, 0.8)
  assert.equal((await actual(db, id))?.final_usd, 0.8)
  assert.equal((await db.get<{ status: string }>('SELECT status FROM scan_spend_calls WHERE id = ?', [id]))?.status, 'reserved')
})

bothEngines('interrupted paid work counts toward the daily limit', async ({ db }) => {
  const id = await seed(db)
  await reap(db)
  assert.equal(await trialRefusal(db, tenant, { now, env: { ...env, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '3', DAZL_TRIAL_GLOBAL_DAILY_USD: '1' } }), 'global_daily_cap')
  assert.equal((await actual(db, id))?.final_usd, 0.8)
})

bothEngines('interrupted paid work counts toward the account limit', async ({ db }) => {
  const id = await seed(db)
  await reap(db)
  await settleTrialReservation(db, id, 1, now + 1)
  const allowance = await trialAllowanceLeft(db, tenant.id, { env, now })
  assert.ok(allowance && Math.abs(allowance.left_usd - 0.2) < 1e-9)
  assert.equal(await trialRefusal(db, tenant, { now, env }), 'account_total_cap')
})

bothEngines('a settled interruption with zero saved leads returns the attempt only', async ({ db }) => {
  const id = await seed(db)
  assert.equal((await readTrialStatus(db, tenant.id, 'ip', new Date(now * 1000), env)).used, 1)
  await reap(db)
  assert.equal((await readTrialStatus(db, tenant.id, 'ip', new Date(now * 1000), env)).used, 0)
  const job = (await historyJobs(db, tenant.id)).find(row => row.id === id)
  assert.ok(job && 'spend_usd' in job)
  assert.equal(job.spend_usd, 0.8)
  const status = await readScanStatus(db, tenant.id, id)
  assert.match(status?.outcome.detail ?? '', /does not count toward your free scans/)
  assert.doesNotMatch(status?.outcome.detail ?? '', /reserved cost.*returned/i)
})

bothEngines('a settled interruption with any saved lead keeps its attempt', async ({ db }) => {
  const id = await seed(db, true)
  await reap(db)
  assert.equal((await readTrialStatus(db, tenant.id, 'ip', new Date(now * 1000), env)).used, 1)
  const status = await readScanStatus(db, tenant.id, id)
  assert.doesNotMatch(status?.outcome.detail ?? '', /does not count toward your free scans/)
})
