// #846/#847: runs the operator spend caps check through its real handler (test/helpers/spend-caps-route-runtime.mts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('#846 #847: GET /api/internal/spend-caps: 404 without the operator secret; with it, the four caps and their simulated refusals, no model call, no write (real route)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', '--test', '--test-reporter=tap', './test/helpers/spend-caps-route-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /SPEND CAPS ROUTE ok/)
})
