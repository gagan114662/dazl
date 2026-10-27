// Location agreement before a company gets evidence or contacts. Pure functions and stubbed verifier runs; pages are INVENTED.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { geoTerms, namesPlace, otherUsState, placeAgreement } from '../lib/scan/place-agreement.ts'
import { verifyLeads } from '../lib/scan/runner.ts'

test('terms: NYC expands to its boroughs, London to the UK names; no geography means no demand', () => {
  assert.ok(geoTerms(['New York City']).includes('brooklyn') && geoTerms(['New York City']).includes('nyc'))
  assert.ok(geoTerms(['London', 'UK']).includes('united kingdom'))
  assert.deepEqual(geoTerms([]), []); assert.equal(placeAgreement('anything at all', []), 'no_geography')
})
test('agreement: a text naming the place agrees; another US state is a mismatch; a text naming no place is unconfirmed', () => {
  const W = ['New York City']
  assert.equal(placeAgreement('Dent Blanche - 57 W 57th St, New York, NY 10019', W), 'agrees')
  assert.equal(placeAgreement('Our new Brooklyn office opens soon', W), 'agrees')
  assert.equal(placeAgreement('Dent Blanche Dental, 8500 Whittier Blvd, Pico Rivera, CA 90660', W), 'mismatch')
  assert.equal(placeAgreement('Dent Blanche is a modern dental practice', W), 'unconfirmed')
  assert.equal(placeAgreement('Dent Blanche, Pico Rivera, California', ['California']), 'agrees', 'the requested state is never a mismatch')
  assert.equal(otherUsState('Springfield, IL', geoTerms(['Ohio'])), 'illinois'); assert.equal(namesPlace('London, UK', geoTerms(['London'])), true)
  assert.equal(namesPlace('Londonderry', geoTerms(['London'])), false, 'whole words only')
})
const Q = 'Dent Blanche is opening a second location on West 57th Street'
const dayStr = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
const cand = { name: '', company: 'Dent Blanche', contact: null, signal: 'second location', source_url: 'https://news.example/db', score: 70, excerpt: Q, event_date: dayStr(10) }
const page = (extra: string) => async () => ({ text: `Posted ${dayStr(10)}. ${Q}. ${extra} ${'The practice welcomes families. '.repeat(10)}`, title: 'Dent Blanche expands', retrievedAt: 1 })
test('verifier: a same-name practice in another state is NOT attached (location_mismatch); a page with no place is location_unconfirmed; the right place verifies; no geography changes nothing', async () => {
  const W = ['New York City']
  const wrong = await verifyLeads([cand], page('Visit us at 8500 Whittier Blvd, Pico Rivera, CA 90660.'), new Date(), undefined, null, undefined, undefined, W)
  assert.equal(wrong.leads.length, 0); assert.equal(wrong.review[0].review_reason, 'location_mismatch')
  const none = await verifyLeads([cand], page(''), new Date(), undefined, null, undefined, undefined, W)
  assert.equal(none.leads.length, 0); assert.equal(none.review[0].review_reason, 'location_unconfirmed')
  const right = await verifyLeads([cand], page('Visit us at 57 W 57th St, New York, NY 10019.'), new Date(), undefined, null, undefined, undefined, W)
  assert.equal(right.leads.length, 1)
  const global = await verifyLeads([cand], page(''))
  assert.equal(global.leads.length, 1, 'a request with no place makes no demand')
})
