// #764 (part of #388): UK Companies House source adapter (new incorporation = the UK local-opening signal, owner decision on the issue). Real public company
// pages + documented-shape API fixtures (test/fixtures/companies-house/README.md says exactly which is which); no network here. Synthetic negatives are built inline.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { companiesHouseAdapter, chCandidates, chLimits, chList, chPageFacts, chPlaceMatch, chReject, chScope, isChCompany, normPlace, resetChState, type ChCompany } from '../lib/sources/companies-house.ts'
import { collectEvidenceReport, normalizeSources } from '../lib/sources/index.ts'
import { MATRIX, advertisable, availability, byId } from '../lib/sources/capability-matrix.ts'
import { verifyLeads, type LeadDraft } from '../lib/scan/runner.ts'
import type { HttpResult, SafeGet } from '../lib/sources/types.ts'

const dir = new URL('./fixtures/companies-house/', import.meta.url)
const J = (f: string) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'))
const PAGES = J('pages.json') as Record<string, string>
const SOFTWARE = J('search-software-london.json'), CONSTRUCTION = J('search-construction-uk.json')
const NOW = Date.parse('2026-02-05T12:00:00Z'), FROM = '2026-01-06', TODAY = '2026-02-05'
const KEY = 'test-key-not-a-secret'
chLimits.now = () => NOW; chLimits.key = () => KEY
const API = 'https://api.company-information.service.gov.uk/advanced-search/companies'
const URL_SOFTWARE = `${API}?incorporated_from=${FROM}&incorporated_to=${TODAY}&sic_codes=62012,62020,62090&company_status=active&location=London&size=100`
const URL_CONSTRUCTION = `${API}?incorporated_from=${FROM}&incorporated_to=${TODAY}&sic_codes=41202,43999&company_status=active&size=100`
const PAGE = (n: string) => `https://find-and-update.company-information.service.gov.uk/company/${n}`
const software = SOFTWARE.items[0] as ChCompany

function recorded(asked: string[], override: (u: string) => HttpResult | null | undefined = () => undefined): SafeGet {
  return async (u, o) => {
    asked.push(u)
    assert.equal(o?.accept, 'application/json')
    assert.equal(o?.headers?.authorization, `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`, 'the key goes in the Basic auth header only')
    const ov = override(u); if (ov !== undefined) return ov
    if (u === URL_SOFTWARE) return { status: 200, body: JSON.stringify(SOFTWARE) }
    if (u === URL_CONSTRUCTION) return { status: 200, body: JSON.stringify(CONSTRUCTION) }
    return { status: 404, body: '' }
  }
}
const pageOf = async (u: string) => PAGES[u] ?? null
async function run(query: string, http: SafeGet, page: ((u: string) => Promise<string | null>) | null = pageOf) {
  resetChState()
  const notes: string[] = []
  const items = await companiesHouseAdapter.collect({ query, keywords: [], feeds: [], http, page: page ?? undefined, note: c => notes.push(c) })
  return { items, notes }
}

test('scope: a UK place or "the UK" plus a mapped industry; anything else is out of coverage', () => {
  assert.deepEqual(chScope('new software companies in London'), { sector: 'software', codes: ['62012', '62020', '62090'], place: 'London', where: 'London' })
  assert.deepEqual(chScope('newly started builders in the UK'), { sector: 'construction', codes: ['41202', '43999'], place: null, where: 'the UK' })
  assert.equal(chScope('hairdressers in Glasgow')?.sector, 'hair_beauty')
  assert.equal(chScope('dentists in Oslo'), null, 'not a UK market')
  assert.equal(chScope('new companies in the UK'), null, 'no mapped industry: not a whole-register dump')
  assert.equal(chScope('dentists in Birmingham, AL'), null, 'Birmingham, Alabama is not the UK')
  assert.equal(chScope('restaurants in London, Ontario'), null)
  assert.equal(chScope('plumbers in Bristol, CT'), null)
  assert.equal(chScope('restaurants in Washington, USA'), null)
  assert.equal(chScope('barsoom startups in Londonderry'), null, 'word boundaries')
  assert.ok(chScope('plumbers in Bristol'), 'an unqualified UK city stays covered')
})

