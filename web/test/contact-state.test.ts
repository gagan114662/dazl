// #384: provenance vs deliverability vs person-route. Synthetic addresses; resolvers are stubs (no DNS, no network).
import test from 'node:test'
import assert from 'node:assert/strict'
import { contactState, refreshDue, verifyContact, localPartMatchesPerson, STALE_PUBLICATION_DAYS } from '../lib/outreach/contact-state.ts'

const NOW = 1_800_000_000, DAY = 86400
const pub = (extra: object = {}) => ({ sourceUrl: 'https://harbor.example/contact', ...extra })
const person = { name: 'Fay Buyer' }

test('a generic recruiting/support inbox cannot become the founder route', () => {
  for (const e of ['careers@harbor.example', 'jobs@harbor.example', 'support@harbor.example', 'hr@harbor.example']) {
    const s = contactState({ email: e, person: { name: 'Fay Buyer' }, published: pub() }, NOW)
    assert.equal(s.personBound, 'no', e); assert.equal(s.roleRelevant, 'no', e); assert.equal(s.reach, 'none', e)
  }
})

test('published provenance is not person-binding and not deliverability', () => {
  const s = contactState({ email: 'office@harbor.example', person, published: pub() }, NOW)
  assert.equal(s.sourcePublished, 'yes'); assert.equal(s.personBound, 'unknown'); assert.equal(s.deliverability, 'unknown'); assert.equal(s.reach, 'email_uncertain')
})

test('the address spells the person, or the page names them next to it: person-bound', () => {
  assert.equal(contactState({ email: 'fay.buyer@harbor.example', person, published: pub() }, NOW).personBound, 'yes')
  assert.equal(contactState({ email: 'fbuyer@harbor.example', person, published: pub() }, NOW).personBound, 'yes')
  assert.equal(contactState({ email: 'office@harbor.example', person, published: pub({ excerpt: 'Reach Fay Buyer at office@harbor.example' }) }, NOW).personBound, 'yes')
  assert.equal(localPartMatchesPerson('fa@harbor.example', 'Fay Buyer'), false)
  assert.equal(localPartMatchesPerson('bob@harbor.example', 'Fay Buyer'), false)
})

test('an email published years ago keeps its age and is not "ready"; unknown age stays unknown', () => {
  const old = contactState({ email: 'fay@harbor.example', person, published: pub({ publishedAt: NOW - 3 * 366 * DAY }), check: { checkedAt: NOW, mx: 'has_mx', mailbox: 'accepted' } }, NOW)
  assert.ok(old.ageDays! > STALE_PUBLICATION_DAYS); assert.equal(old.stale, true); assert.equal(old.reach, 'email_uncertain'); assert.ok(old.notes.some(n => /year/.test(n)))
  const undated = contactState({ email: 'fay@harbor.example', person, published: pub() }, NOW)
  assert.equal(undated.ageDays, null); assert.equal(undated.stale, false); assert.ok(undated.notes.includes('publication date unknown'))
})

test('invalid domain fails; error leaves it unchecked, not invalid', () => {
  assert.equal(contactState({ email: 'fay@nowhere.example', published: pub(), check: { checkedAt: NOW, mx: 'no_domain' } }, NOW).deliverability, 'invalid')
  assert.equal(contactState({ email: 'fay@nowhere.example', published: pub(), check: { checkedAt: NOW, mx: 'no_mx' } }, NOW).reach, 'none')
  const err = contactState({ email: 'fay@harbor.example', published: pub(), check: { checkedAt: NOW, mx: 'error' } }, NOW)
  assert.equal(err.domain, 'unchecked'); assert.equal(err.deliverability, 'unknown')
})

test('MX alone is not "valid"; catch-all stays uncertain; only a positive mailbox check is valid', () => {
  const base = { email: 'fay@harbor.example', published: pub({ publishedAt: NOW - 10 * DAY }) }
  assert.equal(contactState({ ...base, check: { checkedAt: NOW, mx: 'has_mx' } }, NOW).deliverability, 'unknown')
  const ca = contactState({ ...base, check: { checkedAt: NOW, mx: 'has_mx', mailbox: 'catch_all' } }, NOW)
  assert.equal(ca.deliverability, 'catch_all'); assert.equal(ca.reach, 'email_uncertain')
  assert.equal(contactState({ ...base, check: { checkedAt: NOW, mx: 'has_mx', mailbox: 'rejected' } }, NOW).deliverability, 'invalid')
  const ok = contactState({ ...base, check: { checkedAt: NOW, mx: 'has_mx', mailbox: 'accepted' } }, NOW)
  assert.equal(ok.deliverability, 'valid'); assert.equal(ok.reach, 'email_ready')
})

test('a pattern guess is never published and never verified, whatever the check says', () => {
  const s = contactState({ email: 'fay.buyer@harbor.example', person, guessed: true, check: { checkedAt: NOW, mx: 'has_mx', mailbox: 'accepted' } }, NOW)
  assert.equal(s.sourcePublished, 'no'); assert.notEqual(s.deliverability, 'valid'); assert.notEqual(s.reach, 'email_ready')
})

test('email readiness is distinct from phone-only reachability', () => {
  assert.equal(contactState({ email: null, phone: '+1 212 555 0100' }, NOW).reach, 'phone_only')
  assert.equal(contactState({ email: 'careers@harbor.example', phone: '+1 212 555 0100', published: pub() }, NOW).reach, 'phone_only')
  assert.equal(contactState({ email: null, phone: '12' }, NOW).reach, 'none')
})

test('refreshDue: never checked, old check, or stale publication; none-reach is never refreshed', () => {
  const base = { email: 'fay@harbor.example', published: pub({ publishedAt: NOW - DAY }) }
  assert.equal(refreshDue(contactState(base, NOW), NOW), true)
  const fresh = contactState({ ...base, check: { checkedAt: NOW - DAY, mx: 'has_mx', mailbox: 'accepted' } }, NOW)
  assert.equal(refreshDue(fresh, NOW), false); assert.equal(refreshDue(fresh, NOW + 40 * DAY), true)
  assert.equal(refreshDue(contactState({ email: 'careers@harbor.example', published: pub() }, NOW), NOW), false)
})

test('verifyContact: resolver errors never become invalid or valid; guesses and non-emails are not probed', async () => {
  let probes = 0
  const deps = { resolveMx: async () => 'has_mx' as const, probeMailbox: async () => { probes++; return 'accepted' as const }, now: NOW }
  assert.equal((await verifyContact({ email: 'fay@harbor.example', published: pub() }, deps)).deliverability, 'valid')
  await verifyContact({ email: 'fay@harbor.example', guessed: true }, deps); await verifyContact({ email: 'not-an-email' }, deps); assert.equal(probes, 1)
  const boom = await verifyContact({ email: 'fay@harbor.example', published: pub() }, { ...deps, resolveMx: async () => { throw new Error('dns down') } })
  assert.equal(boom.deliverability, 'unknown'); assert.equal(boom.domain, 'unchecked')
})
