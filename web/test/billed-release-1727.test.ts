import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import type { Db } from '../lib/db/client.ts'
import { scanOutcome, type ScanRecord } from '../lib/scan/scan-outcome.ts'
import { createJob } from '../lib/scan/store-db.ts'
import { admitTrialScan, linkTrialReservation, ledger, trialAllowanceLeft, trialDay, type LedgerRow } from '../lib/billing/trial-budget.ts'
import { settleReapedTrial } from '../lib/billing/trial-reap.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'
import { readTrialStatus } from '../lib/scan/trial.ts'
import { seedFailedAtCreation } from './fixtures/scan-billing-1727.ts'

// #1727/#1862 review fixes on PR #1921 (Quest, at d9deec9b):
// (1) the "didn't use a free search" sentence keys on trial_attempt_restored === true only - a trial scan that
//     saved leads keeps its attempt and must not be told otherwise;
// (2) 'Stopped before it started' is only for a scan that never ran - a scan that ran free steps and stopped
//     is an interruption that charged nothing;
// (3) the trial release is pinned: after settleReapedTrial the failed-at-creation job counts $0 and 0 attempts,
//     and a job with any spend row keeps its reserve columns.
const rec = (o: Partial<ScanRecord>): ScanRecord => ({ id: 'j', status: 'failed', error: 'accounting_uncertain', funded_by: 'trial', uncertain_usd: null, uncertain_steps: null, settled_usd: 0, spend_rows: 0, ...o })

test('#1727 fix 1: the free-search sentence follows trial_attempt_restored, not the funding source', () => {
  // never ran, trial-funded, but the attempt was NOT restored (e.g. a lead was saved): no free-search sentence
  const kept = scanOutcome(rec({ trial_attempt_restored: false }))
  assert.equal(kept.label, 'Stopped before it started')
  assert.equal(kept.detail, "This search stopped before it started. You weren't charged.")
  assert.doesNotMatch(kept.detail ?? '', /free search/)
  // never ran and restored: the sentence is there
  const restored = scanOutcome(rec({ trial_attempt_restored: true }))
  assert.equal(restored.detail, "This search stopped before it started. You weren't charged, and it didn't use a free search.")
  // user-funded and restored is impossible, but restored alone still governs the wording
  const other = scanOutcome(rec({ funded_by: 'user', trial_attempt_restored: false }))
  assert.doesNotMatch(other.detail ?? '', /free search/)
})

test('#1727 fix 2: a scan that ran free steps and stopped is an interruption, not a search that never started', () => {
  // free steps recorded (spend rows at $0), candidates found, nothing charged
  const ran = scanOutcome(rec({ spend_rows: 2, candidates: 5 }))
  assert.equal(ran.label, 'Stopped after an interruption')
  assert.equal(ran.detail, "You weren't charged.")
  // a $0 maybe-billed hold: a spend row exists even with nothing extracted
  const held = scanOutcome(rec({ spend_rows: 1, candidates: 0 }))
  assert.equal(held.label, 'Stopped after an interruption')
  assert.equal(held.detail, "You weren't charged.")
  // no spend rows but candidates were extracted: it ran
  const extracted = scanOutcome(rec({ spend_rows: 0, candidates: 2 }))
  assert.equal(extracted.label, 'Stopped after an interruption')
  // never ran, proven by the row's own timestamps alone (spend read absent)
  const stamped = scanOutcome(rec({ spend_rows: undefined, settled_usd: 0, created_at: 1764117553, finished_at: 1764117553 }))
  assert.equal(stamped.label, 'Stopped before it started')
})

