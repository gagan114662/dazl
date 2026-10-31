import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// #448: the real tick route drains autopilot first touches through the lease-fenced view and records the drain per
// tenant as kind 'autopilot' (test/helpers/autopilot-tick-runtime.mts).
test('tick route: the autopilot first-touch drain sends through the fenced view and is recorded per tenant: success, failure (blocked after three), hold', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/autopilot-tick-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 90000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^# pass 5$/m)
  assert.match(r.stdout, /^# fail 0$/m)
})
