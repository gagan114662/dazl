// #388: Norway business register (Enhetsregisteret) source adapter. Recorded fixtures from the live public API and entity pages
// (test/fixtures/brreg/README.md says exactly which requests); no network here. Synthetic cases are built inline and say so.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import { brregAdapter, brregCandidates, brregLimits, brregList, brregReject, brregScope, isBrregEntity, resetBrregState, type BrregEntity } from '../lib/sources/brreg.ts'
import { brregRecordQuote, brregRecordRef, brregRecordUrl, renderBrregRecord } from '../lib/sources/brreg-record.ts'
import { fetchPageDetailed, isFail } from '../lib/scan/fetch-page.ts'
import { collectEvidenceReport, normalizeSources } from '../lib/sources/index.ts'
import { buildSources } from '../lib/sources/ui-sources.ts'
import { verifyLeads, type LeadDraft } from '../lib/scan/runner.ts'
import type { HttpResult, SafeGet } from '../lib/sources/types.ts'

const dir = new URL('./fixtures/brreg/', import.meta.url)
const J = (f: string) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'))
const RECORDS = J('records.json') as Record<string, BrregEntity> // each candidate's own API record, recorded live (test/fixtures/brreg/README.md)
const recUrl = (k: string) => `https://data.brreg.no/enhetsregisteret/api/${k}`
const PARENTS = { ...J('parents-dental.json'), ...J('parents-restaurant-oslo.json') } as Record<string, BrregEntity>
const list = (f: string, k: string) => J(f)._embedded[k] as BrregEntity[]
const NOW = Date.parse('2026-11-03T12:00:00Z') // the recording day: the fixtures were requested with fraRegistreringsdato 2026-09-04 (60 days back)
const FROM = '2026-09-04', TODAY = '2026-11-03'
brregLimits.now = () => NOW
const API = 'https://data.brreg.no/enhetsregisteret/api'

// Serves the recorded responses for exactly the recorded request URLs; anything else is a 404, and every URL asked is logged.
function recorded(asked: string[], override: (u: string) => HttpResult | null | undefined = () => undefined): SafeGet {
  const lists: Record<string, string> = {
    [`${API}/enheter?naeringskode=56&kommunenummer=0301&fraRegistreringsdatoEnhetsregisteret=${FROM}&size=20&sort=registreringsdatoEnhetsregisteret,desc`]: 'enheter-restaurant-oslo.json',
    [`${API}/underenheter?naeringskode=56&kommunenummer=0301&fraRegistreringsdatoEnhetsregisteret=${FROM}&size=20&sort=registreringsdatoEnhetsregisteret,desc`]: 'underenheter-restaurant-oslo.json',
    [`${API}/enheter?naeringskode=86.23&fraRegistreringsdatoEnhetsregisteret=${FROM}&size=20&sort=registreringsdatoEnhetsregisteret,desc`]: 'enheter-dental-no.json',
    [`${API}/underenheter?naeringskode=86.23&fraRegistreringsdatoEnhetsregisteret=${FROM}&size=20&sort=registreringsdatoEnhetsregisteret,desc`]: 'underenheter-dental-no.json',
  }
  return async (u, o) => {
    asked.push(u)
    assert.equal(o?.accept, 'application/json')
    const ov = override(u); if (ov !== undefined) return ov
    if (lists[u]) return { status: 200, body: readFileSync(new URL(lists[u], dir), 'utf8') }
    const p = u.match(/^https:\/\/data\.brreg\.no\/enhetsregisteret\/api\/enheter\/(\d{9})$/)
    if (p && PARENTS[p[1]]) return { status: 200, body: JSON.stringify(PARENTS[p[1]]) }
    const r = u.match(/^https:\/\/data\.brreg\.no\/enhetsregisteret\/api\/((?:enheter|underenheter)\/\d{9})$/)
    if (r && RECORDS[r[1]]) return { status: 200, body: JSON.stringify(RECORDS[r[1]]) }
    return { status: 404, body: '' }
  }
}
async function run(query: string, http: SafeGet) {
  resetBrregState()
  const notes: string[] = []
  const items = await brregAdapter.collect({ query, keywords: [], feeds: [], http, note: c => notes.push(c) })
  return { items, notes }
}

