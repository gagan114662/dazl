// MISSION v2 part E: the city open-data records E's sources cite, read through the shared page fetcher (lib/scan/fetch-page.ts) as the read and
// verify stages read them (lib/research/sources/record-page.ts), on REAL recorded record answers (test/fixtures/research-record-pages.json).
// Before: the fetcher read no JSON but the Norway register's and ATS postings', so every permit and licence candidate came back { fail: 'error' }.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fetchPageDetailed, isFail } from '../lib/scan/fetch-page.ts'
import { registryRecordRef, renderRegistryRecord } from '../lib/research/sources/record-page.ts'

const FX = JSON.parse(readFileSync(new URL('./fixtures/research-record-pages.json', import.meta.url), 'utf8')) as { austin_url: string; austin: unknown[]; vancouver_url: string; vancouver: { results: Record<string, unknown>[] } }

// only the socket is faked: the real fetcher, its content-type and record checks
function fakeHttps(serve: (url: string) => { status: number; type: string; body: string; location?: string }) {
  const real = https.request
  ;(https as { request: unknown }).request = (url: URL, _opts: unknown, cb: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void }
    req.destroy = () => {}
    req.end = () => {
      const r = serve(String(url)); const res = Object.assign(new EventEmitter(), { statusCode: r.status, headers: { 'content-type': r.type, ...(r.location ? { location: r.location } : {}) }, resume() {}, destroy() {} })
      cb(res); res.emit('data', Buffer.from(r.body)); res.emit('end')
    }
    return req
  }
  return () => { (https as { request: unknown }).request = real }
}
const json = (body: unknown) => () => ({ status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify(body) })

test('only the records E cites are records: the exact dataset, one record named, https', () => {
  assert.deepEqual(registryRecordRef(FX.austin_url), { kind: 'austin-permit', id: '2026-121002 BP' })
  assert.deepEqual(registryRecordRef(FX.vancouver_url), { kind: 'vancouver-licence', id: '26-210140' })
  for (const u of ['https://data.austintexas.gov/resource/3syk-w9eu.json', 'https://data.austintexas.gov/resource/3syk-w9eu.json?permit_number=2026-121002+BP&$limit=5000',
    'https://data.austintexas.gov/resource/other-id.json?permit_number=2026-121002+BP', 'http://data.austintexas.gov/resource/3syk-w9eu.json?permit_number=2026-121002+BP',
    'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/business-licences/records?where=businesstype%3D%22Restaurant%22',
    'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/other/records?where=licencenumber%3D%2226-210140%22']) assert.equal(registryRecordRef(u), null, u)
})

