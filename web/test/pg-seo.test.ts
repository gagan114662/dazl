// SEO briefs and newsjack drafts on Postgres with two tenants, through the real /api/seo/brief and /api/seo/newsjack
// handlers (test/helpers/pg-seo-runtime.mts, run under the route loader): each tenant generates on its own AI key and
// lists only its own rows, and tenant A can neither read nor approve tenant B's draft.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pgSkip } from './helpers/pg-test.ts'

test('[pg] SEO routes: briefs and newsjacks per tenant, on each tenant\'s own key; no cross-tenant read or approve', { skip: pgSkip }, () => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/pg-seo-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1\b/)
  assert.match(r.stdout, /PG_SEO ok/)
})
