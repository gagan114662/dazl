// #1715: the rendered save path for the sender form — the 'Saved.' confirmation element and the form's
// disabled-Save hint states, rendered through the real components. node --test cannot strip .tsx, so the
// tests run in a child process with the repo's tsx loader, the same pattern as the #1726 runtime. The
// black-box rules are written at the top of test/helpers/sender-saved-1715-runtime.mts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('#1715 sender save path renders: the Saved. confirmation and the disabled-Save hints (no network)', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tsx-loader.mjs', '--test-reporter=tap', '--test', './test/helpers/sender-saved-1715-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
