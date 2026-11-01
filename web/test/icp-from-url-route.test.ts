// #409: POST /api/scan/icp-from-url keyed vs free read through the real route handler
// (test/helpers/icp-from-url-route-runtime.mts). The runtime loads routes through a resolver hook, so it runs in its own process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('icp-from-url route: tenant key drafts the icp, keyless gets the sourced free read, error mapping holds (real route)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/icp-from-url-route-loader.mjs', '--test', './test/helpers/icp-from-url-route-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 3/)
})
