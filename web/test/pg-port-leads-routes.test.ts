// Runs test/helpers/pg-port-leads-routes-runtime.mts in its own process (the real leads route handlers, through the
// tenant route loader): the #354 leads-routes port on SQLite, and on a Postgres-only fixture when DAZL_TEST_PG_URL is set.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('../', import.meta.url))

test('Postgres port, leads routes: evidence, source metrics, page signals and domain review on both engines', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT // the child reports as its own run, so its TAP output is readable here
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', '--test-reporter=tap', './test/helpers/pg-port-leads-routes-runtime.mts'], { cwd: web, env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined, String(r.error))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# fail 0/)
  if (process.env.DAZL_TEST_PG_URL) assert.match(r.stdout, /LEADS ROUTES IDENTICAL ON POSTGRES/)
})
