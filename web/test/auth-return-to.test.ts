import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { safeReturnTo, withReturnTo } from '../lib/return-to.ts'
import { mintClaim, verifyClaim } from '../lib/preview-claim.ts'

// #416: the destination kept through sign-in is only ever a path inside the app, and an invitation link opens its page
// only for the account it was made for, unaltered and before it expires. Pure; synthetic keys and addresses.

test('#416 return destination: /app paths only; every open-redirect shape is refused', () => {
  for (const [raw, want] of [['/app', '/app'], ['/app/plays?id=7', '/app/plays?id=7'], ['/app/leads?job_id=ab#x', '/app/leads?job_id=ab'], ['/app/claim?t=a.b', '/app/claim?t=a.b']] as const) assert.equal(safeReturnTo(raw), want, raw)
  for (const raw of ['', 'app', '//evil.example/app', '///evil.example', 'https://evil.example/app', 'javascript:alert(1)', '/\\evil.example', '/app\\..\\..\\x', '/apple', '/application', '/app/../admin', '/%2e%2e/admin', '/app/%2e%2e/%2e%2e/admin', '/app\n/x', '/app\t', `/app/${'x'.repeat(600)}`, null, undefined, 42, ['/app']])
    assert.equal(safeReturnTo(raw), null, JSON.stringify(raw))
  assert.equal(withReturnTo('/sign-in', '/app/plays?id=7'), '/sign-in?next=%2Fapp%2Fplays%3Fid%3D7')
  assert.equal(withReturnTo('/sign-in?error=x', '/app'), '/sign-in?error=x&next=%2Fapp')
  assert.equal(withReturnTo('/sign-in', 'https://evil.example'), '/sign-in')
})

test('#416 invitation link: opens its page for its own recipient; foreign, expired and tampered links fail', () => {
  const master = randomBytes(32), NOW = 1_800_000_000
  const t = mintClaim(master, { to: 'Owner@Prospect.example', path: '/app/plays?id=7', exp: NOW + 3600 })
  assert.deepEqual(verifyClaim(master, t, { email: 'owner@prospect.example' }, NOW), { ok: true, path: '/app/plays?id=7' })
  assert.deepEqual(verifyClaim(master, t, { email: 'someone@else.example' }, NOW), { ok: false, reason: 'other_account' })
  assert.deepEqual(verifyClaim(master, t, { email: 'owner@prospect.example' }, NOW + 3600), { ok: false, reason: 'expired' })
  assert.deepEqual(verifyClaim(randomBytes(32), t, { email: 'owner@prospect.example' }, NOW), { ok: false, reason: 'tampered' }, 'another deployment\'s key')
  // Edited payload (a longer expiry, another recipient or another page) with the original signature.
  const [body, sig] = t.split('.')
  for (const change of [{ exp: NOW + 10 ** 6 }, { to: 'someone@else.example' }, { path: '/app/settings' }]) {
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), ...change })).toString('base64url')
    assert.deepEqual(verifyClaim(master, `${edited}.${sig}`, { email: 'owner@prospect.example' }, NOW), { ok: false, reason: 'tampered' }, JSON.stringify(change))
  }
  for (const bad of ['', 'x', 'a.b.c', `${body}.`, null, 'x'.repeat(3000)]) assert.equal(verifyClaim(master, bad, { email: 'owner@prospect.example' }, NOW).ok, false, String(bad))
  assert.throws(() => mintClaim(master, { to: 'a@b.example', path: 'https://evil.example', exp: NOW + 60 }), /inside the app/)
})
