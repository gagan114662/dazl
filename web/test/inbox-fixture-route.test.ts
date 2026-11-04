// The test-only inbox fixture route through the real handlers (test/helpers/inbox-fixture-route-runtime.mts):
// 'POST /api/outreach/inbox/fixture seed' and 'DELETE /api/outreach/inbox/fixture cleanup', two tenants, stubbed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('inbox fixture route: owner + flag + designated tenant only, audited refusals, seed -> paged Inbox + bounce_review -> cleanup (real handlers, stubbed)', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  delete env.OUTREACH_INBOX_FIXTURE; delete env.OUTREACH_TEST_TENANT_ID
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/inbox-fixture-route-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 2\b/); assert.match(r.stdout, /# fail 0/)
})
