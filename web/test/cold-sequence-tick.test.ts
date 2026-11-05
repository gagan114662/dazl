import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// #414: the real tick route sends the first touch, auto-enrolls it under the accepted policy and sends the day-3 and
// day-7 no-reply steps once each; a reply stops it; manual mode enrolls nothing; a drained first touch enrolls too
// (test/helpers/cold-sequence-tick-runtime.mts).
test('tick route: authorized cold follow-up sequences enroll and run from the scheduler', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/cold-sequence-tick-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1/)
})
