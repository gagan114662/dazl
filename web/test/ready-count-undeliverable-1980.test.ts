import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

test('#1980 Home holds a refused sole address and keeps usable named-buyer contacts Ready', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [
    '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/scan-route-loader.mjs', '--test-reporter=tap',
    '--test', './test/helpers/home-ready-deliverability-1833-runtime.mts',
  ], { cwd: new URL('../', import.meta.url), env, encoding: 'utf8', timeout: 120_000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
