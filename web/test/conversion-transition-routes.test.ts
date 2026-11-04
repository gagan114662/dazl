// #417 conversion -> onboarding transition through the real tick and billing webhook routes
// (test/helpers/conversion-transition-routes-runtime.mts). The runtime loads routes through a resolver hook, so it
// runs in its own process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('tick and paid-checkout webhook stop cold work and transition only opted-in sellers, idempotently (real routes)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/conversion-transition-routes-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# fail 0\b/)
  assert.match(r.stdout, /TRANSITION_TICK ok/)
  assert.match(r.stdout, /TRANSITION_WEBHOOK sqlite ok/)
  if (process.env.DAZL_TEST_PG_URL) assert.match(r.stdout, /TRANSITION_WEBHOOK pg ok/)
})