test('scope: a Norwegian place or "Norway" plus a mapped industry; anything else is out of coverage', () => {
  assert.deepEqual(brregScope('new restaurants and cafes in Oslo'), { sector: 'restaurant', codes: ['56'], kommune: '0301', place: 'Oslo' })
  assert.deepEqual(brregScope('newly opened dental clinics in Norway'), { sector: 'dental', codes: ['86.23'], kommune: null, place: 'Norway' })
  assert.equal(brregScope('nye tannleger i Tromsø')?.kommune, '5501', 'Norwegian words and a non-ASCII place name')
  assert.equal(brregScope('frisørsalonger i Bergen')?.sector, 'hair_beauty')
  assert.deepEqual(brregScope('plumbers in Trondheim')?.codes, ['43.22'])
  assert.equal(brregScope('dentists in London'), null, 'not a Norwegian market')
  assert.equal(brregScope('new companies in Norway'), null, 'no mapped industry: not a whole-register dump')
  assert.equal(brregScope('barsoom startups in Bergenfield NJ'), null, 'word boundaries: Bergenfield is not Bergen, barsoom is not a bar')
})

test('negative fixtures (recorded Oslo restaurant registrations): estates, other municipalities and other industries are not new businesses', () => {
  const scope = brregScope('restaurants in Oslo')!
  const rows = list('enheter-restaurant-oslo.json', 'enheter')
  const why = new Map(rows.map(e => [e.navn!, brregReject(e, scope, FROM, TODAY)]))
  for (const [name, r] of why) if (/(KONKURSBO|TVANGSAVVIKLINGSBO)$/.test(name)) assert.equal(r, 'estate', name)
  assert.ok([...why.values()].filter(r => r === 'estate').length >= 5, 'the recorded window holds several bankruptcy / liquidation estates')
  assert.equal(why.get('SKIEN BARDRIFT AS'), 'place', 'the API returned a Skien business for an Oslo filter; its own business address decides')
  assert.equal(why.get('PUNJABI MASALA AS'), null)
  const dental = brregScope('dentists in Oslo')!
  assert.equal(brregReject(rows.find(e => e.navn === 'PUNJABI MASALA AS')!, dental, FROM, TODAY), 'sector')
  // synthetic edge cases on a real row
  const ok = rows.find(e => e.navn === 'PUNJABI MASALA AS')!
  assert.equal(brregReject({ ...ok, registreringsdatoEnhetsregisteret: '2026-08-01' }, scope, FROM, TODAY), 'date')
  assert.equal(brregReject({ ...ok, registreringsdatoEnhetsregisteret: '2026-12-01' }, scope, FROM, TODAY), 'date', 'a future date is not a registration')
  assert.equal(brregReject({ ...ok, konkurs: true }, scope, FROM, TODAY), 'winding_down')
  assert.equal(brregReject({ ...ok, slettedato: '2026-11-01' }, scope, FROM, TODAY), 'winding_down')
  assert.equal(brregReject({ ...ok, organisasjonsnummer: '12345' }, scope, FROM, TODAY), 'bad_id')
  assert.equal(brregReject({ ...ok, naeringskode1: { kode: '00.000' } }, scope, FROM, TODAY), 'sector', 'the unknown-industry code is never a match')
})

test('new locations: only an establishment of a business registered at least 180 days earlier; sub-units of brand-new businesses are formations', () => {
  const scope = brregScope('restaurants in Oslo')!
  const c = brregCandidates(scope, list('enheter-restaurant-oslo.json', 'enheter'), list('underenheter-restaurant-oslo.json', 'underenheter'), new Map(Object.entries(PARENTS)), FROM, TODAY)
  const openings = c.filter(x => x.kind === 'new_location').map(x => x.e.navn)
  assert.deepEqual(openings, ['REVETAL GAMLE STASJONEN AS AVD OSLO', 'HÅNDBAKT HOLDING AS'], 'parents registered 2024-12-04 and 2022-07-04')
  assert.ok(!c.some(x => /KONKURSBO|TVANGSAVVIKLINGSBO/.test(x.e.navn!)))
  // recorded dental sub-units: every parent was itself registered within weeks (Aug-Sep 2026), so none is an opening
  const d = brregScope('dental clinics in Norway')!
  const dc = brregCandidates(d, list('enheter-dental-no.json', 'enheter'), list('underenheter-dental-no.json', 'underenheter'), new Map(Object.entries(PARENTS)), FROM, TODAY)
  assert.equal(dc.filter(x => x.kind === 'new_location').length, 0)
  assert.ok(dc.length > 0 && dc.every(x => x.kind === 'new_company'))
})

