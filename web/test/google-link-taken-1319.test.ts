// #1319 item 3: when the Google account picked already signs in to another dazl account, the person goes back to the page
// they started from (onboarding step or search) with a plain message, and 'taken' never shows in the URL.
// Real route handlers: test/helpers/google-link-taken-1319-runtime.mts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('#1319 item 3 through /api/auth/google and /api/auth/callback/google (real handlers, Google stubbed, no network)', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/health-route-loader.mjs', '--test', '--test-reporter=tap', './test/helpers/google-link-taken-1319-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined, String(r.error))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 4\b/); assert.match(r.stdout, /# fail 0/)
})
