// Runs test/helpers/audit-routes-runtime.mts in its own process (it loads the route handlers through
// audit-session-loader.mjs, with the real session lookup): the audit trail (#371) through the real routes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('audit trail through the real routes and sessions: attributable, redacted, owners and admins only, one workspace', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/audit-session-loader.mjs', '--test', './test/helpers/audit-routes-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined, String(r.error))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /AUDIT ROUTES ok/)
  assert.match(r.stdout, /# fail 0/)
})
