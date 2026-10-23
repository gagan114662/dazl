import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('status route kick behavior: ordinary poll claims, passive poll only observes (reap still writes)', () => {
  const web = fileURLToPath(new URL('../', import.meta.url))
  const env = { ...process.env, SITECRAWL_ENABLED: '0' } as NodeJS.ProcessEnv
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/status-route-loader.mjs',
    '--test', './test/helpers/status-route-runtime.mts',
  ], { cwd: web, env, encoding: 'utf8', timeout: 60000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /# pass 4/)
})
