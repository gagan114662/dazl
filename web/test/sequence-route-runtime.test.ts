import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('real sequence create route stays network/provider-free with BYOK configured; trap detects old rewrite path', () => {
  // Isolate auth loader, synthetic master key and provider spies from other tests.
  const web = fileURLToPath(new URL('../', import.meta.url))
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT // child is its own TAP runner, not a nested test worker
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/sequence-route-loader.mjs',
    '--test', './test/helpers/sequence-route-runtime.mts',
  ], { cwd: web, env, encoding: 'utf8', timeout: 30000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /# pass 1/)
})
