import assert from 'node:assert/strict'
import { admitTrialScan, trialFundable } from '../lib/billing/trial-budget.ts'
import { bothEngines } from './helpers/engines.ts'

const trialEnv = {
  DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-api03-TRIALFIXTURETRIALFIXTURETRIALFIXTURE',
  DAZL_TRIAL_SCAN_RESERVE_USD: '0.30',
  DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1',
  DAZL_TRIAL_GLOBAL_DAILY_USD: '10',
}

for (const [mode, tinyfishEnv] of [
  ['disabled with a key', { TINYFISH_ENABLED: '0', TINYFISH_API_KEY: 'fixture' }],
  ['unconfigured', {}],
] as const) {
  bothEngines(`a fresh Google account gets a funded first scan with TinyFish ${mode}`, async ({ db }) => {
    const env = { ...trialEnv, ...tinyfishEnv }
    const user = { id: 'a'.repeat(32), email: 'fresh-trial@gmail.com' }
    await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'Fixture', 'Fixture', 'x', 'y')", [user.id, user.email])
    await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', 'fresh-trial-fixture', ?)", [user.id])
    const admission = await admitTrialScan(db, user, { env })
    assert.ok(admission.ok, JSON.stringify(admission))
    assert.equal(trialFundable(env), true)
    const row = await db.get<{ reserve_usd: number | string }>(
      'SELECT reserve_usd FROM trial_reservations WHERE id = ? AND tenant_id = ?', [admission.reservation, user.id],
    )
    assert.equal(Number(row?.reserve_usd), 0.30)
  })
}
