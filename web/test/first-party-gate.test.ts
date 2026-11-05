import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The #390 deployment gate (OFF side) runs in its own process with DAZL_FIRST_PARTY_ENABLED explicitly REMOVED from
// the environment - the default every deployment gets unless the owner sets the exact literal '1'.
test('the first-party deployment gate: OFF refuses collection, keeps stop/erase/status (#390)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.DAZL_FIRST_PARTY_ENABLED
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/sequence-route-loader.mjs', '--test', './test/helpers/first-party-gate-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 3/)
})