test('negative fixtures: dissolved, wrong type, other industry, other town, outside the window and malformed numbers are not new local businesses', () => {
  const scope = chScope('software companies in London')!
  assert.equal(chReject(software, scope, FROM, TODAY), null, 'the real London software company is a usable signal')
  const bad = (patch: Partial<ChCompany>) => chReject({ ...software, ...patch }, scope, FROM, TODAY) // synthetic, built inline from the real row
  assert.equal(bad({ company_status: 'dissolved' }), 'status')
  assert.equal(bad({ company_status: 'liquidation' }), 'status')
  assert.equal(bad({ company_status: undefined }), 'status')
  assert.equal(bad({ company_type: 'registered-overseas-entity' }), 'type')
  assert.equal(bad({ company_type: 'charitable-incorporated-organisation' }), 'type')
  assert.equal(bad({ sic_codes: ['56101'] }), 'sector')
  assert.equal(bad({ sic_codes: undefined }), 'sector')
  assert.equal(bad({ sic_codes: ['99999'] }), 'sector', 'dormant / unknown SIC is never a match')
  assert.equal(bad({ registered_office_address: { locality: 'Manchester' } }), 'place')
  assert.equal(bad({ registered_office_address: undefined }), 'place')
  assert.equal(bad({ date_of_creation: '2025-12-31' }), 'date')
  assert.equal(bad({ date_of_creation: '2026-02-06' }), 'date', 'a future date is not an incorporation')
  assert.equal(bad({ date_of_creation: '27/01/2026' }), 'date')
  assert.equal(bad({ company_number: '123' }), 'bad_id')
  assert.equal(bad({ company_name: '  ' }), 'bad_id')
  assert.equal(chReject({ ...software, registered_office_address: undefined }, chScope('software companies in the UK')!, FROM, TODAY), null, 'no place named: no place filter')
  assert.deepEqual(chCandidates(scope, [{ ...software, company_number: 'SC123456', date_of_creation: '2026-01-10' }, software, { ...software, company_status: 'dissolved' }], FROM, TODAY).map(c => c.company_number), ['16990000', 'SC123456'], 'Scottish numbers are valid; newest first')
})

test('envelope: only the documented shape counts as an answer; anything else is a schema failure, never a healthy empty', () => {
  assert.deepEqual(chList(SOFTWARE), { rows: SOFTWARE.items, invalid: 0, hits: 1 })
  assert.deepEqual(chList({ hits: 0, items: [] }), { rows: [], invalid: 0, hits: 0 })
  assert.deepEqual(chList({ hits: 0 }), { rows: [], invalid: 0, hits: 0 })
  assert.deepEqual(chList({ ...SOFTWARE, hits: '1' }), { rows: SOFTWARE.items, invalid: 0, hits: 1 }, 'the spec types hits as a string')
  assert.equal(chList({ ...SOFTWARE, hits: '1.5' }), null); assert.equal(chList({ ...SOFTWARE, hits: 'many' }), null)
  for (const v of [{}, [], null, 'ok', 42, { errors: [{ error: 'x' }], hits: 0 }, { hits: 3 }, { hits: -1, items: [] }, { hits: 0, items: {} }, { hits: 1, items: [] }, { hits: 1, items: [software, software] }, { items: [software] }])
    assert.equal(chList(v), null, JSON.stringify(v))
  assert.deepEqual(chList({ hits: 2, items: [software, { company_name: 'X' }] })?.invalid, 1, 'a malformed row is dropped and counted')
  assert.equal(isChCompany({ ...software, sic_codes: [62012] }), false)
  assert.equal(isChCompany({ ...software, registered_office_address: { locality: 5 } }), false)
})

test('page facts: name next to its number, status Active and the incorporation date must all be on the cited page', () => {
  const u = PAGE('16990000')
  const f = chPageFacts(PAGES[u], 'HOME ED COMPANION LTD', '16990000')!
  assert.deepEqual(f, { quote: 'HOME ED COMPANION LTD Company number 16990000', date: '2026-01-27' })
  assert.ok(PAGES[u].includes(f.quote) && f.quote.length >= 20 && f.quote.length <= 300)
  assert.equal(chPageFacts(PAGES[u], 'HOME ED COMPANION LTD', '17000000'), null, 'wrong company number')
  assert.equal(chPageFacts(PAGES[u], 'OTHER LTD', '16990000'), null, 'wrong name')
  assert.equal(chPageFacts(PAGES[u].replace('Company status Active', 'Company status Dissolved'), 'HOME ED COMPANION LTD', '16990000'), null, 'not active')
  assert.equal(chPageFacts(PAGES[u].replace(/Incorporated on [^A]+/, ''), 'HOME ED COMPANION LTD', '16990000'), null, 'no incorporation date shown')
  assert.equal(chPageFacts('Search for a company or officer', 'HOME ED COMPANION LTD', '16990000'), null, 'a page that does not show the company')
})

