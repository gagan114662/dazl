import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('Leads gate projection preserves scalar outcomes with bounded SQLite queries', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/scan-route-loader.mjs', '--test-reporter=tap', '--test',
    './test/helpers/leads-route-gate-batch-runtime.mts',
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
