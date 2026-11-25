// #1726: the zero-lead block (UI part). The copy function and the component live in
// app/app/leads/no-leads-help.tsx; node --test cannot strip .tsx, so the tests run in a child
// process with the repo's tsx loader, the same pattern as the #1571 runtime. The black-box rules
// are written at the top of test/helpers/no-leads-help-1726-runtime.mts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('#1726 zero-lead block: the plain reason and 1-2 next steps, never the bare line alone (component and copy; no network)', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tsx-loader.mjs', '--test-reporter=tap', '--test', './test/helpers/no-leads-help-1726-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