test('adapter: a new London software company cites its own public page; the key is sent only as Basic auth', async () => {
  const asked: string[] = []
  const { items, notes } = await run('new software companies in London', recorded(asked))
  assert.deepEqual(asked, [URL_SOFTWARE], 'one list request, no page reads through the API client')
  assert.deepEqual(notes, [])
  assert.equal(items.length, 1)
  const i = items[0]
  assert.deepEqual([i.source, i.url, i.date], ['companies-house', PAGE('16990000'), '2026-01-27'])
  assert.match(i.title, /^Newly incorporated in London: HOME ED COMPANION LTD \(Companies House, incorporated 2026-01-27; SIC 62012 - software\)$/)
  assert.ok(PAGES[i.url].includes(i.quote)); assert.ok(!JSON.stringify(i).includes(KEY) && !asked.join().includes(KEY), 'the key never reaches a URL or an item')
})

test('adapter: UK-wide construction request returns the Mildenhall company; a page that disagrees with the API is dropped', async () => {
  const { items, notes } = await run('new construction companies in the UK', recorded([]))
  assert.deepEqual(items.map(i => [i.url, i.date]), [[PAGE('17000000'), '2026-01-29']]); assert.match(items[0].title, /in Mildenhall: POINTE AND BEAM LTD/); assert.deepEqual(notes, [])
  // synthetic: the API says one date, the company's own page shows another -> not evidence
  let r = await run('new construction companies in the UK', recorded([], u => u === URL_CONSTRUCTION ? { status: 200, body: JSON.stringify({ ...CONSTRUCTION, items: [{ ...CONSTRUCTION.items[0], date_of_creation: '2026-01-30' }] }) } : undefined))
  assert.deepEqual([r.items, r.notes], [[], ['page_mismatch']])
  // another company's page served for this URL
  r = await run('new construction companies in the UK', recorded([]), async () => PAGES[PAGE('16990000')])
  assert.deepEqual([r.items, r.notes], [[], ['page_mismatch']])
  r = await run('new construction companies in the UK', recorded([]), async () => null)
  assert.deepEqual([r.items, r.notes], [[], ['unreadable']])
})

test('failures are reported, never an empty market: no key, out of coverage, auth, throttling, unreachable, unparseable, schema, truncation, no page reader, budget', async () => {
  const asked: string[] = []
  let r = await run('dentists in Oslo', recorded(asked))
  assert.deepEqual([r.items, r.notes, asked.length], [[], ['out_of_coverage'], 0])
  const savedKey = chLimits.key; chLimits.key = () => '  '
  try { r = await run('new software companies in London', recorded(asked)) } finally { chLimits.key = savedKey }
  assert.deepEqual([r.items, r.notes, asked.length], [[], ['credential_missing'], 0], 'no key: nothing requested, reported as missing credential')
  for (const [status, note] of [[401, 'auth_or_blocked'], [403, 'auth_or_blocked'], [429, 'throttled'], [400, 'unreachable'], [500, 'unreachable']] as const) {
    r = await run('new software companies in London', recorded([], () => ({ status, body: '' })))
    assert.deepEqual([r.items, r.notes], [[], [note]], String(status))
  }
  // the spec's documented "404 No companies found" is a genuine empty market: healthy empty, no note
  r = await run('new software companies in London', recorded([], () => ({ status: 404, body: '' }))); assert.deepEqual([r.items, r.notes], [[], []])
  r = await run('new software companies in London', recorded([], () => null)); assert.deepEqual(r.notes, ['unreachable'])
  r = await run('new software companies in London', recorded([], () => ({ status: 200, body: '<html>' }))); assert.deepEqual(r.notes, ['unparseable'])
  r = await run('new software companies in London', recorded([], () => ({ status: 200, body: '{}', truncated: true }))); assert.deepEqual(r.notes, ['oversize'])
  r = await run('new software companies in London', recorded([], () => ({ status: 200, body: '{}' }))); assert.deepEqual([r.items, r.notes], [[], ['schema_invalid']])
  r = await run('new software companies in London', recorded([], () => ({ status: 200, body: JSON.stringify({ ...SOFTWARE, hits: 450 }) })))
  assert.equal(r.items.length, 1); assert.deepEqual(r.notes, ['truncated'], 'more matches than the one page read: says so')
  r = await run('new software companies in London', recorded([]), null); assert.deepEqual([r.items, r.notes], [[], ['no_page_reader']])
  const none: string[] = [], saved = chLimits.budgetMs; chLimits.budgetMs = -1
  try { r = await run('new software companies in London', recorded(none)) } finally { chLimits.budgetMs = saved }
  assert.deepEqual([r.items, r.notes], [[], ['budget']])
})

