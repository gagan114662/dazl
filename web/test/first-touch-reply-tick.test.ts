import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// #413: the real tick route reads first-touch-only threads (paused, never-enabled sending) against a stubbed Gmail,
// honours opt-outs, keeps freshness unknown on a partial sync, and makes zero reads without read consent
// (test/helpers/first-touch-reply-tick-runtime.mts).
test('tick route: first-touch-only reply and opt-out reading is independent of send authority', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/first-touch-reply-tick-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1/)
})
