// #417 auth-boundary conversion flow through the real route handlers (test/helpers/auth-lifecycle-routes-runtime.mts).
// The runtime loads routes through a resolver hook, so it runs in its own process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('unverified signup stays pending; verify/reset links and verified sign-in activate the cancel; tampered links do nothing (real routes)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/workspace-session-loader.mjs', '--test', './test/helpers/auth-lifecycle-routes-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /AUTH LIFECYCLE ROUTES ok/)
})
