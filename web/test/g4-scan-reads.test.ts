import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('#830 scan reads enforce the workspace boundary before returning records', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.DB_PATH
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs',
    '--test', './test/helpers/g4-scan-reads-runtime.mts',
  ], { env, cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 60000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
