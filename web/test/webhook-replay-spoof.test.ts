// #887 guard for existing behaviour: replayed or unsigned webhook deliveries are refused or answered as duplicates on
// the Cal.com, first-party and Stripe receivers (test/helpers/webhook-replay-spoof-runtime.mts). The route modules
// need the test resolver, so the runtime runs in its own process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('signed webhooks refuse unsigned, forged, tampered, cross-tenant and stale deliveries; replays process once (#887)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/sequence-route-loader.mjs', '--test', './test/helpers/webhook-replay-spoof-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 90_000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 3\b/)
  assert.match(r.stdout, /# fail 0\b/)
})
