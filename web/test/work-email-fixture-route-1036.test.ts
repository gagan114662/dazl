// #1036: the work-email fixture through the real verification-fixture and Find work email route handlers
// (test/helpers/work-email-fixture-route-runtime.mts), stubbed, two tenants.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The changed work-email route also serves the unchanged staging fixture. Keep its three cases in the targeted run.
test('#1036 staging work-email fixture and strict-origin published-only route: scoped handlers, no provider calls', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  for (const k of ['OUTREACH_TEST_TENANT_ID', 'DAZL_ENV', 'DAZL_STAGING_FAKE_PDL', 'DAZL_STAGING_FAKE_ZEROBOUNCE']) delete env[k]
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', '--test-reporter=tap', './test/helpers/work-email-fixture-route-runtime.mts', './test/work-email-published-only-route.fixture.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /(?:#|ℹ) pass 5\b/); assert.match(r.stdout, /(?:#|ℹ) fail 0/)
  assert.match(r.stdout, /strict-origin work email route serves published-only GET\/POST/)
  assert.match(r.stdout, /Canada and UK named first-party email is display only/)
})
