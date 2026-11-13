// #1082: runs the operator ops-status route through its real handler (test/helpers/tinyfish-today-route-runtime.mts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('#1082: GET /api/internal/tinyfish-today: 404 without or with a wrong shared secret; counts only with it (real route)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', '--test', '--test-reporter=tap', './test/helpers/tinyfish-today-route-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /TINYFISH TODAY ROUTE ok/)
})
