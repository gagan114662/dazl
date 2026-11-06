// #357 sign-up requires email confirmation before app access, with no account-existence leak, through the real route
// handlers and the real session lookup (test/helpers/signup-confirmation-runtime.mts). The runtime loads routes through
// a resolver hook, so it runs in its own process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('sign-up answers the same for every address and signs nobody in; only a confirmed account reaches the app (real routes)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/workspace-session-loader.mjs', '--test', './test/helpers/signup-confirmation-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 180000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  for (const marker of ['SIGNUP SAME ANSWER ok', 'SIGNUP TIMING median', 'SIGNUP CONFIRMATION GATE ok', 'SIGNUP MALFORMED ok', 'SIGNUP CAP+RACE ok', 'SIGNUP NO-MAIL ok', 'SIGNUP LEGACY ok']) assert.ok(r.stdout.includes(marker), marker)
})
