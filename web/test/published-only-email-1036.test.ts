// #1036 / #1250: Find work email, the Leads page and the crawl's candidate store give only an address the company publishes on its own
// domain: no learned-format guess, no Apollo or People Data Labs answer, no mailbox check (test/helpers/published-only-email-runtime.mts:
// real route handlers and store, stubbed session, fetch throws).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('#1036 #1250 the buyer\'s email is only an address published on the company\'s own domain', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  for (const k of ['OUTREACH_TEST_TENANT_ID', 'DAZL_ENV', 'DAZL_STAGING_FAKE_PDL', 'DAZL_STAGING_FAKE_ZEROBOUNCE', 'EMAIL_GUESS_ENABLED', 'ZEROBOUNCE_API_KEY']) delete env[k]
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', '--test-reporter=tap', './test/helpers/published-only-email-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 90000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /(?:#|ℹ) pass 2\b/); assert.match(r.stdout, /(?:#|ℹ) fail 0/)
})
