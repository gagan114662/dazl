// #1177: Find work email / Find contact on a customer-mention row (counterparty_signal) whose own website is settled, through the
// real route handlers (test/helpers/counterparty-own-site-1177-runtime.mts) in an isolated child: fixed auth/db loader, net fence,
// provider answer stubbed, https mapped to a loopback fixture server. Correct holds are asserted refused in the same run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('#1177 counterparty_signal rows with a settled own site get Find work email and Find contact; every other hold stays refused', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  for (const k of ['SITECRAWL_ENABLED', 'OUTREACH_TEST_TENANT_ID', 'DAZL_ENV', 'EMAIL_GUESS_ENABLED']) delete env[k]
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', '--test-reporter=tap', './test/helpers/counterparty-own-site-1177-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 90000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /(?:#|ℹ) pass 3\b/); assert.match(r.stdout, /(?:#|ℹ) fail 0/)
})
