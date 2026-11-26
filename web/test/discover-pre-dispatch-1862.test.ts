import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import Database from 'better-sqlite3'
// The production preflight rejects an unpriced model before it constructs the provider client.
const originalModel = process.env.DAZL_DISCOVER_MODEL
process.env.DAZL_DISCOVER_MODEL = 'unpriced-test-model'
const { claimKeyedJob, runJob } = await import('../lib/scan/runner.ts')
if (originalModel === undefined) delete process.env.DAZL_DISCOVER_MODEL
else process.env.DAZL_DISCOVER_MODEL = originalModel
const { admitTrialScan, linkTrialReservation, trialAllowanceLeft, trialRefusal } = await import('../lib/billing/trial-budget.ts')
const { sqliteDb } = await import('../lib/db/client.ts')
const { migrateAllSqlite } = await import('../lib/db/sqlite-migrations.ts')
const { historyJobs } = await import('../lib/scan/history-jobs.ts')
const { createQueryJob } = await import('../lib/scan/store.ts')

const user = { id: 'a'.repeat(32), email: 'qa-fixture@example.test' }
const env = {
  DAZL_TRIAL_SCAN_RESERVE_USD: '0.75', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '0.75', DAZL_TRIAL_GLOBAL_DAILY_USD: '0.75',
  DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-fixture', TINYFISH_API_KEY: 'tf-fixture',
  DAZL_TRIAL_TINYFISH_SEARCH_USD: '0', DAZL_TRIAL_TINYFISH_FETCH_USD: '0',
  DAZL_TRIAL_QA_EXEMPT: '', DAZL_TRIAL_GLOBAL_DAILY_BY_DATE: 'off',
}

async function runTrial(sent: boolean) {
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  const raw = new Database(':memory:')
  try {
    migrateAllSqlite(raw)
    const db = sqliteDb(raw)
    await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'Fixture', 'Fixture', 'x', 'y')", [user.id, user.email])
    await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', 'fixture', ?)", [user.id])
    const admitted = await admitTrialScan(db, user, { env })
    assert.ok(admitted.ok, JSON.stringify(admitted))
    const id = createQueryJob(raw, user.id, { query: 'Find businesses opening a new branch', seller: 'Commercial fit-out services' })
    await linkTrialReservation(db, user.id, admitted.reservation, id)
    await db.run("UPDATE scan_jobs SET funded_by = 'trial' WHERE id = ?", [id])
    const job = claimKeyedJob(raw, id)
    assert.ok(job)

    let outbound = 0
    const fetchImpl: typeof fetch = async () => { outbound++; throw new Error('fixture connection closed after dispatch began') }
    const result = await runJob(raw, job, {
      master: randomBytes(32), discover: true, fetchImpl, enrichImpl: null,
      ...(sent ? { discoverImpl: async (_input, deps) => {
        assert.ok(deps.fetch)
        await deps.fetch('https://provider.example.test/v1/messages', { method: 'POST' })
        throw new Error('no provider usage received')
      } } : {}),
    })
    assert.equal(result, 'failed')
    assert.equal(outbound, sent ? 1 : 0)
    const state = await db.get<{ error: string; run: number; cap: number }>(
      'SELECT error, spend_reserved_usd AS run, spend_cap_reserved_usd AS cap FROM scan_jobs WHERE id = ?', [id])
    const history = (await historyJobs(db, user.id)).find(row => row.id === id)
    const allowance = await trialAllowanceLeft(db, user.id, { env })
    return {
      state, history: history && 'spend_usd' in history ? history.spend_usd : null, allowance: allowance?.left_usd,
      daily: await trialRefusal(db, user, { env: { ...env, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '3' } }),
      account: await trialRefusal(db, user, { env: { ...env, DAZL_TRIAL_GLOBAL_DAILY_USD: '10' } }),
    }
  } finally {
    raw.close()
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('#1862 a discovery preflight failure spends zero against the run, daily and account limits', async () => {
  const r = await runTrial(false)
  assert.deepEqual(r, {
    state: { error: 'source_error', run: 0, cap: 0 },
    history: 0, allowance: 0.75, daily: null, account: null,
  })
})

test('#1862 a discovery request whose dispatch begins retains its uncertain charge', async () => {
  const r = await runTrial(true)
  assert.deepEqual(r, {
    state: { error: 'accounting_uncertain', run: 0.75, cap: 0.75 },
    history: 0.75, allowance: 0, daily: 'global_daily_cap', account: 'account_total_cap',
  })
})
