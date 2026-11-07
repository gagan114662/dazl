// #908 regression: the recovery drill's sign-up password must pass validatePassword on every run, not about 98% of them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { drillPassword } from '../scripts/backup/drill-password.mts'
import { validatePassword } from '../lib/validate.ts'

test('the recovery drill password is always valid and never repeats', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 5000; i++) {
    const pw = drillPassword()
    assert.equal(validatePassword(pw), null, pw)
    seen.add(pw)
  }
  assert.equal(seen.size, 5000)
})
