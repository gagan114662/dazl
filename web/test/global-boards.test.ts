// Job boards for places beyond London / New York / US states / the UK: "<City>, <Country>" in the request now selects the posting by its location text. Stub boards only, invented companies.
import test from 'node:test'
import assert from 'node:assert/strict'
import { collectEvidenceReport } from '../lib/sources/index.ts'
import { genericPlace, placeIn } from '../lib/sources/jobboards.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const day = (n: number) => Date.now() - n * 86_400_000
const lever = (loc: string, title = 'Sales Executive', co = 'Gulfline') => [{ text: title, hostedUrl: `https://jobs.lever.co/${co.toLowerCase()}/1`, createdAt: day(5), categories: { location: loc, allLocations: [loc] }, descriptionPlain: `${co} is hiring a ${title} to grow our team and win new customers in the region. You will own the pipeline from first call to close. ` + 'x'.repeat(40) }]
const run = (query: string, loc: string) => {
  const http: SafeGet = async url => url === 'https://api.lever.co/v0/postings/gulfline?mode=json' ? { status: 200, body: JSON.stringify(lever(loc)) } : { status: 404, body: '' }
  return collectEvidenceReport({ adapters: ['jobboards'], feeds: [], pages: [] }, query, http, 5000, ['https://jobs.lever.co/gulfline'])
}

test('genericPlace: "<City>, <Country>" anywhere is a place; a bare word, a US county or no country is not', () => {
  for (const [q, city] of [['marketing agencies in Toronto, Canada hiring sales staff', 'Toronto'], ['brokers in Gurugram India hiring', 'Gurugram'], ['logistics firms in Dubai, UAE hiring drivers', 'Dubai'], ['Berlin Germany cafes hiring baristas', 'Berlin'], ['hiring in Mexico City, Mexico', 'Mexico City']]) assert.equal(genericPlace(q)?.name, city, q)
  for (const q of ['companies hiring sales staff', 'Find Startups in Smith County', 'hiring in Berlin']) assert.equal(genericPlace(q), null, q)
  assert.equal(placeIn('hiring sales staff in London UK')?.name, 'London', 'the specific places still win')
})
test('a posting is in the place by its location text: the city as a whole word, and no other country', () => {
  const p = genericPlace('hiring sales staff in Toronto, Canada')!
  for (const l of ['Toronto, ON, Canada', 'Toronto', 'Toronto, Ontario']) assert.ok(p.ok(l), l)
  for (const l of ['Toronto, Ohio, United States', 'Remote', 'Vancouver, BC, Canada', 'North Toronto Heights, United States', '']) assert.ok(!p.ok(l), l)
})
test('END TO END: boards are read for three countries (Canada, India, UAE) and a posting elsewhere is dropped', async () => {
  for (const [query, loc, other] of [['Find marketing agencies in Toronto, Canada hiring sales staff', 'Toronto, ON, Canada', 'Calgary, AB, Canada'], ['Find brokers in Gurugram, India hiring sales staff', 'Gurugram, Haryana, India', 'Mumbai, Maharashtra, India'], ['Find logistics firms in Dubai, UAE hiring sales staff', 'Dubai - United Arab Emirates', 'Abu Dhabi - United Arab Emirates']] as const) {
    const ok = await run(query, loc); assert.equal(ok.items.length, 1, `${query}: ${JSON.stringify(ok.runs)}`)
    const no = await run(query, other); assert.equal(no.items.length, 0, `${query} vs ${other}`)
  }
})
