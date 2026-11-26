import test from 'node:test'
import assert from 'node:assert/strict'
import { requestTarget } from '../lib/scan/request-target.ts'
import { icpTextFor } from '../lib/scan/score.ts'
import { normalizeIcp, icpLoss, type Icp } from '../lib/scan/icp.ts'
import { lookalikeOf } from '../lib/scan/lookalike-block.ts'
import { dropKnown, accountKeys, keyHash } from '../lib/scan/lookalike-discovery.ts'

const profile: Icp = { summary: 'Old buyers', who: ['Old role'], industries: [], sizes: [], where: ['Old city'], signals: [], exclude: ['existing customers'] }

test('query-derived long target survives normalization and resubmission without a lossy self-generated profile', () => {
  const query = 'Independent design studios '.repeat(16) + 'Exclude Acme and competitors.'
  const projected = requestTarget(query, profile, false)!
  const normalized = normalizeIcp(projected)!
  assert.deepEqual(icpLoss(projected), [])
  assert.deepEqual(normalized, projected)
  assert.ok(icpTextFor(normalized, query).includes('Exclude Acme and competitors.'))
})

test('a new query drops old market and time constraints while explicit review retains them', () => {
  const old = { ...profile, country: 'CA', language: 'fr', window_days: 7 }
  const query = 'Music teachers in Portugal with an event in the last 90 days'
  const fresh = requestTarget(query, old, false)!
  assert.equal(fresh.country, undefined, 'old Canadian market must not constrain the new request')
  assert.equal(fresh.language, undefined, 'old language must not constrain the new request')
  assert.equal(fresh.window_days, undefined, 'old seven-day window must not override the new request')
  assert.deepEqual(fresh.exclude, profile.exclude)
  assert.deepEqual(requestTarget(query, old, true), old)
})

test('the full request field refuses lossy or non-text client input', () => {
  assert.ok(icpLoss({ ...profile, request: 'x'.repeat(601) }).some(x => x.field === 'request'))
  assert.ok(icpLoss({ ...profile, request: ['not text'] }).some(x => x.field === 'request'))
})

test('fresh targeting retains supplied-account exclusions without inheriting positive lookalike features', () => {
  const block = { v: 1 as const, f: [{ d: 'l' as const, t: 'old city', n: 5, x: 2 }], p: 5, q: 5, h: { p: 1, b: 0.5, n: 10 }, k: { c: accountKeys({ name: 'Existing customer', domain: 'customer.example' }).map(keyHash).join(''), x: '', n: '' } }
  const projected = requestTarget('Guitar schools in Lisbon', { ...profile, lookalike: block }, false)!
  const la = lookalikeOf({ icp: JSON.stringify(normalizeIcp(projected)) })
  assert.ok(la && la !== 'unreadable')
  assert.deepEqual(la.k, block.k)
  assert.deepEqual(la.f, [])
  assert.equal(dropKnown(la, [{ company: 'Existing customer', website: 'https://customer.example' }]).kept.length, 0)
})

test('grading sees the full request without storing its duplicate in the profile', () => {
  const query = 'Independent design studios '.repeat(16) + 'Exclude existing competitors.'
  const projected = requestTarget(query, profile, false)!
  assert.ok(icpTextFor(projected, query).includes('Exclude existing competitors.'))
  assert.equal(Object.hasOwn(projected, 'request'), false)
})
