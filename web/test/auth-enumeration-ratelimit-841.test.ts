// #841: runs test/helpers/auth-enumeration-841-runtime.mts in its own process (the real forgot-password and
// verification-resend route handlers, the real session lookup and rate-limit store; auth-after-loader.mjs), on SQLite
// and, when DAZL_TEST_PG_URL is set, on Postgres. Known and unknown emails get the same answer and timing class; the
// Nth request inside the window gets a generic 429, per IP and per email.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('../', import.meta.url))

test('#841 forgot password and verification resend: same answer for a known and an unknown email; per-IP and per-email 429 (real routes, both engines)', () => {
  if (process.env.DAZL_REQUIRE_PG === '1') {
    assert.ok(process.env.DAZL_TEST_PG_URL, 'PostgreSQL CI must provide DAZL_TEST_PG_URL for the auth route tests')
  }
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT // the child reports as its own run
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/auth-after-loader.mjs', '--test', '--test-reporter=tap', './test/helpers/auth-enumeration-841-runtime.mts'], { cwd: web, env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined, String(r.error))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# fail 0/)
  assert.match(r.stdout, /AUTH ENUMERATION 841 ok sqlite/)
  if (process.env.DAZL_TEST_PG_URL) {
    assert.match(r.stdout, /AUTH ENUMERATION 841 ok pg/)
    assert.match(r.stdout, /^ok \d+ - \[pg\].*the same on Postgres$/m)
  }
})
