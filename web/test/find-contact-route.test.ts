import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('real find-contact route, crawler and stores run against a loopback fixture company (refusals, click path, identity, robots)', () => {
  // Isolated child: fixed auth/db loader, net fence, and only the https transport mapped to a loopback fixture server.
  const web = fileURLToPath(new URL('../', import.meta.url))
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/sequence-route-loader.mjs',
    '--test', './test/helpers/find-contact-route-runtime.mts',
  ], { cwd: web, env, encoding: 'utf8', timeout: 60000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /# pass 4/)
})
