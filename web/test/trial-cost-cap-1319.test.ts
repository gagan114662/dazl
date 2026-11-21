// #1319 item 2: a trial-eligible search never shows a cost above the $0.30 per-scan trial cap without saying the trial
// stops there - before the run (cost box) and after it (run page). Real route handlers: test/helpers/trial-cost-cap-1319-runtime.mts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('#1319 item 2 through POST /api/scan/estimate, POST /api/scan and GET /api/scan/status (real handlers, no network)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/scan-route-loader.mjs',
    '--test', '--test-reporter=tap', './test/helpers/trial-cost-cap-1319-runtime.mts',
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 90000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /# pass 4\b/); assert.match(result.stdout, /# fail 0/)
})
