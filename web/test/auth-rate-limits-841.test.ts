// #841: forgot password, verify, send verification and change email hold their rate limits at the real routes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('..', import.meta.url))

test('auth email routes answer 429 past their limits; forgot password stays generic past the per-email cap (real routes)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/workspace-session-loader.mjs', '--test', './test/helpers/auth-rate-limits-runtime.mts'], { cwd: web, env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /RATE reset ok[\s\S]*RATE verify ok[\s\S]*RATE send\+change ok/)
})
