// Location agreement before a company gets evidence or contacts. Pure functions and stubbed verifier runs; pages are INVENTED.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { geoTerms, namesPlace, otherState as otherUsState, placeAgreement } from '../lib/scan/place-agreement.ts'
import { verifyLeads } from '../lib/scan/runner.ts'

test('terms: NYC expands to its boroughs, London to the UK names; no geography means no demand', () => {
  assert.ok(geoTerms(['New York City']).includes('brooklyn') && geoTerms(['New York City']).includes('nyc'))
  assert.deepEqual(geoTerms(['London', 'UK']), ['london', 'greater london'], 'the country beside a city is context, not a match')
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
test('verifier: a same-name practice in another state is NOT attached (location_mismatch); a page with no place is not rejected; the right place verifies; no geography changes nothing', async () => {
  const W = ['New York City']
  const wrong = await verifyLeads([cand], page('Visit us at 8500 Whittier Blvd, Pico Rivera, CA 90660.'), new Date(), undefined, null, undefined, undefined, W)
  assert.equal(wrong.leads.length, 0); assert.equal(wrong.review[0].review_reason, 'location_mismatch')
  const none = await verifyLeads([cand], page(''), new Date(), undefined, null, undefined, undefined, W)
  assert.equal(none.leads.length, 1, 'a page naming no place is not rejected by the evidence gate (contacts are stricter)')
  const right = await verifyLeads([cand], page('Visit us at 57 W 57th St, New York, NY 10019.'), new Date(), undefined, null, undefined, undefined, W)
  assert.equal(right.leads.length, 1)
  const global = await verifyLeads([cand], page(''))
  assert.equal(global.leads.length, 1, 'a request with no place makes no demand')
})

test('city-level geography: "New York, NY" / "New York City" rejects Rome, NY and other New York towns; boroughs and the city line agree; a state-level request is not city-scoped', () => {
  for (const W of [['New York, NY'], ['New York City'], ['NYC']]) {
    assert.equal(placeAgreement('Dent Blanche, 8500 Main St, Rome, NY 13440', W), 'mismatch', W.join())
    assert.equal(placeAgreement('Visit us in Albany, New York', W), 'mismatch')
    assert.equal(placeAgreement('Smile Studio, 57 W 57th St, New York, NY 10019', W), 'agrees')
    assert.equal(placeAgreement('Our Brooklyn, NY office', W), 'agrees')
    assert.equal(placeAgreement('Offices in Rome, NY and Manhattan', W), 'mismatch', 'another New York town is named and no NYC address binds the company to the city')
  }
  assert.equal(placeAgreement('Dent Blanche, Rome, NY 13440', ['New York']), 'unconfirmed', 'bare "New York" is the state: not city-scoped, not a conflict')
  assert.equal(placeAgreement('Dent Blanche, Rome, New York', ['New York']), 'agrees')
  assert.equal(placeAgreement('Acme Ltd, London, Ontario, Canada', ['London', 'UK']), 'mismatch')
  assert.equal(placeAgreement('Acme Ltd, London, UK', ['London', 'UK']), 'agrees')
})
test('verifier: a Rome, NY page is not attached to a New York City request', async () => {
  const wrong = await verifyLeads([cand], page('Visit us at 8500 Main St, Rome, NY 13440.'), new Date(), undefined, null, undefined, undefined, ['New York, NY'])
  assert.equal(wrong.leads.length, 0); assert.equal(wrong.review[0].review_reason, 'location_mismatch')
})

// Instinct's wrong-city reproductions for #230 (each its own test).
const LON = ['London', 'UK']
test('wrong city: "Manchester, England" is not London', () => { assert.equal(placeAgreement('Acme Ltd, 5 Deansgate, Manchester, England', LON), 'mismatch'); assert.equal(placeAgreement('Acme Ltd, 5 Deansgate, Manchester, England', ['London UK']), 'mismatch') })
test('wrong city: London, Ontario plus an unrelated "United Kingdom news" mention is not London, UK', () => {
  assert.equal(placeAgreement('Acme Dental, 12 Dundas St, London, Ontario, Canada. Latest United Kingdom news: ...', LON), 'mismatch')
  assert.equal(placeAgreement('Acme Dental, London, ON N6A 1A1. United Kingdom', LON), 'mismatch')
})
test('wrong city: an Albany, NY company page with an incidental NYC mention is not New York City', () => {
  for (const W of [['New York City'], ['New York, NY'], ['NYC']]) {
    assert.equal(placeAgreement('Acme Dental, 12 State St, Albany, NY 12207. We also serve clients from NYC.', W), 'mismatch', W.join())
    assert.equal(placeAgreement('Acme Dental, Rome, NY. Our founder grew up in Brooklyn.', W), 'mismatch', W.join())
  }
})
test('wrong city: a footer / other-office / country mention does not bind the company to London', () => {
  assert.equal(placeAgreement('Headquarters: 10 Wellington St, Leeds, UK. Satellite desk in London.', LON), 'mismatch')
  assert.equal(placeAgreement('Acme is a United Kingdom company, offices in Glasgow, Scotland', LON), 'mismatch')
  assert.equal(placeAgreement('Acme is a United Kingdom company', LON), 'unconfirmed', 'the country alone never agrees')
})
test('right city still agrees: London postcode / "London, UK" address and a New York, NY ZIP address, even beside another office', () => {
  assert.equal(placeAgreement('Acme Ltd, 1 Old Street, London EC1V 9HX', LON), 'agrees'); assert.equal(placeAgreement('Acme Ltd, London, UK', LON), 'agrees')
  assert.equal(placeAgreement('Acme Ltd, 1 Old Street, London EC1V 9HX. Second office: Leeds, UK', LON), 'agrees')
  assert.equal(placeAgreement('Smile Studio, 57 W 57th St, New York, NY 10019. Second office in Albany, NY', ['New York City']), 'agrees', 'the company\'s own NYC address binds it')
})

test('Instinct c3c505e cases: the company is bound to the city by its own text, not by an unrelated mention elsewhere', () => {
  const LON = ['London, UK']
  assert.notEqual(placeAgreement('Dent Blanche, East London, South Africa. Dental practice owner.', LON), 'agrees')
  assert.equal(placeAgreement('Dent Blanche, East London, South Africa. Dental practice owner.', LON), 'mismatch')
  assert.equal(placeAgreement('Dent Blanche in London, Ontario. News from London, UK.', LON), 'mismatch')
  assert.equal(placeAgreement('Dental Studio based in Albany, NY. News: New York, NY 10001.', ['NYC']), 'mismatch')
  // controls: a real street / postcode address of the company still binds it, even beside another office
  assert.equal(placeAgreement('Dent Blanche in London, Ontario. Our UK office: 1 Old Street, London EC1V 9HX.', LON), 'agrees')
  assert.equal(placeAgreement('Dental Studio, Albany, NY. Flagship: 57 W 57th St, New York, NY 10019.', ['NYC']), 'agrees')
  assert.equal(placeAgreement('Acme Ltd, London, UK', LON), 'agrees')
})
