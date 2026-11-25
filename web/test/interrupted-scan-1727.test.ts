import assert from 'node:assert/strict'
import { admitTrialScan, ledger, linkTrialReservation, trialAllowanceLeft, trialDay, type LedgerRow } from '../lib/billing/trial-budget.ts'
import { historyJobs } from '../lib/scan/history-jobs.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'
import { createJob, reapStaleRunningJobs } from '../lib/scan/store-db.ts'
import { bothEngines } from './helpers/engines.ts'

const now = 1_800_000_000
const tenant = { id: 'a'.repeat(32), email: 'owner@example.test' }
const env = { DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10',
  TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0', DAZL_TRIAL_TINYFISH_FETCH_USD: '0' }

bothEngines('an interrupted trial returns the allowance only when it saved no leads', async ({ db }) => {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'Owner', 'Fixture', 'x', 'y')", [tenant.id, tenant.email])
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', 'fixture', ?)", [tenant.id])
  const estimate = JSON.stringify({ payer: 'trial', total: { min: 0.10, max: 0.30 }, cap: null, rows: [], trial_scan_cap_usd: 0.30 })
  const jobs: string[] = []
  for (const saved of [false, true]) {
    const admitted = await admitTrialScan(db, tenant, { env, now })
    assert.ok(admitted.ok, JSON.stringify(admitted))
    const id = await createJob(db, tenant.id, { business_name: 'Fixture', industry: 'industry', location: 'location' }, '{}')
    jobs.push(id)
    await linkTrialReservation(db, tenant.id, admitted.reservation, id)
    await db.run("UPDATE scan_jobs SET funded_by = 'trial', status = 'running', claimed_at = ?, attempts = 1, spend_reserved_usd = 0.30, spend_cap_reserved_usd = 0.20, estimate = ? WHERE id = ?", [now - 3600, estimate, id])
    await db.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, created_at) VALUES (?, ?, ?, 1, 'llm.anthropic', 0.20, 'reserved', ?)", [id, tenant.id, id, now - 3500])
    if (saved) await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url) VALUES (?, ?, 'Fixture', 'Public signal', 'https://example.test/signal')", [id, id])
  }

  assert.deepEqual(await trialAllowanceLeft(db, tenant.id, { env, now }), { left_usd: 0.4, total_usd: 1 })
  assert.equal(await reapStaleRunningJobs(db, now), 2)
  assert.deepEqual(await trialAllowanceLeft(db, tenant.id, { env, now }), { left_usd: 0.8, total_usd: 1 })
  const [empty, saved] = jobs
  const status = await readScanStatus(db, tenant.id, empty)
  assert.equal(status?.error, 'accounting_uncertain')
  assert.match(status?.outcome.detail ?? '', /returned to your trial allowance/i)
  const cost = status?.cost as { actual?: { final_usd: number; summary: string } } | undefined
  assert.equal(cost?.actual?.final_usd, 0)
  assert.match(cost?.actual?.summary ?? '', /Final cost to you \$0\.00/)
  assert.doesNotMatch(cost?.actual?.summary ?? '', /counted as billed/)
  assert.doesNotMatch((await readScanStatus(db, tenant.id, saved))?.outcome.detail ?? '', /returned to your trial allowance/i)
  const history = await historyJobs(db, tenant.id)
  assert.equal(history.find(job => job.id === empty)?.spend_usd, 0)
  assert.equal(history.find(job => job.id === saved)?.spend_usd, 0.2)

  // Keep outstanding provider spend visible to the platform after customer reimbursement.
  const row: LedgerRow = { tenant_id: tenant.id, kind: 'scan', reserve_usd: 0.30, day: trialDay(now), settled_at: now,
    settled_attempt: 1, status: 'failed', error: 'accounting_uncertain', attempts: 1, spend_reserved_usd: 0.30,
    spend_cap_reserved_usd: 0.20, has_saved_leads: false }
  assert.deepEqual(ledger([row], tenant.id, trialDay(now)), { account: 0, today: 0.20, attempts: 0 })
  assert.deepEqual(ledger([{ ...row, settled_attempt: 0 }], tenant.id, trialDay(now)), { account: 0.30, today: 0.30, attempts: 1 })
  assert.equal((await db.get<{ status: string }>('SELECT status FROM scan_spend_calls WHERE id = ?', [empty]))?.status, 'reserved')
})
