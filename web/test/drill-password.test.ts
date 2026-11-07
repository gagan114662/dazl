// #908 regression: the recovery drill's sign-up password must pass validatePassword on every run, not about 98% of them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { drillPassword, DRILL_PASSWORD_PREFIX } from '../scripts/backup/drill-password.mts'
import { validatePassword } from '../lib/validate.ts'

test('a bare 24-character base64url password with no digit is rejected (the original flake)', () => {
  const noDigit = 'abcdefghijklmnopqrstuvwx'
  assert.equal(noDigit.length, 24)
  assert.match(noDigit, /^[A-Za-z0-9_-]{24}$/)
  assert.equal(validatePassword(noDigit), 'Password must include letters and numbers')
  // The same shape the drill used to send: randomBytes(18) of zeros encodes to 24 letters, no digit.
  const allLetters = Buffer.alloc(18).toString('base64url')
  assert.equal(allLetters, 'A'.repeat(24))
  assert.notEqual(validatePassword(allLetters), null)
})

test('the prefix alone guarantees a letter and a digit', () => {
  assert.match(DRILL_PASSWORD_PREFIX, /[A-Za-z]/)
  assert.match(DRILL_PASSWORD_PREFIX, /[0-9]/)
})

test('drillPassword is valid even when the random part has no digit at all', () => {
  for (const bytes of [Buffer.alloc(18), Buffer.from('abcdefghijklmnopqr'), Buffer.alloc(18, 0xff)]) {
    const random = bytes.toString('base64url')
    const pw = drillPassword((size) => {
      assert.equal(size, 18)
      return bytes
    })
    assert.equal(pw, `${DRILL_PASSWORD_PREFIX}${random}`)
    assert.match(pw, /[0-9]/)
    assert.equal(validatePassword(pw), null, pw)
  }
})

test('the recovery drill password is always valid and never repeats', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 5000; i++) {
    const pw = drillPassword()
    assert.equal(validatePassword(pw), null, pw)
    seen.add(pw)
  }
  assert.equal(seen.size, 5000)
})
