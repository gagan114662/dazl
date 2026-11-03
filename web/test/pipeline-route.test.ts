import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The real pipeline route handlers (#366) against a fixture store, in a child process with the tenant route loader.
test('pipeline routes: auth, roles, origin, validation and tenant isolation', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/pipeline-route-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 60000 })
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /# pass 1/)
})
