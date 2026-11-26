import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// #830: the one sweep over every route that takes the id of a tenant-owned thing (helpers/isolation-all-routes-runtime.mts).
test("workspace isolation: no id-taking route lets workspace B read or change workspace A's data with A's ids", () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs',
    '--test', './test/helpers/isolation-all-routes-runtime.mts',
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /# pass 2\b/)
  assert.match(result.stdout, /ID ROUTES \d+ CASES \d+/)
})
