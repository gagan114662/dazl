// #1463: the real proxy (web/proxy.ts) under a failed or stalled session check: test/helpers/proxy-gate-runtime.mts, run in its own
// process with the tenant-route loader (it resolves the proxy's '@/' imports and next/server) so getDb() is this run's store alone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('#1463 proxy fails closed on a failed or stalled session check, keeps the session cookie, and still passes a good session', () => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/proxy-gate-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 5\b/)
  assert.match(r.stdout, /# fail 0\b/)
})
