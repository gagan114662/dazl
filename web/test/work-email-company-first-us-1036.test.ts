// #1036: the buyer's own work email, printed on a US company's own site and found by a company-first scan's real crawl, comes back
// from Find work email in one click (test/helpers/work-email-company-first-us-runtime.mts: real crawl, real readiness recorders, real
// GET/POST route handlers; stubbed HTTP, no network). Canada stays display-only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('#1036 company-first US buyer: Find work email returns the address printed on the company site, with its page', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  for (const k of ['OUTREACH_TEST_TENANT_ID', 'DAZL_ENV', 'DAZL_STAGING_FAKE_PDL', 'DAZL_STAGING_FAKE_ZEROBOUNCE', 'EMAIL_GUESS_ENABLED']) delete env[k]
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', '--test-reporter=tap', './test/helpers/work-email-company-first-us-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 90000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /(?:#|ℹ) pass 5\b/); assert.match(r.stdout, /(?:#|ℹ) fail 0/)
})
