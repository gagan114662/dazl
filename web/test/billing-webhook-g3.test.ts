// #2020 gate G3 (lane C): spawner for the webhook route-seam runtime (test/helpers/billing-webhook-g3-runtime.mts).
// The runtime loads route modules through the tenant-route loader, so it runs in its own process, like
// test/stripe-endpoint.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('G3: /api/billing/webhook refuses unsigned, stale and unusable deliveries with no state change; a valid event applies once', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/billing-webhook-g3-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  // TAP in CI ("# fail 0"), spec reporter in some local runs ("ℹ fail 0"): either proves the child run was clean.
  assert.match(r.stdout, /(?:#|ℹ) fail 0\b/)
  assert.match(r.stdout, /BILLING_WEBHOOK_G3 sqlite\b/)
})
