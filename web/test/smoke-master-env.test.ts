// Regression for #530's real key-save503: the fence must scrub inherited credentials,
// then the smoke-only bootstrap restores only its generated throwaway master key.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
const fixture = randomBytes(32).toString('base64')
const run = (restore: boolean) => spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', ...(restore ? ['--import', './test/smoke/stripe-test-env.mjs'] : []), '--input-type=module', '-e', "console.log(JSON.stringify({present:!!process.env.DAZL_MASTER_KEY,fixture:process.env.DAZL_MASTER_KEY===process.env.SMOKE_MASTER_B64,other:!!process.env.INHERITED_API_KEY}))"], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, DAZL_MASTER_KEY: 'must-be-scrubbed', INHERITED_API_KEY: 'must-be-scrubbed', SMOKE_MASTER_B64: fixture } })
test('red reproduction: passing a master key before the fence leaves credential storage unavailable', () => {
  const r = run(false); assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { present: false, fixture: false, other: false })
})
test('green: restore generated smoke key after the fence, without restoring other inherited secrets', () => {
  const r = run(true); assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { present: true, fixture: true, other: false })
})
