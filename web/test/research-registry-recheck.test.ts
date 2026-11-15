// MISSION v2 part E: the registry verify path's re-read (lib/research/sources/recheck.ts): ONE record by its id from the city's open-data API,
// its own fields back, and the citation a proof carries. On REAL recorded record answers (test/fixtures/research-record-pages.json) and on the
// sources' own candidates (the real recorded permit / licence rows of research-austin-permits.json / research-vancouver-licences.json).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { recheckRegistryRecord, registryRecordFacts, registryRecordRef } from '../lib/research/sources/index.ts'
import { austinPermitsSource } from '../lib/research/sources/socrata-permits.ts'
import { vancouverLicencesSource } from '../lib/research/sources/opendatasoft-licences.ts'
import type { SafeGet } from '../lib/sources/types.ts'
import type { ResearchCase } from '../lib/research/types.ts'

const rd = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'))
const REC = rd('research-record-pages.json') as { austin_url: string; austin: unknown[]; vancouver_url: string; vancouver: { results: Record<string, unknown>[] } }
const serve = (body: unknown, seen: string[] = []): SafeGet => async (u, o) => { seen.push(`${u} ${o?.accept}`); return { status: 200, body: JSON.stringify(body) } }

test('an Austin permit and a Vancouver licence come back as their own fields plus the citation a proof carries', async () => {
  const seen: string[] = []
  const a = await recheckRegistryRecord({ url: REC.austin_url }, serve(REC.austin, seen))
  assert.ok(a.ok); if (!a.ok) return
  assert.deepEqual({ id: a.recordId, kind: a.kind, company: a.company, date: a.date, description: a.description, person: a.person, url: a.recordUrl },
    { id: '2026-121002 BP', kind: 'austin-permit', company: 'Precision Reconstruction Group', date: '2026-09-17', description: 'Re-roof', person: 'Ryan Curtis', url: REC.austin_url })
  assert.equal(a.citation, "the city's open-data record, permit 2026-121002 BP, issued 2026-09-17")
  assert.deepEqual(seen, [`${REC.austin_url} application/json`], 'one request, for exactly the record URL')
  const v = await recheckRegistryRecord(REC.vancouver_url, serve(REC.vancouver))
  assert.ok(v.ok); if (!v.ok) return
  assert.deepEqual({ id: v.recordId, company: v.company, date: v.date, licensee: v.licensee }, { id: '26-210140', company: 'Skewers Souvlaki Pita Bar', date: '2026-09-28', licensee: 'Andre Skewers Souvlaki Pita Bar Ltd' })
  assert.match(v.description, /^Restaurant, /)
  assert.equal(v.citation, "the city's open-data record, licence 26-210140, issued 2026-09-28")
})

test("a source's own candidate survives its re-read: the same business, the same day (permits and licences, on the recorded real rows)", async () => {
  const c = (where: string, category: string): ResearchCase => ({ tenant: 't', jobId: 'j', query: `${category} in ${where}`, offer: 'x', where, category, windowDays: 90, today: '2026-11-15' })
  const permits = rd('research-austin-permits.json').rows as Record<string, unknown>[]
  const a = await austinPermitsSource.collect(c('Austin, Texas', 'roofing contractors'), '2026-08-17', serve(permits))
  assert.ok(a.candidates.length >= 6)
  for (const cand of a.candidates) {
    const id = registryRecordRef(cand.url)!.id
    const r = await recheckRegistryRecord(cand, serve(permits.filter(p => p.permit_number === id)))
    assert.ok(r.ok, `${cand.title}: ${JSON.stringify(r)}`); if (!r.ok) continue
    assert.equal(r.date, cand.date); assert.ok(cand.title.startsWith(r.company), `${cand.title} / ${r.company}`)
  }
  const lic = rd('research-vancouver-licences.json') as { since: string; window: Record<string, unknown>[]; prior: Record<string, unknown>[]; same: Record<string, unknown>[] }
  const v = await vancouverLicencesSource.collect(c('Vancouver, British Columbia', 'restaurants'), lic.since, async u => {
    const w = new URL(u).searchParams.get('where') ?? ''
    return { status: 200, body: JSON.stringify(w.includes('issueddate >=') ? lic.window : w.includes('folderyear="25"') ? lic.prior : lic.same) }
  })
  assert.ok(v.candidates.length >= 3)
  for (const cand of v.candidates) {
    const id = registryRecordRef(cand.url)!.id
    const r = await recheckRegistryRecord(cand, serve({ total_count: 1, results: lic.window.filter(x => x.licencenumber === id) }))
    assert.ok(r.ok, `${cand.title}: ${JSON.stringify(r)}`); if (!r.ok) continue
    assert.equal(r.date, cand.date); assert.ok(cand.title.startsWith(r.company), `${cand.title} / ${r.company}`)
  }
})

