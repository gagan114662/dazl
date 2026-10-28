// Stripe test mode through to the plan gates of the scan routes (test/helpers/billing-plan-gates-runtime.mts), on a
// separate SQLite store and on Postgres. Runs in its own process: the route modules load through a resolver hook.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('plan gates follow the plan Stripe webhooks write to the shared store, on both engines', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/health-route-loader.mjs', '--test', './test/helpers/billing-plan-gates-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# fail 0\b/)
  assert.match(r.stdout, /PLAN_GATES sqlite\b/)
  if (process.env.DAZL_TEST_PG_URL) assert.match(r.stdout, /PLAN_GATES pg\b/)
})
