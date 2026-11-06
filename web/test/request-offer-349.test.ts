// #349 / #204: the business and offer a search uses are this request's, through the real POST /api/scan and the real
// runner, on the Test A / Test B briefs, and the confirmed offer survives the next run of the same play
// (test/helpers/request-offer-349-runtime.mts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('Test A / Test B through POST /api/scan and the runner: the request\'s offer only, reused by the next run', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/scan-route-loader.mjs', '--test', './test/helpers/request-offer-349-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 90000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 5\b/); assert.match(r.stdout, /# fail 0/)
})
