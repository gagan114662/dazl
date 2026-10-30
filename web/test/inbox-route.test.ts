// The paged Inbox list and the mark-read action through the real route (test/helpers/inbox-route-runtime.mts):
// 'GET /api/outreach/inbox list' and 'POST /api/outreach/inbox read', two tenants, stubbed; the read is an operator write.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('inbox route: paged list and mark-read, two tenants (real handlers, stubbed)', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/inbox-route-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 2\b/); assert.match(r.stdout, /# fail 0/)
})
