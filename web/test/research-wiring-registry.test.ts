// E (#1263) in the research engine: which cases ask which registry, and a registry record as a dated Candidate.
import test from 'node:test'
import assert from 'node:assert/strict'
import { registryMarkets, registryCandidate } from '../lib/research/wiring.ts'
import type { ResearchCase } from '../lib/research/types.ts'

const C = (where: string, category: string): ResearchCase => ({ tenant: 't', jobId: 'j', query: 'q', offer: 'o', where, category, windowDays: 90, today: '2026-11-15' })
test('a registry is asked only when the place names its city and the category names its category', () => {
  assert.deepEqual(registryMarkets(C('Austin, TX', 'Roofing contractors')).map(m => `${m.market.city}/${m.market.category}`), ['Austin/roofing'])
  assert.deepEqual(registryMarkets(C('Vancouver, British Columbia', 'Restaurants')).map(m => `${m.market.city}/${m.market.category}`), ['Vancouver/restaurants'])
  assert.deepEqual(registryMarkets(C('Chicago, Illinois', 'Law firms')), [])
  assert.deepEqual(registryMarkets(C('Austin, TX', 'Law firms')), [], 'right city, wrong category')
  assert.deepEqual(registryMarkets(C('North Austinville', 'roofing')), [], 'the city as a whole word')
})
test('a registry record becomes a dated candidate pointing at its own public page', () => {
  const c = registryCandidate({ source: 'socrata-permits:austin', company: 'Acme Roofing', eventKind: 'roofing_permits', eventSummary: '3 roofing permits issued', eventDate: '2026-11-01', eventCount: 3,
    sourceUrl: 'https://abc.austintexas.gov/permit/1', personName: null, personTitle: null, personSourceUrl: null, phone: null, city: 'Austin', region: 'TX', country: 'US', category: 'Roofing' })
  assert.equal(c.dated, 'registry'); assert.equal(c.date, '2026-11-01'); assert.equal(c.url, 'https://abc.austintexas.gov/permit/1'); assert.equal(c.via, 'registry')
})