test('record text: one sentence naming the entity, its organisation number and the registry date; another entity\'s or a dateless record gives nothing', () => {
  const rec = RECORDS['enheter/838791352']
  const r = renderBrregRecord(rec, '838791352')!
  assert.equal(r.registered, rec.registreringsdatoEnhetsregisteret)
  assert.ok(r.text.startsWith('PUNJABI MASALA AS (organisasjonsnummer 838791352)') && r.text.endsWith(`was registered in Enhetsregisteret on ${r.registered}.`))
  assert.equal(brregRecordQuote(r.text), r.text)
  assert.equal(renderBrregRecord(rec, '938786658'), null, 'wrong organisation number')
  for (const bad of [null, [], 'x', {}, { ...rec, navn: ' ' }, { ...rec, registreringsdatoEnhetsregisteret: undefined }, { ...rec, registreringsdatoEnhetsregisteret: '2026-13-45' }, { ...rec, registreringsdatoEnhetsregisteret: '31.10.2026' }])
    assert.equal(renderBrregRecord(bad, '838791352'), null, JSON.stringify(bad)?.slice(0, 60))
  assert.equal(brregRecordQuote('too short'), null)
  assert.equal(brregRecordQuote('x'.repeat(301)), null)
  assert.deepEqual(brregRecordRef(recUrl('enheter/838791352')), { kind: 'enheter', id: '838791352' })
  assert.equal(brregRecordUrl('underenheter', '938737347'), recUrl('underenheter/938737347'))
  for (const u of ['https://data.brreg.no/enhetsregisteret/api/enheter?naeringskode=56', 'https://data.brreg.no/enhetsregisteret/api/enheter/12345678', 'https://data.brreg.no/enhetsregisteret/api/enheter/838791352/roller', 'http://data.brreg.no/enhetsregisteret/api/enheter/838791352', 'https://data.brreg.no.evil.example/enhetsregisteret/api/enheter/838791352', 'https://virksomhet.brreg.no/nb/oppslag/enheter/838791352'])
    assert.equal(brregRecordRef(u), null, u)
})

