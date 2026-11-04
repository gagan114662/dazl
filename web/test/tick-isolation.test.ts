// Two-tenant orchestration of the REAL tick route (app/api/internal/tick/route.ts) on in-memory SQLite, via
// test/helpers/tick-isolation-runtime.mts through the tenant-route loader. Covers what the worker-direct tests
// (test/job-isolation.test.ts) cannot see: the route's tenant selection queries, per-tenant failure containment
// in its loop, and scheduler_progress tenant attribution. SQLite only: the route's outreach loop uses the raw
// SQLite handle in every deployment today, and production runs SQLite; the route+Postgres harness pattern is
// already proven by test/audit-retention-tick.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('[sqlite] tick route: two-tenant selection, attribution and failure containment', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', '--test', '--test-reporter=tap', './test/helpers/tick-isolation-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 180000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 2/)
  assert.match(r.stdout, /# fail 0/)
})