test('a permit and a licence render as one dated sentence naming the business; anything but the named record renders nothing', () => {
  const a = renderRegistryRecord(FX.austin, registryRecordRef(FX.austin_url)!)!
  assert.equal(a.published, '2026-09-17')
  assert.match(a.text, /^City of Austin permit 2026-121002 BP was issued on 2026-09-17 with Precision Reconstruction Group as general contractor \(work: Re-roof; .*contractor of record: Ryan Curtis\)\.$/)
  assert.ok(a.text.length <= 300)
  const v = renderRegistryRecord(FX.vancouver, registryRecordRef(FX.vancouver_url)!)!
  assert.equal(v.published, '2026-09-28')
  assert.match(v.text, /^City of Vancouver business licence 26-210140 was issued on 2026-09-28 to Skewers Souvlaki Pita Bar \(licensee: Andre Skewers Souvlaki Pita Bar Ltd; type: Restaurant.*at 1851 COMMERCIAL DRIVE, Grandview-Woodland, Vancouver, BC\)\.$/)
  assert.equal(renderRegistryRecord([], { kind: 'austin-permit', id: '2026-121002 BP' }), null, 'no rows')
  // a permit's rows: one per contractor (derived from the real row, labelled)
  const gc = FX.austin[0] as Record<string, unknown>, ref = registryRecordRef(FX.austin_url)!
  const sub = { ...gc, contractor_trade: 'Electrical Contractor', contractor_company_name: 'Sparks Electric LLC', contractor_full_name: 'Sam Volt' }
  assert.match(renderRegistryRecord([sub, gc], ref)!.text, /with Precision Reconstruction Group as general contractor/, 'the general contractor, whatever the row order')
  assert.equal(renderRegistryRecord([sub], ref), null, 'no general contractor: no business is named (never the subcontractor)')
  assert.equal(renderRegistryRecord([gc, { ...sub, issue_date: '2026-10-01T00:00:00.000' }], ref), null, 'rows that disagree on the day are not one dated fact')
  const long = renderRegistryRecord([{ ...gc, contractor_company_name: 'X'.repeat(400) }], ref)!
  assert.ok(long.text.length <= 300, `quote limit: ${long.text.length}`)
  assert.equal(renderRegistryRecord(FX.austin, { kind: 'austin-permit', id: '2026-999999 BP' }), null, 'another permit')
  assert.equal(renderRegistryRecord(FX.vancouver, { kind: 'vancouver-licence', id: '26-000000' }), null, 'another licence')
  assert.equal(renderRegistryRecord({ results: [{ ...FX.vancouver.results[0], status: 'Pending' }] }, registryRecordRef(FX.vancouver_url)!), null, 'not an issued licence')
  assert.equal(renderRegistryRecord({ results: [{ ...FX.vancouver.results[0], issueddate: null }] }, registryRecordRef(FX.vancouver_url)!), null, 'no day: no page')
})

test('through the real page fetcher: the cited record is a readable page with its own day; other JSON and a redirect to another record are not', async () => {
  let restore = fakeHttps(json(FX.austin))
  try {
    const p = await fetchPageDetailed(FX.austin_url, async () => null)
    assert.ok(!isFail(p), JSON.stringify(p)); if (isFail(p)) return
    assert.match(p.text, /was issued on 2026-09-17 with Precision Reconstruction Group as general contractor/); assert.equal(p.published, '2026-09-17')
  } finally { restore() }
  restore = fakeHttps(json(FX.vancouver))
  try {
    const p = await fetchPageDetailed(FX.vancouver_url, async () => null)
    assert.ok(!isFail(p)); if (isFail(p)) return
    assert.match(p.text, /^City of Vancouver business licence 26-210140 was issued on 2026-09-28/)
  } finally { restore() }
  // the dataset's other JSON (a query, not one record) is still not a page
  restore = fakeHttps(json(FX.austin))
  try { assert.ok(isFail(await fetchPageDetailed('https://data.austintexas.gov/resource/3syk-w9eu.json?$limit=5', async () => null))) } finally { restore() }
  // a record URL answering another permit's rows is not that permit
  restore = fakeHttps(json(FX.austin))
  try { assert.ok(isFail(await fetchPageDetailed('https://data.austintexas.gov/resource/3syk-w9eu.json?permit_number=2026-999999+BP', async () => null))) } finally { restore() }
  // a record URL that answers HTML, or a licence body that is not an object, is not a page
  restore = fakeHttps(() => ({ status: 200, type: 'text/html', body: '<html><body>City of Austin permit</body></html>' }))
  try { const p = await fetchPageDetailed(FX.austin_url, async () => null); assert.ok(isFail(p) || !/was issued on/.test(p.text), 'HTML on a record URL is never rendered as the record') } finally { restore() }
  restore = fakeHttps(json(['not', 'a', 'licence']))
  try { assert.ok(isFail(await fetchPageDetailed(FX.vancouver_url, async () => null))) } finally { restore() }
  // a record URL that redirects to another record does not borrow it
  restore = fakeHttps(u => u.includes('2026-555555') ? { status: 302, type: 'text/html', body: '', location: FX.austin_url } : json(FX.austin)())
  try { assert.ok(isFail(await fetchPageDetailed('https://data.austintexas.gov/resource/3syk-w9eu.json?permit_number=2026-555555+BP', async () => null))) } finally { restore() }
})
