// #1036: the work-email fixture through the real verification-fixture and Find work email route handlers
// (test/helpers/work-email-fixture-route-runtime.mts), stubbed, two tenants.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('#1036 work-email fixture route: test tenant on staging fakes only; the real Find work email route answers from the fakes; scoped cleanup (real handlers, stubbed)', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  for (const k of ['OUTREACH_TEST_TENANT_ID', 'DAZL_ENV', 'DAZL_STAGING_FAKE_PDL', 'DAZL_STAGING_FAKE_ZEROBOUNCE']) delete env[k]
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/work-email-fixture-route-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 2\b/); assert.match(r.stdout, /# fail 0/)
})