const TRIAL_ENV = { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-fixture', DAZL_TRIAL_SCAN_RESERVE_USD: '0.75', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '10', DAZL_TRIAL_GLOBAL_DAILY_USD: '100' }
const ledgerRows = (db: Db, tenant: string) => db.all<LedgerRow>("SELECT r.tenant_id, r.kind, r.reserve_usd, r.spent_usd, r.day, r.created_at, r.settled_at, r.settled_attempt, j.status, j.error, j.candidates, j.attempts, j.spend_reserved_usd, j.spend_cap_reserved_usd, CASE WHEN j.error = 'accounting_uncertain' THEN EXISTS (SELECT 1 FROM leads l WHERE l.scan_job_id = j.id) END AS has_saved_leads FROM trial_reservations r LEFT JOIN scan_jobs j ON j.id = r.job_id AND j.user_id = r.tenant_id WHERE r.tenant_id = ?", [tenant])
const today = () => trialDay(Math.floor(Date.now() / 1000))
const withTrialEnv = async (fn: () => Promise<void>) => {
  const saved = Object.fromEntries(Object.keys(TRIAL_ENV).map(k => [k, process.env[k]]))
  Object.assign(process.env, TRIAL_ENV)
  try { await fn() } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

bothEngines('#1727 fix 3: after the settle pass the failed-at-creation scan counts $0 and no attempt', async ({ db }) => {
  const tenant = 'A'
  await withTrialEnv(async () => {
    const job = await seedFailedAtCreation(db, tenant)
    const before = ledger(await ledgerRows(db, tenant), tenant, today())
    assert.deepEqual([before.account, before.attempts], [0.75, 1], 'the reserve counts until the release runs')
    await settleReapedTrial(db)
    const after = ledger(await ledgerRows(db, tenant), tenant, today())
    assert.deepEqual([after.account, after.today, after.attempts], [0, 0, 0], 'cost and attempt are both released')
    const j = await db.get<{ r: number; c: number }>('SELECT spend_reserved_usd AS r, spend_cap_reserved_usd AS c FROM scan_jobs WHERE id = ?', [job])
    assert.deepEqual([j?.r, j?.c], [0, 0], 'the reservation columns are cleared')
    // a second pass is a no-op: the ledger stays released, the columns stay cleared, the settled reservation is untouched
    const res1 = await db.get<{ s: number | null; a: number | null }>('SELECT settled_at AS s, settled_attempt AS a FROM trial_reservations WHERE job_id = ?', [job])
    assert.ok(res1?.s != null, 'the first pass settled the reservation')
    await settleReapedTrial(db)
    const again = ledger(await ledgerRows(db, tenant), tenant, today())
    assert.deepEqual([again.account, again.today, again.attempts], [0, 0, 0], 'the second pass changes no total')
    const j2 = await db.get<{ r: number; c: number }>('SELECT spend_reserved_usd AS r, spend_cap_reserved_usd AS c FROM scan_jobs WHERE id = ?', [job])
    assert.deepEqual([j2?.r, j2?.c], [0, 0], 'the second pass leaves the columns cleared')
    const res2 = await db.get<{ s: number | null; a: number | null }>('SELECT settled_at AS s, settled_attempt AS a FROM trial_reservations WHERE job_id = ?', [job])
    assert.deepEqual([res2?.s, res2?.a], [res1?.s, res1?.a], 'the second pass leaves the settled reservation unchanged')
  })
})

bothEngines('#1727 Z2: the outcome copy, the free-scans counter and the allowance agree, with no separate settle call', async ({ db }) => {
  const tenant = 'A'
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES ('A', 'a@gmail.com', 'n', 'b', 'x', 'y')")
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', 'sub-A', 'A')")
  await withTrialEnv(async () => {
    const job = await seedFailedAtCreation(db, tenant)
    await db.run("INSERT INTO trial_scans (tenant_id, job_id, ip_hash, created_at) VALUES (?, ?, 'h', ?)", [tenant, job, Math.floor(Date.now() / 1000)])
    // No settleReapedTrial call anywhere in this test: reading the scan's status settles this job itself
    // (the read-path fix), so every surface that reads afterwards sees the same settled state.
    const o = (await readScanStatus(db, tenant, job))?.outcome as { label: string; detail?: string }
    assert.match(o.detail ?? '', /didn't use a free search/, 'the copy gives the free search back')
    const st = await readTrialStatus(db, tenant, '198.51.100.7')
    assert.equal(st.used, 0, 'the free-scans counter agrees: the attempt is not used')
    const left = await trialAllowanceLeft(db, tenant)
    assert.equal(left?.left_usd, 10, 'the allowance agrees: the $0.75 reserve counts for nothing')
    const l = ledger(await ledgerRows(db, tenant), tenant, today())
    assert.deepEqual([l.account, l.attempts], [0, 0], 'the ledger agrees: no cost, no attempt')
  })
})

bothEngines('#1727 review: a still-running job is never released - its reserve columns are its live budget', async ({ db }) => {
  const tenant = 'A'
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES ('A', 'a@gmail.com', 'n', 'b', 'x', 'y')")
  const job = await createJob(db, tenant, { business_name: 'b', industry: 'i', location: 'l' })
  const now = Math.floor(Date.now() / 1000)
  await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = ?, attempts = 1, spend_reserved_usd = 0.3, spend_cap_reserved_usd = 0.75 WHERE id = ?", [now, job])
  await settleReapedTrial(db)
  const j = await db.get<{ r: number; c: number }>('SELECT spend_reserved_usd AS r, spend_cap_reserved_usd AS c FROM scan_jobs WHERE id = ?', [job])
  assert.deepEqual([j?.r, j?.c], [0.3, 0.75], 'a running job keeps its reserve columns')
})

bothEngines('#1727 review: the release covers a user-funded job that failed at creation the same way', async ({ db }) => {
  const tenant = 'A'
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES ('A', 'a@gmail.com', 'n', 'b', 'x', 'y')")
  const job = await createJob(db, tenant, { business_name: 'b', industry: 'i', location: 'l' })
  const now = Math.floor(Date.now() / 1000)
  await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = ?, attempts = 1 WHERE id = ?", [now, job])
  await db.run("UPDATE scan_jobs SET status = 'failed', error = 'accounting_uncertain', finished_at = ?, claimed_at = NULL, funded_by = 'user', spend_reserved_usd = 0.3, spend_cap_reserved_usd = 0.75 WHERE id = ?", [now, job])
  await settleReapedTrial(db)
  const j = await db.get<{ r: number; c: number }>('SELECT spend_reserved_usd AS r, spend_cap_reserved_usd AS c FROM scan_jobs WHERE id = ?', [job])
  assert.deepEqual([j?.r, j?.c], [0, 0], 'no spend rows means nothing spent, whatever funded the scan')
})

bothEngines('#1727 fix 3 (negative): a job with any spend row keeps its reserve columns through the settle pass', async ({ db }) => {
  const tenant = 'A'
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES ('A', 'a@gmail.com', 'n', 'b', 'x', 'y')")
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', 'sub-A', 'A')")
  await withTrialEnv(async () => {
    for (const [kind, status, reserve, actual] of [['llm.anthropic', 'settled', 0, 0], ['tinyfish.search', 'refused', 0.05, null]] as const) {
      const a = await admitTrialScan(db, { id: tenant, email: 'a@gmail.com' }, { now: Math.floor(Date.now() / 1000) })
      assert.ok(a.ok, JSON.stringify(a))
      const job = await createJob(db, tenant, { business_name: 'b', industry: 'i', location: 'l' })
      await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = ?, attempts = 1 WHERE id = ?", [Math.floor(Date.now() / 1000), job])
      await db.run("UPDATE scan_jobs SET status = 'failed', error = 'accounting_uncertain', finished_at = ?, claimed_at = NULL, funded_by = 'trial', spend_reserved_usd = 0.3, spend_cap_reserved_usd = 0.75 WHERE id = ?", [Math.floor(Date.now() / 1000), job])
      await linkTrialReservation(db, tenant, a.reservation, job)
      await db.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, created_at, settled_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)",
        [`neg-${kind}-${status}`, tenant, job, kind, reserve, actual, status, Math.floor(Date.now() / 1000), status === 'settled' ? Math.floor(Date.now() / 1000) : null])
      await settleReapedTrial(db)
      const j = await db.get<{ r: number; c: number }>('SELECT spend_reserved_usd AS r, spend_cap_reserved_usd AS c FROM scan_jobs WHERE id = ?', [job])
      assert.deepEqual([j?.r, j?.c], [0.3, 0.75], `${status} spend row: the reserve columns are kept`)
    }
  })
})
