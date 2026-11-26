import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('#1910 outreach routes hold index-dated Discovery leads at draft creation and approval', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const run = spawnSync(process.execPath, [
    '--experimental-strip-types', '--no-warnings',
    '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/sequence-route-loader.mjs',
    './test/helpers/discovery-ready-draft-route-1910-runtime.mts',
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(run.status, 0, [run.error, run.stdout, run.stderr].filter(Boolean).join('\n'))
})
