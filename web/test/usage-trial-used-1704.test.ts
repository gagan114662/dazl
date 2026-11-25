// #1704 follow-up: GET /api/usage reports the account's real used free searches (test/helpers/usage-trial-used-runtime.mts).
// The runtime loads the route through the tenant route loader, so it runs in its own process. It asserts on its exit status
// and its own marker line, not on the reporter's summary format.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('#1704 GET /api/usage: the trial counter says what the account really used (Google account, QA account)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/usage-trial-used-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /USAGE_TRIAL_USED ok/)
})
