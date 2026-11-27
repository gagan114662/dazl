import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('#1910: Home holds the captured Austin lead and counts one synthetic lead with a published named buyer', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, SITECRAWL_ENABLED: '1' }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/scan-route-loader.mjs', './test/helpers/austin-ready-replay-1910-runtime.mts',
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr)
})
