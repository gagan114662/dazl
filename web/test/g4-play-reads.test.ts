import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('play and inbox entity reads enforce workspace ownership', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/g4-play-reads-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8' })
  assert.ifError(run.error)
  assert.equal(run.status, 0, run.stdout + run.stderr)
})
