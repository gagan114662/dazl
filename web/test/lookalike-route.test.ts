// #386 route seam: the real POST /api/scan/lookalike and GET /api/leads handlers (test/helpers/lookalike-route-runtime.mts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('real lookalike + leads routes: cohort validated, features with a held-out check, lookalike fit labelled apart from intent (#386)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/scan-route-loader.mjs',
    '--test', './test/helpers/lookalike-route-runtime.mts',
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 90000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /# pass 2/); assert.match(result.stdout, /# fail 0/)
})
