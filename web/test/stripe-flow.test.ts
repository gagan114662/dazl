// Stripe in test mode end to end on SQLite and Postgres (test/helpers/stripe-flow-runtime.mts): checkout -> signed
// webhook -> plan on the account -> the plan's scan limit -> cancel at period end -> deleted -> Free and limited again.
// Real routes in their own process; Stripe-signed test-mode fixtures; api.stripe.com stubbed; no scan runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PG_URL } from './helpers/pg-test.ts'

test('Stripe test mode end to end: checkout, signed webhook, plan, limits, cancel, downgrade (SQLite and Postgres)', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/health-route-loader.mjs', '--test', './test/helpers/stripe-flow-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 240000 })
  assert.equal(r.error, undefined, String(r.error))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /STRIPE_FLOW_OK sqlite/)
  if (PG_URL) assert.match(r.stdout, /STRIPE_FLOW_OK pg/)
})
