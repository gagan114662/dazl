// #388: Norway business register (Enhetsregisteret) source adapter. Recorded fixtures from the live public API and entity pages
// (test/fixtures/brreg/README.md says exactly which requests); no network here. Synthetic cases are built inline and say so.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { brregAdapter, brregCandidates, brregLimits, brregList, brregQuote, brregReject, brregScope, isBrregEntity, resetBrregState, type BrregEntity } from '../lib/sources/brreg.ts'
import { collectEvidenceReport, normalizeSources } from '../lib/sources/index.ts'
import { buildSources } from '../lib/sources/ui-sources.ts'
import { verifyLeads, type LeadDraft } from '../lib/scan/runner.ts'
import type { HttpResult, SafeGet } from '../lib/sources/types.ts'

const dir = new URL('./fixtures/brreg/', import.meta.url)
const J = (f: string) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'))
const PAGES = J('pages.json') as Record<string, string>
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
    return { status: 404, body: '' }
  }
}
const pageOf = async (u: string) => PAGES[u] ?? null // a page that was not recorded reads as unreadable
async function run(query: string, http: SafeGet, page: ((u: string) => Promise<string | null>) | null = pageOf) {
  resetBrregState()
  const notes: string[] = []
  const items = await brregAdapter.collect({ query, keywords: [], feeds: [], http, page: page ?? undefined, note: c => notes.push(c) })
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

test('quote: cut from the entity page around its own organisation number; another entity\'s page gives nothing', () => {
  const u = 'https://virksomhet.brreg.no/nb/oppslag/enheter/838791352'
  const q = brregQuote(PAGES[u], 'PUNJABI MASALA AS', '838791352')!
  assert.ok(q.startsWith('PUNJABI MASALA AS Organisasjonsnummer 838 791 352') && PAGES[u].includes(q) && q.length <= 300 && !q.includes('Søk i'))
  assert.equal(brregQuote(PAGES[u], 'PUNJABI MASALA AS', '938786658'), null, 'wrong organisation number')
  assert.equal(brregQuote(PAGES[u], 'SMASH MAT AS', '838791352'), null, 'wrong name')
  assert.equal(brregQuote('Registersøk Virksomhetsopplysninger', 'PUNJABI MASALA AS', '838791352'), null, 'a page that does not show the entity')
})

test('adapter on recorded Oslo restaurants: openings and new businesses, each citing its own public page, within the per-scan budget', async () => {
  const asked: string[] = []
  const { items, notes } = await run('new restaurants and cafes in Oslo', recorded(asked))
  assert.deepEqual(items.map(i => i.url), [
    'https://virksomhet.brreg.no/nb/oppslag/underenheter/938737347',
    'https://virksomhet.brreg.no/nb/oppslag/underenheter/938797455',
    'https://virksomhet.brreg.no/nb/oppslag/enheter/838791352',
  ])
  for (const i of items) {
    assert.equal(i.source, 'brreg'); assert.ok(PAGES[i.url].includes(i.quote), 'the quote is on the cited page')
    assert.ok(i.date! >= FROM && i.date! <= TODAY); assert.ok(i.quote.length >= 20 && i.quote.length <= 300)
  }
  assert.match(items[0].title, /registered a new establishment in OSLO.*registered since 2024-12-04/)
  assert.match(items[2].title, /^New business registered in OSLO: PUNJABI MASALA AS \(Drift av restauranter/)
  // budget: 2 list requests + at most 4 parent lookups; at most 6 pages read; a capped run says so ('budget') instead of looking complete
  assert.equal(asked.filter(u => /\?naeringskode=/.test(u)).length, 2)
  assert.equal(asked.filter(u => /\/enheter\/\d{9}$/.test(u)).length, brregLimits.maxParents)
  assert.ok(notes.includes('budget'))
  assert.equal(notes.filter(n => n === 'unreadable').length, 3, 'three of the six candidate pages were not recorded: unreadable, not silently skipped')
})

test('adapter on recorded dental registrations nationwide: new businesses only (no false openings)', async () => {
  const { items } = await run('newly opened dental clinics in Norway', recorded([]))
  assert.deepEqual(items.map(i => i.url.split('/').pop()), ['938784884', '938756112', '838756042', '938739544'])
  assert.ok(items.every(i => /\/enheter\//.test(i.url) && /Tannlegetjenester/.test(i.title)))
})

test('failures are reported, never an empty market: out of coverage, unreachable, unparseable, no page reader, time budget', async () => {
  const asked: string[] = []
  let r = await run('dentists in London', recorded(asked))
  assert.deepEqual([r.items, r.notes, asked.length], [[], ['out_of_coverage'], 0], 'nothing is requested for a request outside coverage')
  r = await run('restaurants in Oslo', recorded([], () => ({ status: 503, body: '' })))
  assert.deepEqual(r.items, []); assert.ok(r.notes.includes('unreachable'))
  r = await run('restaurants in Oslo', recorded([], () => ({ status: 200, body: '<html>' })))
  assert.deepEqual(r.items, []); assert.ok(r.notes.includes('unparseable'))
  r = await run('restaurants in Oslo', recorded([]), null)
  assert.deepEqual([r.items, r.notes], [[], ['no_page_reader']])
  r = await run('restaurants in Oslo', recorded([]), async u => u.endsWith('838791352') ? PAGES['https://virksomhet.brreg.no/nb/oppslag/enheter/938786658'] : PAGES[u] ?? null)
  assert.ok(r.notes.includes('page_mismatch') && !r.items.some(i => i.url.endsWith('838791352')), 'a page showing another entity is not evidence for this one')
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
  const out = await collectEvidenceReport({ adapters: ['brreg'], feeds: [] }, 'dentists in London', recorded([]), 5_000, [], pageOf)
  assert.deepEqual(out.runs, [{ collector: 'adapter:brreg', status: 'skipped_out_of_coverage', evidence: null }])
  resetBrregState()
  const ok = await collectEvidenceReport({ adapters: ['brreg'], feeds: [] }, 'newly opened dental clinics in Norway', recorded([]), 5_000, [], pageOf)
  assert.equal(ok.items.length, 4); assert.equal(ok.runs[0].collector, 'adapter:brreg'); assert.equal(ok.runs[0].status, 'partial', 'capped parent lookups and unrecorded pages make it partial, not ok')
})

test('source to lead through the unchanged verifier: identity and quote pass on the cited page; the registry date is NOT on the page, so the lead is undated', async () => {
  const { items } = await run('newly opened dental clinics in Norway', recorded([]))
  const it = items[0]
  const lead: LeadDraft = { name: '', company: 'TANNADI DRIFT AS', contact: null, signal: it.title, source_url: it.url, excerpt: it.quote, event_date: it.date, score: 80 } as LeadDraft
  const o = await verifyLeads([lead], async u => ({ text: PAGES[u], title: 'Virksomhetsopplysninger - Brønnøysundregistrene', retrievedAt: 1, published: null }), new Date(NOW))
  assert.equal(o.leads.length, 1)
  assert.equal(o.leads[0].event_date, null, 'no gate is loosened: the verifier does not take the registry date the page itself does not show')
  assert.match(String((o.leads[0] as LeadDraft & { timing_note?: string }).timing_note), /treated as undated/)
})


// #615 review (Instinct, 2026-11-04): an HTTP 200 with the wrong body was reported as a healthy empty market. Synthetic bodies below, served for the two list
// requests of an in-coverage request; the real collectEvidenceReport decides the run status, exactly as Instinct probed it.
const isList = (u: string, k: 'enheter' | 'underenheter') => u.startsWith(`${API}/${k}?`)
const bodyFor = (enheter: string | null, underenheter: string | null) => (u: string): HttpResult | undefined =>
  enheter !== null && isList(u, 'enheter') ? { status: 200, body: enheter } : underenheter !== null && isList(u, 'underenheter') ? { status: 200, body: underenheter } : undefined
async function report(query: string, http: SafeGet) {
  resetBrregState()
  return collectEvidenceReport({ adapters: ['brreg'], feeds: [] }, query, http, 5_000, [], pageOf)
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
  for (const [e, u] of [[halEmpty, halEmpty], ['{"_embedded":{"enheter":[]},"page":{"totalElements":0}}', '{"_embedded":{"underenheter":[]},"page":{"totalElements":0}}'], ['{"_embedded":{"enheter":[]}}', '{"_embedded":{"underenheter":[]}}']]) {
    const out = await report('new restaurants in Oslo', recorded([], bodyFor(e, u)))
    assert.deepEqual(out.runs, [{ collector: 'adapter:brreg', status: 'empty', evidence: 0 }], e)
  }
  // extra keys beside a documented envelope are tolerated
  assert.deepEqual(brregList({ _embedded: { enheter: [] }, page: { totalElements: 0 }, _links: {}, extra: [1, 2] }, 'enheter'), { rows: [], invalid: 0 })
})

test('#615: one good endpoint plus one malformed endpoint keeps the good evidence and reports the failure', async () => {
  // enheter recorded (holds PUNJABI MASALA AS, whose page is recorded); underenheter malformed
  for (const [, body] of MALFORMED) {
    const out = await report('new restaurants in Oslo', recorded([], bodyFor(null, body)))
    assert.equal(out.runs[0].status, 'partial'); assert.equal(out.runs[0].notes?.schema_invalid, 1)
    assert.ok(out.items.some(i => i.url === 'https://virksomhet.brreg.no/nb/oppslag/enheter/838791352'), 'the new business from the good endpoint is still evidence')
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
  assert.deepEqual(out.items.map(i => i.url), ['https://virksomhet.brreg.no/nb/oppslag/enheter/838791352'])
})

test('#615: a malformed parent record is a reported schema failure, not a silent drop or a crash', async () => {
  for (const parent of ['[]', '{}', 'null', '{"organisasjonsnummer":"000000000","navn":"SOMEONE ELSE AS","registreringsdatoEnhetsregisteret":"2020-01-01"}', '{"organisasjonsnummer":123,"navn":"X"}']) {
    const notes: string[] = []
    resetBrregState()
    const http = recorded([], u => /\/enheter\/\d{9}$/.test(u) ? { status: 200, body: parent } : undefined)
    const items = await brregAdapter.collect({ query: 'new restaurants and cafes in Oslo', keywords: [], feeds: [], http, page: pageOf, note: c => notes.push(c) })
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
