// #367 regression through the real Cal.com webhook route (test/helpers/calcom-lifecycle-route-runtime.mts). The route
// module needs the test resolver, so the runtime runs in its own process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('Cal.com route: a rescheduled-then-cancelled booking stops counting as booked and the lead stage comes back (#367)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/sequence-route-loader.mjs', '--test', './test/helpers/calcom-lifecycle-route-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 90_000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1\b/)
  assert.match(r.stdout, /# fail 0\b/)
})