test('hourly cap: the request over the cap is not made and is reported as budget', async () => {
  resetChState()
  const asked: string[] = []
  // MAX_CALLS defaults to 60: spend it, then the 61st scan asks nothing
  for (let i = 0; i < 60; i++) await companiesHouseAdapter.collect({ query: 'new software companies in London', keywords: [], feeds: [], http: recorded(asked), page: pageOf })
  const notes: string[] = []
  const before = asked.length
  await companiesHouseAdapter.collect({ query: 'new software companies in London', keywords: [], feeds: [], http: recorded(asked), page: pageOf, note: c => notes.push(c) })
  assert.deepEqual([asked.length - before, notes], [0, ['budget']])
})

test('wired into source selection: accepted by the validator, reported per run (partial without a key, skipped out of coverage), never a default', async () => {
  assert.deepEqual(normalizeSources({ adapters: ['companies-house'] }), { adapters: ['companies-house'], feeds: [], pages: [] })
  resetChState()
  let out = await collectEvidenceReport({ adapters: ['companies-house'], feeds: [] }, 'dentists in Oslo', recorded([]), 5_000, [], pageOf)
  assert.deepEqual(out.runs, [{ collector: 'adapter:companies-house', status: 'skipped_out_of_coverage', evidence: null }])
  const savedKey = chLimits.key; chLimits.key = () => ''
  try { out = await collectEvidenceReport({ adapters: ['companies-house'], feeds: [] }, 'new software companies in London', recorded([]), 5_000, [], pageOf) } finally { chLimits.key = savedKey }
  assert.deepEqual(out.runs, [{ collector: 'adapter:companies-house', status: 'partial', evidence: 0, notes: { credential_missing: 1 } }], 'a missing key is a failure to read, not an empty market')
  resetChState()
  out = await collectEvidenceReport({ adapters: ['companies-house'], feeds: [] }, 'new software companies in London', recorded([]), 5_000, [], pageOf)
  assert.deepEqual([out.runs[0].status, out.items.length], ['ok', 1])
  resetChState()
  out = await collectEvidenceReport({ adapters: ['companies-house'], feeds: [] }, 'new software companies in London', recorded([], () => ({ status: 404, body: '' })), 5_000, [], pageOf)
  assert.deepEqual(out.runs, [{ collector: 'adapter:companies-house', status: 'empty', evidence: 0 }], 'documented 404 No companies found')
})

test('capability matrix: shipped, GB, official registry with registry date, key-dependent (unavailable without it), not advertisable until live evidence exists', () => {
  const c = byId('companies-house')!
  assert.deepEqual([c.status, c.markets, c.signals, c.access, c.dateProof, c.identityProof, c.credentialEnv], ['shipped', ['GB'], ['new_company'], 'official_registry', 'registry_filing_date', 'domain_or_registry_id', 'COMPANIES_HOUSE_API_KEY'])
  assert.equal(availability(c, { workers: new Set() }), 'unavailable'); assert.equal(availability(c, { workers: new Set(), credentials: new Set() }), 'unavailable')
  assert.equal(availability(c, { workers: new Set(), credentials: new Set(['COMPANIES_HOUSE_API_KEY']) }), 'available')
  assert.equal(advertisable(c), false, 'no live source-to-lead evidence yet: stays "merged, test-only"')
  assert.ok(MATRIX.find(m => m.id === 'local-openings-permits')!.markets.every(m => m !== 'GB'), 'GB is no longer claimed as a gap')
})

