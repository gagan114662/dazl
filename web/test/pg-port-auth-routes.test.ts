// Runs test/helpers/pg-port-auth-routes-runtime.mts in its own process (the real auth route handlers, through the
// session loader): the #354 auth port on SQLite, and on a Postgres-only fixture when DAZL_TEST_PG_URL is set.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('../', import.meta.url))

test('Postgres port, auth area: sign-up, verification, reset, sign-in and Google on both engines', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT // the child reports as its own run, so its TAP output is readable here
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/pg-auth-routes-loader.mjs', '--test', '--test-reporter=tap', './test/helpers/pg-port-auth-routes-runtime.mts'], { cwd: web, env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined, String(r.error))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# fail 0/)
  if (process.env.DAZL_TEST_PG_URL) assert.match(r.stdout, /AUTH ROUTES IDENTICAL ON POSTGRES/)
})
