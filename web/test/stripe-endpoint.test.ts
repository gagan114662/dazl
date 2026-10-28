// Stripe end to end in test mode through /api/stripe (test/helpers/stripe-endpoint-runtime.mts), on SQLite and Postgres.
// The runtime loads route modules through a resolver hook, so it runs in its own process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('Stripe through /api/stripe: checkout, signed webhook, replay, payment failed, downgrade, cancel, unknown tenant, tenant isolation', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/stripe-endpoint-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# fail 0\b/)
  assert.match(r.stdout, /STRIPE_ENDPOINT sqlite\b/)
  if (process.env.DAZL_TEST_PG_URL) assert.match(r.stdout, /STRIPE_ENDPOINT pg\b/)
})
