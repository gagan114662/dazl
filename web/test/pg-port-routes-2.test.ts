// Runs test/helpers/pg-port-routes-2-runtime.mts in its own process (it loads the route handlers through the test
// route loader): the Postgres port's batch 2 routes (settings, Cal.com, warm paths) on SQLite and on Postgres.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('../', import.meta.url))

test('Postgres port batch 2: route parity on both engines', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT // the child reports as its own run, so its TAP output is readable here
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/pg-port-routes-2-runtime.mts'], { cwd: web, env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined, String(r.error))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# fail 0/)
  if (process.env.DAZL_TEST_PG_URL) assert.match(r.stdout, /BATCH2 ROUTES IDENTICAL/)
})
