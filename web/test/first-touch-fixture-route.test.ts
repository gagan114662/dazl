// The #411 first-touch fixture through the real verification-fixture route handlers
// (test/helpers/first-touch-fixture-route-runtime.mts), stubbed, two tenants.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('first-touch fixture route: designated test tenant only, one confirmable lead to the own test inbox, scoped cleanup (real handlers, stubbed)', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  delete env.OUTREACH_TEST_TENANT_ID
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/first-touch-fixture-route-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 4\b/); assert.match(r.stdout, /# fail 0/)
})
