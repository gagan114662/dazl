// Stripe webhook events in test mode, two tenants, both engines (test/helpers/billing-events-runtime.mts). The runtime
// loads route modules through a resolver hook, so it runs in its own process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('Stripe webhook events: checkout, subscription updated/deleted, invoice.payment_failed; once per event id; tenants isolated', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/billing-events-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# fail 0\b/)
  assert.match(r.stdout, /STRIPE_EVENTS sqlite\b/)
  if (process.env.DAZL_TEST_PG_URL) assert.match(r.stdout, /STRIPE_EVENTS pg\b/)
})
