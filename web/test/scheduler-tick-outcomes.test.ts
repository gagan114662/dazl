import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The real tick route classifies what the workers returned: success, hold or failure per tenant and kind of work
// (test/helpers/scheduler-tick-outcomes-runtime.mts).
test('tick route: refused, held and successful worker results are recorded as such; blocking, recovery, counts, isolation', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/scheduler-tick-outcomes-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 90000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^# pass 2$/m)
  assert.match(r.stdout, /^# fail 0$/m)
})
