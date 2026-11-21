// #1398: the QA-only scan request modes are refused by the real POST /api/scan and POST /api/scan/estimate handlers, while the
// production Claude Web Search opt-in and the ordinary first play keep their behaviour
// (test/helpers/qa-request-modes-1398-runtime.mts, under the scan route loader).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('#1398 QA-only request modes are not a way into a scan; the real first-run requests are unchanged', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/scan-route-loader.mjs', '--test', '--test-reporter=tap', './test/helpers/qa-request-modes-1398-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 3\b/); assert.match(r.stdout, /# fail 0\b/)
})
