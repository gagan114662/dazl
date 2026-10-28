// The billing path on Postgres with two tenants (test/helpers/pg-billing-runtime.mts, run under the route loader so the
// real /api/usage and /api/outreach/usage handlers serve it): each tenant's plan, Stripe status, scan quota and AI
// usage accounting come back as its own and only its own, and a plan written for one never reaches the other.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pgSkip } from './helpers/pg-test.ts'

test('[pg] billing: plan, Stripe status, scan quota and AI usage are per tenant through the Db layer and the routes', { skip: pgSkip }, () => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/pg-billing-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1\b/)
  assert.match(r.stdout, /PG_BILLING ok/)
})
