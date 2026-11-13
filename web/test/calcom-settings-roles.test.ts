// #367 review at 0d2ff9d4 (F5): the Cal.com settings GET says whether the caller may configure, and the panel shows its
// set-up, rotate and reconciliation controls by that flag (and by the server's meeting-over rule), not by secret_hidden.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('../', import.meta.url))

test('GET /api/settings/calcom returns can_configure = can(role, configure) for every role, with and without a secret (real sessions)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/workspace-session-loader.mjs', '--test', './test/helpers/calcom-settings-roles-runtime.mts'], { cwd: web, env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /CALCOM ROLES ok/)
})

test('the panel gates its controls on can_configure and the shared reconcileActions rule, never on secret_hidden', () => {
  const src = readFileSync(new URL('../app/app/settings/calcom-panel.tsx', import.meta.url), 'utf8')
  assert.match(src, /import \{ reconcileActions, type BookingStatus as Status \} from '@\/lib\/calcom\/outcome-rules'/)
  assert.match(src, /const canConfigure = st\.can_configure === true/)
  assert.match(src, /reconcileActions\(b, canConfigure, nowS\)/)
  assert.match(src, /\{canConfigure && <button [^>]*onClick=\{rotate\}>Rotate secret<\/button>\}/)
  assert.match(src, /\) : canConfigure \? \(\s*<button className="btn-primary" onClick=\{rotate\}>Set up the webhook<\/button>/)
  // secret_hidden only decides whether to print the secret or the "only admins and owners" note
  assert.deepEqual(src.match(/secret_hidden/g)?.length, 2, 'the type field and the one display check')
  assert.doesNotMatch(src, /!st\.secret_hidden/)
  assert.doesNotMatch(src, /start_at \* 1000 <=/, 'no start-time based held / no-show rule in the panel')
})
