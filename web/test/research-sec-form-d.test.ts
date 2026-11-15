// MISSION v2 part E: the SEC Form D source (lib/research/sources/sec-form-d.ts), on REAL recorded EDGAR answers
// (test/fixtures/research-sec-form-d.json, 15 Nov 2026: a search-index page and four filings' primary_doc.xml). No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { formDGroups, formDHits, formDSearchUrl, parseFormD, secFormDSource, usCity, SEC_MIN_GAP_MS } from '../lib/research/sources/sec-form-d.ts'
import type { SafeGet } from '../lib/sources/types.ts'
import type { ResearchCase } from '../lib/research/types.ts'

const FX = JSON.parse(readFileSync(new URL('./fixtures/research-sec-form-d.json', import.meta.url), 'utf8')) as { page: unknown; docs: Record<string, string> }
const SW: ResearchCase = { tenant: 't', jobId: 'j', query: 'software startups in Austin that raised money', offer: 'x', where: 'Austin, Texas', category: 'software startups', windowDays: 90, today: '2026-11-15' }
const doc = (name: RegExp) => Object.values(FX.docs).find(x => name.test(x))!

test('the case decides coverage: a US city plus a category Form D industries mean; roofing, Canada and a bare country are not covered', () => {
  assert.deepEqual(usCity('Austin, Texas'), { city: 'Austin', state: 'TX' }); assert.deepEqual(usCity('Chicago, IL, USA'), { city: 'Chicago', state: 'IL' })
  assert.equal(usCity('Vancouver, British Columbia'), null); assert.equal(usCity('United States'), null); assert.equal(usCity('Berlin, Germany'), null)
  assert.ok(formDGroups(SW).includes('Other Technology'))
  const src = secFormDSource()
  assert.equal(src.covers(SW), true)
  assert.equal(src.covers({ ...SW, category: 'roofing contractors', query: 'roofing contractors in Austin' }), false)
  assert.equal(src.covers({ ...SW, where: 'Toronto, Ontario' }), false)
  const u = new URL(formDSearchUrl('Austin', 'TX', '2026-08-17', '2026-11-15', 100))
  assert.equal(u.origin + u.pathname, 'https://efts.sec.gov/LATEST/search-index')
  assert.deepEqual(Object.fromEntries(u.searchParams), { q: '"Austin"', forms: 'D', dateRange: 'custom', startdt: '2026-08-17', enddt: '2026-11-15', locationCodes: 'TX', from: '100' })
})

test('the search page: new filings in the city only (no D/A amendment, no 3(c) investment fund, no other city)', () => {
  const { hits } = formDHits(FX.page, 'Austin', 'TX')
  const names = hits.map(h => h.company)
  assert.deepEqual(names.sort(), ['ASURE SOFTWARE INC', 'DegreeSight Inc', 'Expressable, Inc.'])
  assert.ok(hits.every(h => /^\d{4}-\d{2}-\d{2}$/.test(h.fileDate) && h.location === 'Austin, TX'))
})

test('the filing document: industry, amounts, the executive officer it names; a pooled investment fund is a fund', () => {
  const e = parseFormD(doc(/Expressable/))
  assert.equal(e.industry, 'Other Technology'); assert.equal(e.amendment, false); assert.equal(e.fund, false)
  assert.equal(e.person?.name, 'Nicholas Barbara'); assert.match(e.person!.title, /Executive Officer/)
  assert.ok(e.sold! > 0)
  assert.equal(parseFormD(doc(/Pooled Investment Fund/)).fund, true)
})

test("the source end to end: A's Candidate, dated by the filing day, the filing's own page, the facts and the named officer in the snippet; paced; failures are notes", async () => {
  let paced = 0
  const src = secFormDSource({ pace: async () => { paced++ } })
  const seen: string[] = []
  const http: SafeGet = async (u, o) => {
    seen.push(o?.headers?.['user-agent'] ?? '')
    if (u.startsWith('https://efts.sec.gov/')) return { status: 200, body: JSON.stringify(FX.page) }
    const adsh = Object.keys(FX.docs).find(k => u.includes(`/${k.replace(/-/g, '')}/primary_doc.xml`))
    return adsh ? { status: 200, body: FX.docs[adsh] } : { status: 404, body: '' }
  }
  const r = await src.collect(SW, '2026-08-17', http)
  assert.deepEqual(r.candidates.map(x => x.title.split(':')[0]).sort(), ['DegreeSight Inc', 'Expressable, Inc.'], 'ASURE is Business Services: not what "software startups" means on the form')
  const x = r.candidates.find(c => c.title.startsWith('Expressable'))!
  assert.equal(x.via, 'registry'); assert.equal(x.dated, 'registry'); assert.equal(x.triggerId, 'registry:form_d_offering')
  assert.match(x.url, /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/1857689\/000185768926000001\/xslFormDX01\/primary_doc\.xml$/)
  assert.match(x.snippet, /^Expressable, Inc\. \(Austin, TX\) filed a new Form D with the SEC on 2026-\d\d-\d\d \(a notice of an exempt securities offering\), reporting \$[\d.]+[MK]? sold/)
  assert.match(x.snippet, /Named on the filing: Nicholas Barbara, Executive Officer/)
  assert.doesNotMatch(x.snippet, /series [a-z]|raised a/i, 'the form proves an offering and its amounts, not a named round')
  assert.equal(paced, seen.length, 'every SEC request waits for the pace'); assert.ok(seen.every(ua => /^dazl-sources\/1\.0 /.test(ua)), 'a User-Agent that names us')
  assert.ok(SEC_MIN_GAP_MS >= 100, 'fair access: under 10 requests a second')
  assert.deepEqual((await src.collect(SW, '2026-08-17', async () => ({ status: 429, body: '' }))), { candidates: [], notes: ['throttled'] })
  const docsDown = await src.collect(SW, '2026-08-17', async u => (u.startsWith('https://efts') ? { status: 200, body: JSON.stringify(FX.page) } : { status: 503, body: '' }))
  assert.deepEqual(docsDown, { candidates: [], notes: ['unread_3'] })
})