test('source to lead through the unchanged verifier: identity and quote pass on the cited page; the registry date is NOT tied to the company by the page, so the lead is undated', async () => {
  const { items } = await run('new software companies in London', recorded([]))
  const it = items[0]
  const lead: LeadDraft = { name: '', company: 'HOME ED COMPANION LTD', contact: null, signal: it.title, source_url: it.url, excerpt: it.quote, event_date: it.date, score: 80 } as LeadDraft
  const o = await verifyLeads([lead], async u => ({ text: PAGES[u], title: 'HOME ED COMPANION LTD overview - Find and update company information - GOV.UK', retrievedAt: 1, published: null }), new Date(NOW))
  assert.equal(o.leads.length, 1, 'the cited page is re-read and the quote is found on it')
  assert.equal(o.leads[0].event_date, null, 'no gate is loosened: the verifier does not tie the registry date to the company on the page, so the lead is undated (as brreg)')
  assert.match(String((o.leads[0] as LeadDraft & { timing_note?: string }).timing_note), /not tied to this company and event by the fetched page.*treated as undated/)
  // a lead whose company is not the one on the page is refused by the same verifier
  const other = await verifyLeads([{ ...lead, company: 'SOME OTHER LTD' } as LeadDraft], async u => ({ text: PAGES[u], title: 'x', retrievedAt: 1, published: null }), new Date(NOW))
  assert.equal(other.leads.length, 0)
})

test('#764 review: a named town outside the gazetteer is out of coverage, not a silent UK-wide search', async () => {
  assert.equal(chScope('new software companies in Oxford UK'), null)
  assert.equal(chScope('plumbers near Reading, England'), null)
  assert.ok(chScope('new software companies in the UK'), 'country words alone stay UK-wide')
  assert.ok(chScope('plumbers in London, England'), 'a known place plus a country word stays covered')
  const asked: string[] = []
  const r = await run('new software companies in Oxford UK', recorded(asked))
  assert.deepEqual([r.items, r.notes, asked.length], [[], ['out_of_coverage'], 0], 'nothing requested')
})

test('#764 review: candidates beyond the page cap are reported as truncated, not a complete run', async () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ ...software, company_number: `1699000${i}`, date_of_creation: `2026-01-${String(10 + i).padStart(2, '0')}` }))
  const body = JSON.stringify({ ...SOFTWARE, hits: '7', items: many })
  const asked: string[] = []
  const r = await run('new software companies in London', recorded(asked, u => (u === URL_SOFTWARE ? { status: 200, body } : undefined)), async () => null)
  assert.equal(r.notes.filter(n => n === 'truncated').length, 1, 'hits === items, yet 7 > maxPages candidates: says so once')
  assert.equal(r.notes.filter(n => n === 'unreadable').length, chLimits.maxPages, 'only maxPages pages were read')
})

test('#1035 Ziggy review: the registered-office town must be the WHOLE place name, never a substring (Londonderry is not London)', () => {
  const at = (q: string, address: unknown) => chReject({ ...software, registered_office_address: address as ChCompany['registered_office_address'] }, chScope(q)!, FROM, TODAY)
  const london = (address: unknown) => at('software companies in London', address)
  const newcastle = (address: unknown) => at('software companies in Newcastle', address)
  // Ziggy's probes
  assert.equal(london({ locality: 'London' }), null)
  assert.equal(london({ locality: 'Londonderry' }), 'place', 'Londonderry is not London (place name inside a longer word)')
  assert.equal(newcastle({ locality: 'Newcastle-under-Lyme' }), 'place', 'Newcastle-under-Lyme is not Newcastle upon Tyne')
  assert.equal(newcastle({ locality: 'Newcastle upon Tyne' }), null)
  // normalisation: case, whitespace, punctuation, hyphens and diacritics do not change the name
  for (const l of ['LONDON', '  london ', 'London.', 'Lóndon', 'London\t']) assert.equal(london({ locality: l }), null, JSON.stringify(l))
  for (const l of ['NEWCASTLE-UPON-TYNE', 'Newcastle  upon  Tyne', 'Newcastle-upon-Tyne.', 'Newcastle On Tyne']) assert.equal(newcastle({ locality: l }), null, l)
  assert.equal(london({ locality: 'Croydon', region: 'Greater London' }), null, 'region Greater London is London')
  // the whole class: prefixes, suffixes, hyphenated compounds, upon/under/on forms, inside a longer word
  for (const l of ['North London Road', 'New London', 'Londonderry', 'Derry~Londonderry', 'London Colney', 'London-on-Sea', 'Londoner', 'Greater Londonshire', 'Stoke-London']) assert.equal(london({ locality: l }), 'place', l)
  for (const l of ['Newcastle-under-Lyme', 'Newcastle under Lyme', 'Newcastle Emlyn', 'Newcastleton', 'Newcastle-on-Clun', 'Newcastle upon Tyne Road', 'Newcastle']) assert.equal(newcastle({ locality: l }), 'place', l)
  assert.equal(newcastle({ locality: 'Newcastle', region: 'County Down' }), 'place', 'bare Newcastle in County Down is another town')
  assert.equal(newcastle({ locality: 'Newcastle', region: 'Tyne and Wear' }), null, 'bare Newcastle with its own region is the town')
  assert.equal(newcastle({ locality: 'Newcastle', region: 'Tyne & Wear' }), null)
  assert.equal(at('software companies in Manchester', { locality: 'Salford', region: 'Greater Manchester' }), 'place', 'a county is not the city')
  assert.equal(at('software companies in Birmingham', { locality: 'Birmingham', region: 'West Midlands' }), null)
})

