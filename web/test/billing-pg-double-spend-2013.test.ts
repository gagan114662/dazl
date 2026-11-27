// #2013 MONEY ON POSTGRES, PR 1: the concurrent double-spend guard for trial admission (lib/billing/trial-budget.ts
// admitTrialScan). Two separate Postgres pools (two app instances) race to admit a scan for the SAME tenant whose
// account total admits exactly one $0.75 reserve. The trial_budget_lock serialises admissions, so exactly one wins,
// the loser is refused, and the ledger ends with exactly one reservation - every iteration, repeated because a race
// that loses once proves little. Shape follows test/pg-stripe-customer-race.test.ts. Postgres only: without
// DAZL_TEST_PG_URL the test skips (CI runs it with DAZL_REQUIRE_PG=1). Synthetic accounts; no spend.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pgDb } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { admitTrialScan, trialAllowanceLeft } from '../lib/billing/trial-budget.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const NOW = 1_800_000_000
// A $0.75 reserve against a $0.75 account total: the budget admits exactly one scan. The global day ceiling is set
// high so it never binds across iterations; the account total is the only gate.
const caps: Record<string, string | undefined> = {
  DAZL_TRIAL_SCAN_RESERVE_USD: '0.75', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '0.75', DAZL_TRIAL_GLOBAL_DAILY_USD: '100',
  TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0', DAZL_TRIAL_TINYFISH_FETCH_USD: '0',
}
const uid = (n: number) => n.toString(16).padStart(32, '0')

test('[pg] two pools race admitTrialScan for one tenant whose budget admits exactly one scan: exactly one wins, every iteration', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const admin = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 1 })
  const one = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 1 })
  const two = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 1 })
  try {
    await runPgMigrations(admin.pool)
    for (let i = 0; i < 25; i++) {
      const id = uid(0xd500 + i), email = `double-spend-${i}@gmail.com`
      await admin.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
      await admin.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
      const user = { id, email }
      const results = await Promise.all([
        admitTrialScan(one, user, { env: caps, now: NOW }),
        admitTrialScan(two, user, { env: caps, now: NOW }),
      ])
      const winners = results.filter(r => r.ok)
      assert.equal(winners.length, 1, `iteration ${i}: exactly one admission wins (${JSON.stringify(results)})`)
      const loser = results.find(r => !r.ok)
      assert.deepEqual(loser, { ok: false, reason: 'account_total_cap' }, `iteration ${i}: the loser is refused on the account total`)
      const rows = await admin.all('SELECT id FROM trial_reservations WHERE tenant_id = ?', [id])
      assert.equal(rows.length, 1, `iteration ${i}: the ledger holds exactly one reservation`)
      assert.deepEqual(await trialAllowanceLeft(admin, id, { env: caps, now: NOW }), { left_usd: 0, total_usd: 0.75 }, `iteration ${i}: the budget is spent exactly once`)
    }
  } finally { await Promise.all([one.close(), two.close(), admin.close()]); await s.drop() }
})
