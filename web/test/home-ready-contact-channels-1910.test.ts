import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('#1910 Home and the scan require a named work email for Ready', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const run = spawnSync(process.execPath, [
    '--experimental-strip-types', '--no-warnings',
    '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/scan-route-loader.mjs',
    './test/helpers/home-ready-contact-channels-1910-runtime.mts',
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(run.status, 0, [run.error, run.stdout, run.stderr].filter(Boolean).join('\n'))
})
