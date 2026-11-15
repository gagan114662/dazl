// MISSION v2 part E: the city business-licence source (lib/research/sources/opendatasoft-licences.ts), on REAL recorded rows of
// Vancouver's business-licences dataset (test/fixtures/research-vancouver-licences.json, 15 Nov 2026). No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CHUNK, VANCOUVER_LICENCES, licenceQueries, licenceSignals, licenceYears, vancouverLicencesSource } from '../lib/research/sources/opendatasoft-licences.ts'
import type { ResearchCase } from '../lib/research/types.ts'
import type { SafeGet } from '../lib/sources/types.ts'

type Row = Record<string, unknown>
const FX = JSON.parse(readFileSync(new URL('./fixtures/research-vancouver-licences.json', import.meta.url), 'utf8')) as { since: string; window: Row[]; prior: Row[]; same: Row[]; renewal_name: string }
const VAN: ResearchCase = { tenant: 't', jobId: 'j', query: 'restaurants in Vancouver opening a second location', offer: 'x', where: 'Vancouver, British Columbia', category: 'restaurants', windowDays: 90, today: '2026-11-15' }

test('a renewal (same business, same address, last year) is never called new; a new business at an address is "newly licensed"; a business with another licensed location is an additional location', () => {
  const s = licenceSignals(VANCOUVER_LICENCES, 'restaurants', FX.window, FX.prior, FX.same, FX.since)
  const names = s.map(x => x.company)
  assert.ok(!names.includes(FX.renewal_name), `the renewal is not a new location: ${JSON.stringify(names)}`)
  const hunger = s.find(x => x.company === 'Hunger Street')!
  assert.equal(hunger.eventKind, 'new_business_licence')
  assert.match(hunger.eventSummary, /^Hunger Street newly licensed as a restaurant at 1284 KINGSWAY .*Vancouver \(licence 26-\d+, issued 2026-\d\d-\d\d; no licence under this name at this address last year\)$/)
  assert.doesNotMatch(hunger.eventSummary, /opened|second location/i, 'the record cannot tell a new opening from a new owner: it says what it proves')
  const skewers = s.find(x => x.company === 'Skewers Souvlaki Pita Bar')!
  assert.equal(skewers.eventKind, 'additional_location_licence')
  assert.match(skewers.eventSummary, /2 licensed restaurant locations in Vancouver this year under the name Skewers Souvlaki Pita Bar$/)
  for (const x of s) {
    assert.match(x.eventDate, /^\d{4}-\d{2}-\d{2}$/); assert.ok(x.eventDate >= FX.since)
    assert.match(x.pageUrl, /^https:\/\/opendata\.vancouver\.ca\/explore\/dataset\/business-licences\/table\/\?q=26-/)
    assert.equal(new URL(x.recordUrl).searchParams.get('where'), `licencenumber="${x.licence}"`)
    assert.equal(x.personName, null, 'a licence names no person')
  }
  assert.equal(s[0].eventKind, 'additional_location_licence', 'additional locations first')
})

