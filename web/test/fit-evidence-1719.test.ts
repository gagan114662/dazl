// #1719 finding 3: a dental search in Toronto ran with the saved "small marketing agencies" profile, and the fit text
// was the agency's. The rule that stops it is in lib/scan/profile-match.ts: a saved profile is replaced only on a
// conflict the request states verbatim, and the field the request leaves unstated is carried. This pins that rule, so a
// later change cannot quietly let an invented buyer or place into a search. No network, no model: `complete` is a stub.
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSearchProfile } from '../lib/scan/profile-match.ts'
import type { Icp } from '../lib/scan/icp.ts'

const saved: Icp = { summary: 'small marketing agencies', who: ['marketing agency owners'], industries: ['marketing agencies'], sizes: ['small'], where: ['Toronto'], signals: ['hiring SDRs'], exclude: [], country: 'CA', language: 'en' }
const query = 'Dental clinics in Toronto that are hiring'
const reply = (json: unknown) => (async () => JSON.stringify(json)) as never
const resolve = (json: unknown) => resolveSearchProfile(query, saved, 'test-key', undefined, reply(json))

test('#1719 a replacement that quotes a buyer the request never names is refused, so no profile is invented for a dental search', async () => {
  await assert.rejects(() => resolve({ decision: 'replace', buyer: 'marketing agency owners', place: 'Toronto', profile: { industries: ['marketing agencies'] } }),
    /search_profile:constraint_not_quoted/)
})

test('#1719 a replacement that quotes a place the request never names is refused', async () => {
  await assert.rejects(() => resolve({ decision: 'replace', buyer: 'Dental clinics', place: 'Austin', profile: { industries: ['dental clinics'] } }),
    /search_profile:constraint_not_quoted/)
})

test('#1719 a replacement that quotes neither buyer nor place is refused', async () => {
  await assert.rejects(() => resolve({ decision: 'replace', buyer: null, place: null, profile: { industries: ['dental clinics'] } }),
    /search_profile:incomplete_replacement/)
})

test('#1719 keep carries the saved profile unchanged', async () => {
  const got = await resolve({ decision: 'keep' })
  assert.equal(got.source, 'carried')
  assert.deepEqual(got.profile, saved)
})

test('#1719 a place-only replacement keeps the saved buyer fields and takes the requested place verbatim', async () => {
  const got = await resolve({ decision: 'replace', buyer: null, place: 'Toronto', profile: { industries: ['dental clinics'], sizes: 'small', signals: ['hiring'], exclude: [] } })
  assert.equal(got.source, 'inferred')
  assert.deepEqual(got.profile.where, ['Toronto'], 'the requested place, spelled as the request spells it')
  assert.deepEqual(got.profile.who, saved.who, 'the buyer the request never named is carried, not invented')
})

test('#1719 a buyer-only replacement keeps the saved place', async () => {
  const got = await resolve({ decision: 'replace', buyer: 'Dental clinics', place: null, profile: { industries: ['dental clinics'], sizes: 'small', signals: ['hiring'], exclude: [] } })
  assert.equal(got.source, 'inferred')
  assert.deepEqual(got.profile.who, ['Dental clinics'])
  assert.deepEqual(got.profile.where, saved.where, 'the place the request never named is carried')
})
