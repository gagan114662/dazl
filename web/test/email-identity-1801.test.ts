// #1801: one free trial per person. trialIdentity canonicalises an address to the mailbox it delivers to:
// lowercase, +tags stripped everywhere, dots removed on Gmail only, googlemail folded into gmail. These
// cases pin the exact semantics the trial grant's canonicalMailbox has today (including its two pinned
// shapes from trial-password-first-scan-1095.test.ts), so swapping the grant onto this function changes
// no decision — it only makes the definition shared and testable.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trialIdentity } from '../lib/auth/email-identity.ts'

const CASES: [string, string][] = [
  // plain and case/whitespace
  ['gagan@gmail.com', 'gagan@gmail.com'],
  ['Gagan@Gmail.com', 'gagan@gmail.com'],
  ['  gagan@gmail.com  ', 'gagan@gmail.com'],
  // Gmail aliases of one mailbox
  ['gagan+2@gmail.com', 'gagan@gmail.com'],
  ['g.agan@gmail.com', 'gagan@gmail.com'],
  ['g.a.g.a.n@gmail.com', 'gagan@gmail.com'],
  ['gagan+promo@gmail.com', 'gagan@gmail.com'],
  ['gagan+@gmail.com', 'gagan@gmail.com'],
  ['gagan+a+b@gmail.com', 'gagan@gmail.com'],
  ['gagan.sharma+work@gmail.com', 'gagansharma@gmail.com'],
  // googlemail is Gmail
  ['gagan@googlemail.com', 'gagan@gmail.com'],
  ['g.a.g.a.n+promo@googlemail.com', 'gagan@gmail.com'],
  ['P.a.t+x@GoogleMail.com', 'pat@gmail.com'], // pinned shape from the trial-grant suite
  // other providers: tags strip, dots stay
  ['a.b+c@outlook.com', 'a.b@outlook.com'], // pinned shape from the trial-grant suite
  ['pat+news@outlook.com', 'pat@outlook.com'],
  ['first.last+tag@company.com', 'first.last@company.com'],
  ['firstlast@company.com', 'firstlast@company.com'],
  ['USER+TAG@COMPANY.COM', 'user@company.com'],
  ['user+tag@sub.company.com', 'user@sub.company.com'],
  // dots in the DOMAIN never fold, on any provider
  ['gagan@g.mail.com', 'gagan@g.mail.com'],
  // degenerate inputs keep the grant's current behaviour exactly
  ['', '@'],
  ['no-at-sign', 'no-at-sign@'],
  ['+tag@gmail.com', '@gmail.com'],
]

test('trialIdentity canonicalises every case', () => {
  assert.ok(CASES.length >= 20, 'the brief asks for 20+ cases')
  for (const [input, want] of CASES) assert.equal(trialIdentity(input), want, `trialIdentity(${JSON.stringify(input)})`)
})

test('every Gmail spelling of one mailbox shares one key', () => {
  const key = trialIdentity('gagan@gmail.com')
  for (const alias of ['gagan+2@gmail.com', 'g.agan@gmail.com', 'g.a.g.a.n@googlemail.com', 'GAGAN+news@GoogleMail.com']) {
    assert.equal(trialIdentity(alias), key, alias)
  }
})

test('different people keep different keys', () => {
  assert.notEqual(trialIdentity('first.last@company.com'), trialIdentity('firstlast@company.com'), 'dots are different people off Gmail')
  assert.notEqual(trialIdentity('gagan@company.com'), trialIdentity('gagan@gmail.com'), 'same local part, different mailbox provider')
  assert.notEqual(trialIdentity('gagan@gmail.com'), trialIdentity('gagan2@gmail.com'))
  assert.notEqual(trialIdentity('gagan+2@company.com'), trialIdentity('gagan2@company.com'), 'a stripped tag must not collide with a real suffix')
})