test('the source: narrow chunked queries over every licence year the window touches; without last year, or without this year\'s other locations, it returns nothing (fails closed)', async () => {
  const q = licenceQueries(VANCOUVER_LICENCES, 'restaurants', FX.since, ['26'])
  const w = (u: string) => new URL(u).searchParams.get('where') ?? ''
  assert.equal(w(q.window), `(businesstype="Restaurant") and (folderyear="26") and status="Issued" and issueddate >= date'2026-08-17'`)
  assert.match(w(q.renewals(FX.window)[0]), /\(folderyear="25"\) and \(\(house="/)
  assert.match(w(q.locations([{ businesstradename: 'He said "hi"' }])[0]), /businesstradename="He said ""hi"""/, 'a quote inside a name is escaped')
  // a window across New Year: both licence years (a licence issued in December is in last year's folder), renewals one year earlier each
  assert.deepEqual(licenceYears('2025-11-12', '2026-02-10'), ['25', '26'])
  const span = licenceQueries(VANCOUVER_LICENCES, 'restaurants', '2025-11-12', ['25', '26'])
  assert.match(w(span.window), /\(folderyear="25" or folderyear="26"\)/)
  assert.match(w(span.renewals(FX.window)[0]), /\(folderyear="24" or folderyear="25"\)/)
  assert.match(w(span.locations(FX.window)[0]), /and \(folderyear="26"\) and/, '"locations this year": the current licence year only')
  // a busy window: the OR list is cut into requests of CHUNK clauses, each URL a few KB
  const many = Array.from({ length: 200 }, (_, i) => ({ house: String(1000 + i), street: 'W BROADWAY', businessname: `Business Number ${i} Ltd`, businesstradename: `Trade ${i}` }))
  const ru = q.renewals(many), lu = q.locations(many)
  assert.equal(ru.length, Math.ceil(200 / CHUNK)); assert.equal(lu.length, Math.ceil(400 / CHUNK))
  assert.ok([...ru, ...lu].every(u => u.length < 4096), `longest ${Math.max(...[...ru, ...lu].map(u => u.length))}`)
  const src = vancouverLicencesSource
  assert.equal(src.covers(VAN), true); assert.equal(src.covers({ ...VAN, category: 'dentists' }), false); assert.equal(src.covers({ ...VAN, where: 'Victoria, BC' }), false)
  for (const where of ['Vancouver, Washington', 'Vancouver, WA', 'North Vancouver, BC', 'West Vancouver, British Columbia', 'Vancouver']) assert.equal(src.covers({ ...VAN, where }), false, where)
  assert.equal(src.covers({ ...VAN, where: 'Vancouver, BC, Canada' }), true)
  assert.equal(src.covers({ ...VAN, category: 'software companies', query: 'software companies near restaurants' }), false, 'the category decides, not words in the query')
  const answer = (renewals: 'ok' | 'down', locations: 'ok' | 'down' = 'ok'): SafeGet => async (u: string) => {
    const where = w(u)
    if (where.includes('issueddate >=')) return { status: 200, body: JSON.stringify(FX.window) }
    if (where.includes('folderyear="25"')) return renewals === 'ok' ? { status: 200, body: JSON.stringify(FX.prior) } : { status: 503, body: '' }
    return locations === 'ok' ? { status: 200, body: JSON.stringify(FX.same) } : { status: 503, body: '' }
  }
  const ok = await src.collect(VAN, FX.since, answer('ok'))
  assert.ok(ok.candidates.length >= 3 && ok.notes.length === 0, JSON.stringify(ok.notes))
  assert.ok(!ok.candidates.some(x => x.title.startsWith(FX.renewal_name)))
  for (const x of ok.candidates) { assert.equal(x.via, 'registry'); assert.equal(x.dated, 'registry'); assert.ok(x.date! >= FX.since); assert.match(x.url, /^https:\/\/opendata\.vancouver\.ca\/api\/explore\/v2\.1\/catalog\/datasets\/business-licences\/records\?/) }
  assert.ok(ok.candidates.some(x => x.triggerId === 'registry:additional_location_licence'))
  assert.deepEqual(await src.collect(VAN, FX.since, answer('down')), { candidates: [], notes: ['http_503', 'renewals_unknown'] })
  assert.deepEqual(await src.collect(VAN, FX.since, answer('ok', 'down')), { candidates: [], notes: ['http_503', 'locations_unknown'] }, 'a single location is never guessed')
  assert.deepEqual((await src.collect(VAN, FX.since, async () => ({ status: 200, body: '[{', truncated: true }))).notes, ['oversize'])
  assert.deepEqual((await src.collect(VAN, FX.since, async () => ({ status: 200, body: '{"error":"quota"}' }))).notes, ['not_json'], 'a 200 without rows is unreadable, not empty')
})

test('a window across New Year: a December licence comes back in last year\'s folder too, and is never its own renewal', () => {
  const hunger = FX.window.find(r => r.businesstradename === 'Hunger Street')!
  const december = { ...hunger, folderyear: '25', issueddate: '2025-12-04T18:00:00+00:00' }   // the real row moved to December (labelled)
  const s = licenceSignals(VANCOUVER_LICENCES, 'restaurants', [december], [december], [december], '2025-11-12')
  assert.deepEqual(s.map(x => x.company), ['Hunger Street'])
  const before = { ...december, issueddate: '2025-03-01T18:00:00+00:00', licencenumber: '25-000001' }
  assert.equal(licenceSignals(VANCOUVER_LICENCES, 'restaurants', [december], [before], [december], '2025-11-12').length, 0, 'a licence from before the window is a renewal')
})

test('locations are counted under both names: a second location filed under the legal name only still makes this an additional location', () => {
  const hunger = FX.window.find(r => r.businesstradename === 'Hunger Street')!
  const other = { ...hunger, businesstradename: null, house: '999', street: 'MAIN ST', licencenumber: '26-999999' }   // derived from the real row (labelled)
  const s = licenceSignals(VANCOUVER_LICENCES, 'restaurants', FX.window, FX.prior, [...FX.same, other], FX.since)
  assert.equal(s.find(x => x.company === 'Hunger Street')!.eventKind, 'additional_location_licence')
})

test('a renewal is found under either of its names: last year under the legal name only, this year with a trade name added, is not "new"', () => {
  const hunger = FX.window.find(r => r.businesstradename === 'Hunger Street')!
  const lastYear = { ...hunger, folderyear: '25', businesstradename: null, licencenumber: '25-000000', issueddate: '2025-04-01T18:00:00+00:00' }   // derived from the real row: the same legal name and address last April, no trade name
  const s = licenceSignals(VANCOUVER_LICENCES, 'restaurants', FX.window, [...FX.prior, lastYear], FX.same, FX.since)
  assert.ok(!s.some(x => x.company === 'Hunger Street'), 'a renewal under the legal name is still a renewal')
  assert.ok(String(hunger.businessname ?? '').length > 0, 'the fixture row has a legal name')
})
