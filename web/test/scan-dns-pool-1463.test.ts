// #1463: test/helpers/scan-dns-pool-runtime.mts in its own process, with Node's default 4-thread libuv pool pinned.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('#1463 scan DNS never holds the libuv pool that serves the app\'s static chunks', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, UV_THREADPOOL_SIZE: '4' }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--test', './test/helpers/scan-dns-pool-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1\b/)
  assert.match(r.stdout, /SCAN_DNS reads=/)
})
