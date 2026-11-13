// The test-only technology fixture route through the real handlers (test/helpers/tech-fixture-route-runtime.mts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('#769 tech fixture route: staging only, session + operate role, own workspace; adoption, outage and removal through the real crawl; cleanup (real handlers)', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  delete env.DAZL_ENV
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/tech-fixture-route-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 2\b/); assert.match(r.stdout, /# fail 0/)
})