test('adapter on recorded Oslo restaurants: openings and new businesses, each citing its own API record, within the per-scan budget', async () => {
  const asked: string[] = []
  const { items, notes } = await run('new restaurants and cafes in Oslo', recorded(asked))
  assert.deepEqual(items.map(i => i.url), [
    recUrl('underenheter/938737347'), recUrl('underenheter/938797455'), recUrl('enheter/838791352'), recUrl('enheter/938762767'), recUrl('enheter/938750386'), recUrl('enheter/938747784'),
  ])
  for (const i of items) {
    assert.equal(i.source, 'brreg'); const rec = renderBrregRecord(RECORDS[i.url.slice(recUrl('').length)], i.url.slice(-9))!
    assert.equal(i.quote, rec.text, 'the quote is the cited record\'s own text'); assert.equal(i.date, rec.registered, 'the date is the record\'s registration date')
    assert.ok(i.date! >= FROM && i.date! <= TODAY); assert.ok(i.quote.length >= 20 && i.quote.length <= 300)
  }
  assert.match(items[0].title, /registered a new establishment in OSLO.*registered since 2024-12-04/)
  assert.match(items[2].title, /^New business registered in OSLO: PUNJABI MASALA AS \(Drift av restauranter/)
  assert.match(items[0].quote, /^REVETAL GAMLE STASJONEN AS AVD OSLO \(organisasjonsnummer 938737347\).*was registered in Enhetsregisteret on 2026-11-02\.$/)
  // budget: 2 list requests + at most 4 parent lookups; at most 6 pages read; a capped run says so ('budget') instead of looking complete
  assert.equal(asked.filter(u => /\?naeringskode=/.test(u)).length, 2)
  const cited = new Set(items.map(i => i.url))
  assert.equal(asked.filter(u => /\/enheter\/\d{9}$/.test(u) && !cited.has(u)).length, brregLimits.maxParents)
  assert.ok(notes.includes('budget'))
  assert.equal(asked.filter(u => cited.has(u)).length, 6, 'one record read per kept candidate')
  assert.ok(!notes.includes('record_mismatch') && !notes.includes('unreachable'))
})

test('adapter on recorded dental registrations nationwide: new businesses only (no false openings)', async () => {
  const { items } = await run('newly opened dental clinics in Norway', recorded([]))
  assert.deepEqual(items.map(i => i.url.split('/').pop()), ['938784884', '938756112', '838756042', '938739544', '938738734', '938719411'])
  assert.ok(items.every(i => /\/enheter\//.test(i.url) && /Tannlegetjenester/.test(i.title)))
})

test('failures are reported, never an empty market: out of coverage, unreachable, unparseable, a record of another entity, time budget', async () => {
  const asked: string[] = []
  let r = await run('dentists in London', recorded(asked))
  assert.deepEqual([r.items, r.notes, asked.length], [[], ['out_of_coverage'], 0], 'nothing is requested for a request outside coverage')
  r = await run('restaurants in Oslo', recorded([], () => ({ status: 503, body: '' })))
  assert.deepEqual(r.items, []); assert.ok(r.notes.includes('unreachable'))
  r = await run('restaurants in Oslo', recorded([], () => ({ status: 200, body: '<html>' })))
  assert.deepEqual(r.items, []); assert.ok(r.notes.includes('unparseable'))
  // the record read is what proves the entity: a record of another organisation, one with another date than the list row, an unreachable one and an unparseable one are never evidence
  const target = recUrl('enheter/838791352')
  r = await run('restaurants in Oslo', recorded([], u => u === target ? { status: 200, body: JSON.stringify(RECORDS['enheter/938762767']) } : undefined))
  assert.ok(r.notes.includes('record_mismatch') && !r.items.some(i => i.url === target), 'another entity\'s record is not evidence for this one')
  r = await run('restaurants in Oslo', recorded([], u => u === target ? { status: 200, body: JSON.stringify({ ...RECORDS['enheter/838791352'], registreringsdatoEnhetsregisteret: '2026-09-05' }) } : undefined))
  assert.ok(r.notes.includes('record_mismatch') && !r.items.some(i => i.url === target), 'a record whose date differs from the list row is dropped')
  r = await run('restaurants in Oslo', recorded([], u => u === target ? { status: 200, body: JSON.stringify({ ...RECORDS['enheter/838791352'], registreringsdatoEnhetsregisteret: undefined }) } : undefined))
  assert.ok(r.notes.includes('record_mismatch') && !r.items.some(i => i.url === target), 'a record without a registration date is dropped')
  r = await run('restaurants in Oslo', recorded([], u => u === target ? { status: 404, body: '' } : undefined))
  assert.ok(r.notes.includes('unreachable') && !r.items.some(i => i.url === target))
  r = await run('restaurants in Oslo', recorded([], u => u === target ? { status: 200, body: '<html>' } : undefined))
  assert.ok(r.notes.includes('unparseable') && !r.items.some(i => i.url === target))
  const none: string[] = []
  const saved = brregLimits.budgetMs; brregLimits.budgetMs = -1 // every request would start after the per-scan time budget
  try { r = await run('restaurants in Oslo', recorded(none)) } finally { brregLimits.budgetMs = saved }
  assert.deepEqual([r.items, r.notes, none.length], [[], ['budget'], 0])
})

test('wired into source selection: accepted by the validator and the form, reported per run, skipped out of coverage', async () => {
  assert.deepEqual(normalizeSources({ adapters: ['brreg'] }), { adapters: ['brreg'], feeds: [], pages: [] })
  const off = { github: false, youtube: false, v2ex: false, jobboards: false, feedText: '', pageText: '', advPick: [] as string[] }
  assert.deepEqual(buildSources({ ...off, brreg: true }), { adapters: ['brreg'], feeds: [], pages: [], advanced: [] })
  assert.equal(buildSources(off), null, 'nothing ticked still sends nothing: brreg is never a default')
  resetBrregState()
  const out = await collectEvidenceReport({ adapters: ['brreg'], feeds: [] }, 'dentists in London', recorded([]), 5_000, [])
  assert.deepEqual(out.runs, [{ collector: 'adapter:brreg', status: 'skipped_out_of_coverage', evidence: null }])
  resetBrregState()
  const ok = await collectEvidenceReport({ adapters: ['brreg'], feeds: [] }, 'newly opened dental clinics in Norway', recorded([]), 5_000, [])
  assert.equal(ok.items.length, 6); assert.equal(ok.runs[0].collector, 'adapter:brreg'); assert.equal(ok.runs[0].status, 'partial', 'the per-scan cap on records read (maxPages) makes it partial, not ok')
})

// The verifier's own page fetcher (fetchPageDetailed, the real code) with only the socket faked: serves a status, a content type and a body for one URL, and says what it was asked for.
function fakeHttps(serve: (url: string) => { status: number; type: string; body: string }, asked: { url: string; accept: string }[] = []) {
  const real = https.request
  ;(https as { request: unknown }).request = (url: URL, opts: { headers: Record<string, string> }, cb: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void }
    req.destroy = () => {}
    req.end = () => {
      asked.push({ url: String(url), accept: opts.headers.accept })
      const r = serve(String(url)); const res = Object.assign(new EventEmitter(), { statusCode: r.status, headers: { 'content-type': r.type }, resume() {}, destroy() {} })
      cb(res); res.emit('data', Buffer.from(r.body)); res.emit('end')
    }
    return req
  }
  return () => { (https as { request: unknown }).request = real }
}
const registry = (over: Record<string, { status?: number; type?: string; body?: string }> = {}) => (u: string) => {
  const k = u.slice(recUrl('').length), o = over[k]
  return { status: o?.status ?? 200, type: o?.type ?? 'application/json', body: o?.body ?? JSON.stringify(RECORDS[k]) }
}
const draft = (it: { title: string; url: string; quote: string; date: string | null }, company: string, over: Partial<LeadDraft> = {}) =>
  ({ name: '', company, contact: null, signal: it.title, source_url: it.url, excerpt: it.quote, event_date: it.date, score: 80, ...over }) as LeadDraft

test('#763 source to lead through the unchanged verifier: the cited API record shows the registry date, so the lead is dated and page-bound', async () => {
  const { items } = await run('newly opened dental clinics in Norway', recorded([]))
  const it = items[0]
  const asked: { url: string; accept: string }[] = []; const restore = fakeHttps(registry(), asked)
  try {
    const o = await verifyLeads([draft(it, 'TANNADI DRIFT AS')], u => fetchPageDetailed(u, async () => null), new Date(NOW))
    assert.equal(o.leads.length, 1, JSON.stringify(o))
    assert.equal(o.leads[0].event_date, '2026-10-30'); assert.equal(o.leads[0].event_date, it.date)
    assert.equal(o.leads[0].event_date_proof, 'page_bound')
    assert.equal(o.leads[0].source_url, recUrl('enheter/938784884'))
    assert.deepEqual(asked.map(a => a.url), [recUrl('enheter/938784884')], 'the verifier re-read exactly the cited record')
    assert.deepEqual(asked.map(a => a.accept), ['application/json'], 'the register answers 406 to an HTML-only Accept (checked live), so the record read asks for JSON')
  } finally { restore() }
})

test('#763 negatives through the verifier: a claim the record does not state is never dated, and a foreign or malformed record is never read as evidence', async () => {
  const { items } = await run('newly opened dental clinics in Norway', recorded([]))
  const it = items[0], key = 'enheter/938784884'
  let restore = fakeHttps(registry())
  try {
    // a day other than the register's own: the fetched record never states it, so the lead is undated (held by the window gate), not dated by the claim
    const wrong = await verifyLeads([draft(it, 'TANNADI DRIFT AS', { event_date: '2026-10-20' })], u => fetchPageDetailed(u, async () => null), new Date(NOW))
    assert.ok(wrong.leads.every(l => l.event_date == null), JSON.stringify(wrong.leads.map(l => l.event_date)))
  } finally { restore() }
  const cases: [string, Record<string, { status?: number; type?: string; body?: string }>][] = [
    ['another entity\'s record under this URL', { [key]: { body: JSON.stringify(RECORDS['enheter/938756112']) } }],
    ['a record without a registration date', { [key]: { body: JSON.stringify({ ...RECORDS[key], registreringsdatoEnhetsregisteret: undefined }) } }],
    ['malformed JSON', { [key]: { body: '{"organisasjonsnummer":' } }],
    ['not acceptable (406)', { [key]: { status: 406, body: '' } }],
    ['an HTML body with a JSON content type', { [key]: { body: '<html><body>Just a moment...</body></html>' } }],
    ['JSON served as another content type', { [key]: { type: 'application/vnd.brreg+json' } }],
  ]
  for (const [what, over] of cases) {
    restore = fakeHttps(registry(over))
    try {
      const o = await verifyLeads([draft(it, 'TANNADI DRIFT AS')], u => fetchPageDetailed(u, async () => null), new Date(NOW))
      assert.deepEqual(o.leads.map(l => l.event_date), [], `${what}: no dated lead`)
    } finally { restore() }
  }
})

test('#763 the fetcher reads no JSON except the register\'s own record of an entity', async () => {
  const body = JSON.stringify({ organisasjonsnummer: '838791352', navn: 'PUNJABI MASALA AS', registreringsdatoEnhetsregisteret: '2026-10-31' })
  const urls = ['https://data.brreg.no/enhetsregisteret/api/enheter?naeringskode=56', 'https://data.brreg.no/enhetsregisteret/api/enheter/838791352/roller', 'https://example.com/enhetsregisteret/api/enheter/838791352', 'https://api.example.com/record.json']
  const asked: { url: string; accept: string }[] = []
  const restore = fakeHttps(() => ({ status: 200, type: 'application/json', body }), asked)
  try {
    for (const u of urls) { const r = await fetchPageDetailed(u, async () => null); assert.ok(isFail(r), u) }
    assert.ok(asked.length === urls.length && asked.every(a => a.accept === 'text/html,text/plain;q=0.9'), 'every other URL is still asked for HTML only')
    const ok = await fetchPageDetailed(recUrl('enheter/838791352'), async () => null)
    assert.ok(!isFail(ok) && /^PUNJABI MASALA AS \(organisasjonsnummer 838791352\)/.test(ok.text) && ok.published == null)
  } finally { restore() }
})

// #615 review (Instinct, 2026-11-04): an HTTP 200 with the wrong body was reported as a healthy empty market. Synthetic bodies below, served for the two list
// requests of an in-coverage request; the real collectEvidenceReport decides the run status, exactly as Instinct probed it.
const isList = (u: string, k: 'enheter' | 'underenheter') => u.startsWith(`${API}/${k}?`)
const bodyFor = (enheter: string | null, underenheter: string | null) => (u: string): HttpResult | undefined =>
  enheter !== null && isList(u, 'enheter') ? { status: 200, body: enheter } : underenheter !== null && isList(u, 'underenheter') ? { status: 200, body: underenheter } : undefined
async function report(query: string, http: SafeGet) {
  resetBrregState()
  return collectEvidenceReport({ adapters: ['brreg'], feeds: [] }, query, http, 5_000, [])
}
const MALFORMED: [string, string][] = [
  ['empty object', '{}'], ['array root', '[]'], ['error envelope', '{"error":"upstream schema changed"}'], ['null', 'null'], ['string', '"ok"'], ['number', '42'], ['boolean', 'true'],
  ['_embedded null', '{"_embedded":null,"page":{"totalElements":3}}'], ['_embedded array', '{"_embedded":[],"page":{"totalElements":0}}'],
  ['collection is an object', '{"_embedded":{"enheter":{},"underenheter":{}}}'], ['collection is a string', '{"_embedded":{"enheter":"none","underenheter":"none"}}'],
  ['collection null', '{"_embedded":{"enheter":null,"underenheter":null}}'], ['no _embedded but rows claimed', '{"page":{"totalElements":69}}'],
  ['page without _embedded, wrong type', '{"page":{"totalElements":"0"}}'], ['error beside an empty page', '{"error":"Bad Request","status":400,"page":{"totalElements":0}}'],
  ['Norwegian error envelope', '{"feilmelding":"Ugyldig parameter","_embedded":{"enheter":[],"underenheter":[]}}'],
]

test('#615: a malformed 200 body on both list reads is a schema failure (partial, noted), never a genuine empty market', async () => {
  for (const [what, body] of MALFORMED) {
    const out = await report('new restaurants in Oslo', recorded([], bodyFor(body, body)))
    assert.equal(out.runs.length, 1, what)
    assert.equal(out.runs[0].status, 'partial', `${what}: not "empty"`)
    assert.equal(out.runs[0].notes?.schema_invalid, 2, `${what}: both endpoints reported`)
    assert.equal(out.items.length, 0, what)
  }
})

test('#615: the wrong endpoint\'s collection is not this endpoint\'s answer', async () => {
  const swapped = await report('new restaurants in Oslo', recorded([], bodyFor('{"_embedded":{"underenheter":[]}}', '{"_embedded":{"enheter":[]}}')))
  assert.equal(swapped.runs[0].status, 'partial'); assert.equal(swapped.runs[0].notes?.schema_invalid, 2)
})

test('#615: documented empty pages stay a healthy empty (no notes)', async () => {
  const halEmpty = '{"_links":{"self":{"href":"https://data.brreg.no/enhetsregisteret/api/enheter"}},"page":{"size":20,"totalElements":0,"totalPages":0,"number":0}}'
  for (const [e, u] of [[halEmpty, halEmpty], ['{"_embedded":{"enheter":[]},"page":{"totalElements":0}}', '{"_embedded":{"underenheter":[]},"page":{"totalElements":0}}']]) {
    const out = await report('new restaurants in Oslo', recorded([], bodyFor(e, u)))
    assert.deepEqual(out.runs, [{ collector: 'adapter:brreg', status: 'empty', evidence: 0 }], e)
  }
  // extra keys beside a documented envelope are tolerated
  assert.deepEqual(brregList({ _embedded: { enheter: [] }, page: { totalElements: 0 }, _links: {}, extra: [1, 2] }, 'enheter'), { rows: [], invalid: 0 })
})

test('#615: a first page that contradicts its total is a schema failure, not an empty market', async () => {
  // this adapter only ever reads the FIRST page (the query has size= and sort= but no page=), so the envelope must agree with it
  const good = list('enheter-restaurant-oslo.json', 'enheter').find(e => e.navn === 'PUNJABI MASALA AS')!
  assert.equal(brregList({ _embedded: { enheter: [] }, page: { totalElements: 50 } }, 'enheter'), null, 'empty array, positive total')
  assert.equal(brregList({ _embedded: { enheter: [] } }, 'enheter'), null, 'empty array, no page at all')
  assert.equal(brregList({ _embedded: { enheter: [good, good] }, page: { totalElements: 1 } }, 'enheter'), null, 'rows outnumber the total')
  assert.deepEqual(brregList({ _embedded: { enheter: [] }, page: { totalElements: 0 } }, 'enheter'), { rows: [], invalid: 0 }, 'a total of 0 still vouches for the empty page')
  for (const [e, u] of [
    ['{"_embedded":{"enheter":[]},"page":{"totalElements":50}}', '{"_embedded":{"underenheter":[]},"page":{"totalElements":50}}'],
    ['{"_embedded":{"enheter":[]}}', '{"_embedded":{"underenheter":[]}}'],
    [JSON.stringify({ _embedded: { enheter: [good, good] }, page: { totalElements: 1 } }), JSON.stringify({ _embedded: { underenheter: [good, good] }, page: { totalElements: 1 } })],
  ]) {
    const out = await report('new restaurants in Oslo', recorded([], bodyFor(e, u)))
    assert.equal(out.runs[0].status, 'partial', `${e}: not "empty"`)
    assert.equal(out.runs[0].notes?.schema_invalid, 2, `${e}: both endpoints reported`)
    assert.equal(out.items.length, 0, e)
  }
})

test('#615: one good endpoint plus one malformed endpoint keeps the good evidence and reports the failure', async () => {
  // enheter recorded (holds PUNJABI MASALA AS, whose record is recorded); underenheter malformed
  for (const [, body] of MALFORMED) {
    const out = await report('new restaurants in Oslo', recorded([], bodyFor(null, body)))
    assert.equal(out.runs[0].status, 'partial'); assert.equal(out.runs[0].notes?.schema_invalid, 1)
    assert.ok(out.items.some(i => i.url === recUrl('enheter/838791352')), 'the new business from the good endpoint is still evidence')
  }
  // underenheter recorded; enheter malformed: the run is partial and nothing from the broken endpoint is invented
  const asked: string[] = []
  const out = await report('new restaurants in Oslo', recorded(asked, bodyFor('{}', null)))
  assert.equal(out.runs[0].status, 'partial'); assert.equal(out.runs[0].notes?.schema_invalid, 1)
  assert.ok(out.items.every(i => i.url.includes('/underenheter/')))
  assert.ok(asked.some(u => /\/enheter\/\d{9}$/.test(u)), 'the good endpoint\'s sub-units still had their parents looked up')
})

test('#615: malformed rows are dropped and reported one by one; the endpoint\'s good rows are kept; nothing throws', async () => {
  const good = list('enheter-restaurant-oslo.json', 'enheter').find(e => e.navn === 'PUNJABI MASALA AS')!
  const bad: unknown[] = [null, 'x', 5, true, [], {}, { ...good, navn: 123 }, { ...good, organisasjonsnummer: 838791352 }, { ...good, naeringskode1: '56.110' }, { ...good, naeringskode1: { kode: 56.11 } },
    { ...good, forretningsadresse: 'OSLO' }, { ...good, forretningsadresse: { kommunenummer: 301 } }, { ...good, registreringsdatoEnhetsregisteret: 20261031 }, { ...good, konkurs: 'false' },
    { ...good, slettedato: {} }, { ...good, organisasjonsform: ['AS'] }, { ...good, overordnetEnhet: 999999999 }]
  for (const b of bad) assert.equal(isBrregEntity(b), false, JSON.stringify(b))
  assert.equal(isBrregEntity(good), true)
  assert.equal(isBrregEntity({ ...good, konkurs: null, slettedato: null, beliggenhetsadresse: null, unknownField: { deep: [1] } }), true, 'null optionals and extra keys are fine')
  const body = JSON.stringify({ _embedded: { enheter: [...bad, good] }, page: { totalElements: bad.length + 1 } })
  const out = await report('new restaurants in Oslo', recorded([], bodyFor(body, '{"_embedded":{"underenheter":[]}}')))
  assert.equal(out.runs[0].status, 'partial')
  assert.equal(out.runs[0].notes?.schema_invalid_row, bad.length)
  assert.deepEqual(out.items.map(i => i.url), [recUrl('enheter/838791352')])
})

test('#615: a malformed parent record is a reported schema failure, not a silent drop or a crash', async () => {
  for (const parent of ['[]', '{}', 'null', '{"organisasjonsnummer":"000000000","navn":"SOMEONE ELSE AS","registreringsdatoEnhetsregisteret":"2020-01-01"}', '{"organisasjonsnummer":123,"navn":"X"}']) {
    const notes: string[] = []
    resetBrregState()
    const http = recorded([], u => /\/enheter\/\d{9}$/.test(u) ? { status: 200, body: parent } : undefined)
    const items = await brregAdapter.collect({ query: 'new restaurants and cafes in Oslo', keywords: [], feeds: [], http, note: c => notes.push(c) })
    assert.ok(notes.includes('schema_invalid'), parent)
    assert.ok(!items.some(i => i.url.includes('/underenheter/')), `${parent}: no opening without a valid parent record`)
  }
})

test('#615: transport-level malformations: truncated, non-UTF8 replacement bytes, huge nesting, a non-string body', async () => {
  const cases: [string, HttpResult][] = [
    ['oversize', { status: 200, body: '{"_embedded":{"enheter":[', truncated: true }],
    ['unparseable', { status: 200, body: '\uFFFD\uFFFE\u0000{"_embedded"' }],
    ['unparseable', { status: 200, body: null as unknown as string }],
  ]
  for (const [code, res] of cases) {
    const out = await report('new restaurants in Oslo', recorded([], u => isList(u, 'enheter') || isList(u, 'underenheter') ? res : undefined))
    assert.equal(out.runs[0].status, 'partial', code); assert.equal(out.runs[0].notes?.[code], 2, code)
  }
  const deep = '['.repeat(50_000) + ']'.repeat(50_000)
  const out = await report('new restaurants in Oslo', recorded([], u => isList(u, 'enheter') || isList(u, 'underenheter') ? { status: 200, body: deep } : undefined))
  assert.equal(out.runs[0].status, 'partial')
  assert.equal((out.runs[0].notes?.schema_invalid ?? 0) + (out.runs[0].notes?.unparseable ?? 0), 2)
})

test('#615: out of coverage is still skipped, never empty or partial', async () => {
  const out = await report('dentists in London', recorded([], bodyFor('{}', '{}')))
  assert.deepEqual(out.runs, [{ collector: 'adapter:brreg', status: 'skipped_out_of_coverage', evidence: null }])
})

test('#763 the scoreboard carries a Norway task that is inside brreg\'s coverage and selects brreg explicitly (brreg is never a default)', () => {
  const sb = JSON.parse(readFileSync(new URL('../../scoreboard/searches.json', import.meta.url), 'utf8')) as { id: string; query: string; sources?: unknown }[]
  const t = sb.find(s => s.id === 'norway-dental-registry')!
  assert.ok(t, 'the Norway task is on the scoreboard')
  assert.deepEqual(brregScope(t.query), { sector: 'dental', codes: ['86.23'], kommune: null, place: 'Norway' })
  assert.deepEqual(normalizeSources(t.sources), { adapters: ['brreg'], feeds: [], pages: [] })
  assert.ok(sb.filter(s => s.id !== t.id).every(s => s.sources === undefined), 'no other scoreboard search changed its sources')
})