test('whatever cannot be read says why, and nothing is proved: not a record URL (no request), unreachable, refused, oversize, not JSON, no such record, another record, no business named', async () => {
  const asked: string[] = []
  for (const u of ['https://www.example.com/x', 'https://data.austintexas.gov/resource/3syk-w9eu.json?$limit=5', 'https://abc.austintexas.gov/web/permit/public-search-other?t_detail=1&t_selected_folderrsn=13772959', 'not a url'])
    assert.deepEqual(await recheckRegistryRecord(u, async x => { asked.push(x); return null }), { ok: false, why: 'not_a_registry_record' })
  assert.deepEqual(asked, [], 'no request for a URL that is not exactly one record')
  const why = async (h: SafeGet, url = REC.austin_url) => { const r = await recheckRegistryRecord(url, h); return r.ok ? 'ok' : r.why }
  assert.equal(await why(async () => null), 'unreachable')
  assert.equal(await why(async () => ({ status: 429, body: '' })), 'throttled')
  assert.equal(await why(async () => ({ status: 503, body: '' })), 'http_503')
  assert.equal(await why(async () => ({ status: 200, body: '[', truncated: true })), 'oversize')
  assert.equal(await why(async () => ({ status: 200, body: '<!doctype html><html>blocked</html>' })), 'not_json')
  assert.equal(await why(async () => ({ status: 200, body: '{"x":' })), 'not_json')
  assert.equal(await why(serve([])), 'record_not_found'); assert.equal(await why(serve({ total_count: 0, results: [] }), REC.vancouver_url), 'record_not_found')
  const rows = REC.austin as Record<string, unknown>[]
  assert.equal(await why(serve(rows.map(r => ({ ...r, permit_number: '2026-999999 BP' })))), 'record_unreadable', 'another permit answered')
  assert.equal(await why(serve(rows.map(r => ({ ...r, contractor_trade: 'Electrical Contractor' })))), 'record_unreadable', 'no general contractor: no business is named')
  assert.equal(await why(serve({ results: [{ ...REC.vancouver.results[0], status: 'Pending' }] }), REC.vancouver_url), 'record_unreadable', 'not an issued licence')
  assert.equal(registryRecordFacts(REC.austin, registryRecordRef(REC.vancouver_url)!), null, 'a record of one kind is not read as the other')
})

// A REAL revised licence (test/fixtures/research-vancouver-revisions.json): revision 00 (first issued, now Inactive), later revisions amend it.
test("a revised licence re-reads as the business's CURRENT name with its FIRST issue day; unreadable history is unknown, never guessed", async () => {
  const REV = rd('research-vancouver-revisions.json') as { licences: Record<string, Record<string, unknown>[]> }
  const url = (n: string) => `https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/business-licences/records?where=licencenumber%3D%22${n}%22&limit=5`
  const rows = REV.licences['26-221108']   // SOLO POCHA (rev 00, 01), renamed Jansang (rev 02, Issued)
  const r = await recheckRegistryRecord(url('26-221108'), serve({ total_count: rows.length, results: rows }))
  assert.ok(r.ok); if (!r.ok) return
  assert.equal(r.company, 'Jansang'); assert.equal(r.date, '2026-04-21'); assert.deepEqual(r.revision, { number: '02', date: '2026-10-29' })
  assert.equal(r.citation, "the city's open-data record, licence 26-221108, issued 2026-04-21")
  const page = (await import('../lib/research/sources/record-page.ts')).renderRegistryRecord({ results: rows }, registryRecordRef(url('26-221108'))!)!
  assert.match(page.text, /^City of Vancouver business licence 26-221108 was first issued on 2026-04-21 to Jansang \(revision 02 issued 2026-10-29; /); assert.equal(page.published, '2026-04-21')
  const why = async (rs: Record<string, unknown>[]) => { const x = await recheckRegistryRecord(url('26-221108'), serve({ total_count: rs.length, results: rs })); return x.ok ? 'ok' : x.why }
  assert.equal(await why(rows.filter(x => x.licencerevisionnumber !== '00')), 'record_unreadable', 'no revision 00 row: the first issue is unknown')
  assert.equal(await why(rows.map(x => ({ ...x, status: 'Issued' }))), 'record_unreadable', 'several Issued rows: ambiguous')
  assert.equal(await why(rows.map(x => ({ ...x, status: 'Inactive' }))), 'record_unreadable', 'no Issued row')
  assert.equal(await why([...rows, { ...rows[0] }]), 'record_unreadable', 'one revision twice')
})