test('#1035 Ziggy review: the request side reads the same whole names (Newcastle-under-Lyme is not a Newcastle request; nothing widens to the UK)', () => {
  assert.equal(chScope('software companies in Newcastle upon Tyne')?.place, 'Newcastle')
  assert.equal(chScope('software companies in Newcastle-upon-Tyne')?.place, 'Newcastle')
  assert.equal(chScope('software companies in Newcastle')?.place, 'Newcastle')
  assert.equal(chScope('London-based software companies')?.place, 'London', '"London-based" is London')
  assert.equal(chScope('new London software companies')?.place, 'London')
  assert.equal(chScope('dentists in London on Monday')?.place, 'London', 'a weekday after "on" is not part of the name')
  for (const q of ['software companies in Newcastle-under-Lyme', 'software companies in Newcastle under Lyme', 'Newcastle-under-Lyme software companies UK',
    'software companies in Newcastle on Clun, England', 'plumbers in Stoke-London UK', 'software companies in Londonderry UK']) assert.equal(chScope(q), null, q)
})

test('#1035 adversarial: place helpers fail closed on null, empty, non-string, huge and odd unicode input, and stay linear on pathological strings', () => {
  for (const v of [null, undefined, 42, true, {}, [], ['London'], { locality: 'London' }, '', '   ', 'x'.repeat(121)]) assert.equal(normPlace(v), '', JSON.stringify(v)?.slice(0, 20))
  assert.equal(normPlace('Ｌｏｎｄｏｎ'), 'london', 'full-width letters fold')
  for (const a of [null, undefined, 'London', 42, ['London'], {}, { locality: null }, { locality: 42 }, { locality: ['London'] }, { locality: { name: 'London' } }, { locality: '' },
    { locality: 'London'.repeat(30) }, { locality: 'Lon\u0000don' }, { locality: '\uD800London' }]) assert.equal(chPlaceMatch(a, 'London'), false, JSON.stringify(a))
  assert.equal(chPlaceMatch({ locality: 'London' }, 'Atlantis'), false, 'a place outside the gazetteer never matches')
  assert.equal(chPlaceMatch({ locality: 'London' }, null as unknown as string), false)
  for (const q of [null, undefined, 42, {}, [], '', '   ']) assert.equal(chScope(q as unknown as string), null, String(q))
  for (const v of [null, 42, {}, undefined]) assert.equal(chPageFacts(v as unknown as string, 'HOME ED COMPANION LTD', '16990000'), null, 'non-string page text fails closed (review note b)')
  assert.equal(chPageFacts('x', null as unknown as string, '16990000'), null)
  const t0 = Date.now()
  chScope(`software ${'London-'.repeat(20_000)}x UK`); chScope(`software ${'Newcastle under '.repeat(10_000)} UK`); chScope(`software in ${'a-'.repeat(50_000)}London`)
  normPlace(`${'- '.repeat(60)}`); chPlaceMatch({ locality: '-'.repeat(100_000), region: 'é'.repeat(100_000) }, 'London')
  assert.ok(Date.now() - t0 < 2000, `pathological inputs took ${Date.now() - t0} ms`)
})
