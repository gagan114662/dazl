// #1102 named-contact fallback (lib/people/contact-research.ts): a person is kept only when every field the model returned
// is in the text of a source the search returned. TEST-ONLY fixtures: invented companies and people in the shape of real
// search results ("Name - Title - Employer | LinkedIn", a company team page, a news snippet). TinyFish and the model are
// stubbed: no network, no paid call.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateTinyfish, resetTinyfishState } from '../lib/search/tinyfish.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { researchContact, researchQueries, researchPrompt, type ResearchInput, readAnswer, groundPerson, readResearchInput, listedCostUsd, MAX_SEARCHES, MAX_READS, CONTACT_RESEARCH_MODEL, type Source } from '../lib/people/contact-research.ts'
import { anthropicWithModel, type Provider } from '../lib/llm/provider.ts'
import { modelCostUsd } from '../lib/scan/spend-cap.ts'
import { SpendRefused } from '../lib/llm/spend-guard.ts'

const env = { TINYFISH_API_KEY: 'k', TINYFISH_TENANT_DAILY: '50' }
const INPUT = { company: 'Brightloop Dental', domain: 'brightloopdental.example', roles: ['Owner', 'Practice owner', 'Office manager'], where: ['Toronto, Ontario'] }
const PROFILE_HIT = { url: 'https://ca.linkedin.com/in/jane-roe-test', title: 'Jane Roe - Owner - Brightloop Dental | LinkedIn', snippet: 'Toronto, Ontario, Canada · Owner · Brightloop Dental. Dentist and practice owner. · brightloopdental.example' }
const TEAM_HIT = { url: 'https://brightloopdental.example/team', title: 'Our team | Brightloop Dental', snippet: 'Meet Dr. Jane Roe, owner of Brightloop Dental in Toronto, and our hygienists.' }
const NEWS_HIT = { url: 'https://news.example.test/toronto-dental', title: 'Brightloop Dental opens second Toronto clinic', snippet: 'Owner Jane Roe said the new Brightloop Dental clinic on Queen Street opens in November. See brightloopdental.example' }
const OTHER_CO = { url: 'https://www.linkedin.com/in/sam-lee-test', title: 'Sam Lee - Owner - Brightloop Dental Supplies | LinkedIn', snippet: 'Columbus, Ohio · Owner · Brightloop Dental Supplies' }
const FORMER = { url: 'https://www.linkedin.com/in/pat-old-test', title: 'Pat Old - Former Owner - Brightloop Dental | LinkedIn', snippet: 'Toronto, Ontario · Former Owner · Brightloop Dental · brightloopdental.example' }
const HYGIENIST = { url: 'https://www.linkedin.com/in/hy-gene-test', title: 'Hy Gene - Dental Hygienist - Brightloop Dental | LinkedIn', snippet: 'Toronto, Ontario · Dental Hygienist · Brightloop Dental · brightloopdental.example' }
const PAGE_TEXT = `# Our team\n\nDr. Jane Roe, Owner and lead dentist, founded Brightloop Dental in Toronto in 2014. ${'We welcome new patients. '.repeat(10)}`

function setup() { const db = new Database(':memory:'); migrateAllSqlite(db); migrateTinyfish(db); resetTinyfishState(); return db }
type Calls = { searches: string[]; fetches: string[][]; prompts: string[] }
function stubs(results: unknown[][], answer: unknown, o: { searchStatus?: number; page?: string; usage?: { input_tokens: number; output_tokens: number }; stop?: string } = {}) {
  const calls: Calls = { searches: [], fetches: [], prompts: [] }
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    const url = new URL(String(u))
    if (url.hostname === 'api.search.tinyfish.ai') { calls.searches.push(url.searchParams.get('query') ?? ''); if (o.searchStatus) return new Response('{}', { status: o.searchStatus }); return new Response(JSON.stringify({ results: results[calls.searches.length - 1] ?? [] })) }
    if (url.hostname.endsWith('tinyfish.ai')) { const urls = (JSON.parse(String(init?.body ?? '{}')) as { urls?: string[] }).urls ?? []; calls.fetches.push(urls); return new Response(JSON.stringify({ results: urls.map(x => ({ url: x, title: 'Our team | Brightloop Dental', text: o.page ?? PAGE_TEXT })) })) }
    throw new Error(`unexpected request ${url.hostname}`)
  }) as unknown as typeof fetch
  const provider: Provider = {
    research: async () => { throw new Error('never') },
    configuredModel: () => CONTACT_RESEARCH_MODEL,
    completeDetailed: async (_k, prompt) => { calls.prompts.push(prompt); return { text: typeof answer === 'string' ? answer : JSON.stringify(answer), model: CONTACT_RESEARCH_MODEL, usage: o.usage ?? { input_tokens: 1800, output_tokens: 240 }, ...(o.stop ? { stop: o.stop } : {}) } },
  }
  return { calls, deps: (db: Database.Database) => ({ db, tenantId: 'A', provider, apiKey: 'sk-test', env, fetchImpl }) }
}
const person = (name: string, title: string, source: string, quote: string, linkedin_source: string | null = null) => ({ person: { name, title, source, quote, linkedin_source } })

test('#1102 a person named in a search result with the title, at this company, is kept with the profile URL the search returned', async () => {
  const s = stubs([[PROFILE_HIT, OTHER_CO], [NEWS_HIT]], person('Jane Roe', 'Owner', 'S1', 'Jane Roe - Owner - Brightloop Dental', 'S1'))
  const r = await researchContact(INPUT, s.deps(setup()))
  assert.equal(r.status, 'found', JSON.stringify(r))
  assert.deepEqual(r.person, { name: 'Jane Roe', title: 'Owner', linkedin: 'https://ca.linkedin.com/in/jane-roe-test', source_url: 'https://ca.linkedin.com/in/jane-roe-test', quote: 'Jane Roe - Owner - Brightloop Dental', place: 'agrees' })
  assert.deepEqual(r.usage, { searches: 2, reads: 0, model: CONTACT_RESEARCH_MODEL, input_tokens: 1800, output_tokens: 240 })
  assert.equal(s.calls.searches.length, MAX_SEARCHES); assert.equal(s.calls.prompts.length, 1, 'one model call, never retried')
  assert.match(s.calls.searches[0], /^site:linkedin\.com\/in "Brightloop Dental" \("Owner" OR "Practice owner" OR "Office manager"\)$/)
  assert.match(s.calls.searches[1], /^"Brightloop Dental" Toronto, Ontario \("Owner" OR "Practice owner" OR "Office manager" OR "Founder"\)$/)
  assert.deepEqual(r.sources.map(x => x.url), [PROFILE_HIT.url, OTHER_CO.url, NEWS_HIT.url], 'every source shown to the model is listed')
})

test('#1102 a news story names the person; the profile is a separate result: kept with the LinkedIn URL only because that result names the same person at the company', async () => {
  const s = stubs([[PROFILE_HIT], [NEWS_HIT]], person('Jane Roe', 'Owner', 'S2', 'Owner Jane Roe said the new Brightloop Dental clinic', 'S1'))
  const r = await researchContact(INPUT, s.deps(setup()))
  assert.equal(r.status, 'found'); assert.equal(r.person?.source_url, NEWS_HIT.url); assert.equal(r.person?.linkedin, PROFILE_HIT.url); assert.equal(r.linkedin_refused, null)
})

test('#1102 the company\'s own page is read once (confirmed domain only) and can be the source; no LinkedIn URL is invented for it', async () => {
  const s = stubs([[], [TEAM_HIT]], person('Jane Roe', 'Owner and lead dentist', 'S2', 'Dr. Jane Roe, Owner and lead dentist, founded Brightloop Dental'))
  const r = await researchContact(INPUT, s.deps(setup()))
  assert.equal(r.status, 'found', JSON.stringify(r))
  assert.deepEqual(s.calls.fetches, [['https://brightloopdental.example/team']]); assert.equal(r.usage.reads, MAX_READS)
  assert.equal(r.person?.source_url, 'https://brightloopdental.example/team'); assert.equal(r.person?.linkedin, null, 'named, no LinkedIn: never a built URL')
  // No confirmed domain: the same hit is not read (the snippet is still a source).
  const s2 = stubs([[], [TEAM_HIT]], { person: null }); const r2 = await researchContact({ ...INPUT, domain: null }, s2.deps(setup()))
  assert.deepEqual(s2.calls.fetches, []); assert.equal(r2.usage.reads, 0); assert.equal(r2.status, 'none'); assert.equal(r2.refused, 'model_found_nobody')
})

test('#1102 nothing from the model\'s memory: a name, title, quote, source or profile that is not in the sources is refused', async () => {
  const cases: [string, unknown, string][] = [
    ['a person no source names', person('Maria Gomez', 'Owner', 'S1', 'Maria Gomez - Owner - Brightloop Dental'), 'quote_not_in_source'],
    ['a real quote, a different name', person('Maria Gomez', 'Owner', 'S1', 'Jane Roe - Owner - Brightloop Dental'), 'name_not_in_source'],
    ['a title the source does not give', person('Jane Roe', 'Chief Executive Officer', 'S1', 'Jane Roe - Owner - Brightloop Dental'), 'title_not_in_source'],
    ['a source id that was never shown', person('Jane Roe', 'Owner', 'S99', 'Jane Roe - Owner - Brightloop Dental'), 'source_not_shown'],
    ['a first name only', person('Jane', 'Owner', 'S1', 'Jane Roe - Owner - Brightloop Dental'), 'not_a_full_name'],
    ['a same-name company elsewhere', person('Sam Lee', 'Owner', 'S2', 'Sam Lee - Owner - Brightloop Dental Supplies'), 'profile_of_another_employer'],
    ['a longer-named company in a news line', person('Kim Park', 'Owner', 'S5', 'Kim Park, Owner of Brightloop Dental Supplies'), 'source_does_not_name_company'],
    ['a past role', person('Pat Old', 'Former Owner', 'S3', 'Pat Old - Former Owner - Brightloop Dental'), 'past_role'],
    ['a past role hidden in the quote ("Former" sits between the name and the title)', person('Pat Old', 'Owner', 'S3', 'Pat Old - Former Owner - Brightloop Dental'), 'title_not_next_to_name'],
    ['not a buyer role', person('Hy Gene', 'Dental Hygienist', 'S4', 'Hy Gene - Dental Hygienist - Brightloop Dental'), 'not_a_buyer_role'],
  ]
  for (const [what, answer, why] of cases) {
    const s = stubs([[PROFILE_HIT, OTHER_CO, FORMER, HYGIENIST, { url: 'https://news.example.test/supplies', title: 'Supplier news', snippet: 'Kim Park, Owner of Brightloop Dental Supplies, on the Toronto market.' }], []], answer)
    const r = await researchContact(INPUT, s.deps(setup()))
    assert.equal(r.status, 'not_grounded', what); assert.equal(r.refused, why, what); assert.equal(r.person, null, what)
  }
  // The company named only as someone else's text: a result that does not name the company at all.
  const s = stubs([[{ url: 'https://news.example.test/x', title: 'Dentists to watch', snippet: 'Jane Roe, Owner of a busy downtown practice, on growth.' }], []], person('Jane Roe', 'Owner', 'S1', 'Jane Roe, Owner of a busy downtown practice'))
  assert.equal((await researchContact(INPUT, s.deps(setup()))).refused, 'source_does_not_name_company')
})

test('#1102 a LinkedIn URL is only ever one the search returned for this person at this company; otherwise the person is kept without it', async () => {
  const cases: [string, unknown[], unknown, string][] = [
    ['the model points at someone else\'s profile', [NEWS_HIT, OTHER_CO], person('Jane Roe', 'Owner', 'S1', 'Owner Jane Roe said the new Brightloop Dental clinic', 'S2'), 'profile_names_someone_else'],
    ['the model points at a result that is not a profile', [NEWS_HIT, TEAM_HIT], person('Jane Roe', 'Owner', 'S1', 'Owner Jane Roe said the new Brightloop Dental clinic', 'S2'), 'not_a_profile_result'],
    ['the model points at an id that was not shown', [NEWS_HIT], person('Jane Roe', 'Owner', 'S1', 'Owner Jane Roe said the new Brightloop Dental clinic', 'S7'), 'profile_source_not_shown'],
    ['a same-name person at another employer', [NEWS_HIT, { url: 'https://www.linkedin.com/in/jane-roe-other', title: 'Jane Roe - Owner - Roe Bakery | LinkedIn', snippet: 'Toronto · Owner · Roe Bakery' }], person('Jane Roe', 'Owner', 'S1', 'Owner Jane Roe said the new Brightloop Dental clinic', 'S2'), 'profile_does_not_name_company'],
  ]
  for (const [what, hits, answer, why] of cases) {
    const s = stubs([hits, []], answer)
    const r = await researchContact(INPUT, s.deps(setup()))
    assert.equal(r.status, 'found', what); assert.equal(r.person?.name, 'Jane Roe', what); assert.equal(r.person?.linkedin, null, what); assert.equal(r.linkedin_refused, why, what)
  }
  // A URL the model writes itself is not a source id: it can never become the link.
  const s = stubs([[NEWS_HIT], []], '{"person": {"name": "Jane Roe", "title": "Owner", "source": "S1", "quote": "Owner Jane Roe said the new Brightloop Dental clinic", "linkedin_source": "https://www.linkedin.com/in/jane-roe-invented"}}')
  const r = await researchContact(INPUT, s.deps(setup()))
  assert.equal(r.status, 'found'); assert.equal(r.person?.linkedin, null, 'the written URL is never used'); assert.equal(r.linkedin_refused, 'profile_source_not_shown')
})

test('#1102 the place: a source naming another place is refused when the request names one', async () => {
  const ohio = { url: 'https://www.linkedin.com/in/jo-roe-test', title: 'Jo Roe - Owner - Brightloop Dental | LinkedIn', snippet: 'Columbus, Ohio, United States · Owner · Brightloop Dental · brightloopdental.example' }
  const s = stubs([[ohio], []], person('Jo Roe', 'Owner', 'S1', 'Jo Roe - Owner - Brightloop Dental', 'S1'))
  const r = await researchContact(INPUT, s.deps(setup()))
  assert.equal(r.status, 'not_grounded'); assert.equal(r.refused, 'another_place')
})

test('#1102 no search answer or no results: no model call is made and nothing is returned', async () => {
  { const s = stubs([], { person: null }, { searchStatus: 503 }); const r = await researchContact(INPUT, s.deps(setup()))
    assert.equal(r.status, 'search_failed'); assert.equal(r.refused, 'unavailable'); assert.equal(s.calls.prompts.length, 0); assert.equal(r.usage.searches, 2) }
  { const s = stubs([[], []], { person: null }); const r = await researchContact(INPUT, s.deps(setup()))
    assert.equal(r.status, 'none'); assert.equal(r.refused, 'no_results'); assert.equal(s.calls.prompts.length, 0); assert.equal(r.usage.model, null) }
  { const s = stubs([[PROFILE_HIT]], 'I think the owner is probably Jane.'); const r = await researchContact(INPUT, s.deps(setup())); assert.equal(r.status, 'model_failed'); assert.equal(r.refused, 'answer_unreadable') }
  { const s = stubs([[PROFILE_HIT]], '{"person": {"name": "Jane Roe"', { stop: 'max_tokens' }); const r = await researchContact(INPUT, s.deps(setup())); assert.equal(r.refused, 'answer_cut_off') }
  { const s = stubs([[PROFILE_HIT]], { person: null }); const r = await researchContact({ company: ' ' }, s.deps(setup())); assert.equal(r.status, 'bad_input'); assert.equal(s.calls.searches.length, 0) }
})

test('#1102 the prompt shows only the numbered sources and forbids memory; queries are bounded and quote-safe', () => {
  const sources: Source[] = [{ id: 'S1', url: PROFILE_HIT.url, title: PROFILE_HIT.title, text: PROFILE_HIT.snippet, kind: 'search' }]
  const p = researchPrompt(INPUT, sources)
  assert.match(p, /Use ONLY these sources\. Do not use anything you remember/); assert.match(p, /\[S1\] RESULT https:\/\/ca\.linkedin\.com\/in\/jane-roe-test/); assert.match(p, /never write a URL yourself/)
  const big = Array.from({ length: 400 }, (_, i) => ({ id: `S${i + 1}`, url: `https://x.example/${i}`, title: 't', text: 'y'.repeat(400), kind: 'search' as const }))
  assert.ok(Buffer.byteLength(researchPrompt(INPUT, big)) <= 60_000, 'the prompt is size-bounded')
  assert.deepEqual(researchQueries({ company: 'Acme "Labs" (UK)', roles: [] }), ['site:linkedin.com/in "Acme Labs UK" ("Founder" OR "Co-founder" OR "Owner")', '"Acme Labs UK" ("Founder" OR "Co-founder" OR "Owner" OR "CEO")'])
  assert.deepEqual(researchQueries({ company: 'x' }), [])
  for (const q of researchQueries({ company: 'A'.repeat(200), roles: ['B'.repeat(200)] })) assert.ok(q.length <= 300)
  assert.equal(readAnswer('{"person": null}'), null); assert.equal(readAnswer('nope'), 'unreadable'); assert.equal(readAnswer('{"person": []}'), 'unreadable'); assert.equal(readAnswer('{"person": {"name": 5}}'), 'unreadable')
  assert.deepEqual(groundPerson({ name: 'Jane Roe', title: 'Owner', source: 'S1', quote: 'jane roe - owner - brightloop dental', linkedin_source: null }, sources, INPUT), { person: { name: 'Jane Roe', title: 'Owner', linkedin: PROFILE_HIT.url, source_url: PROFILE_HIT.url, quote: 'jane roe - owner - brightloop dental', place: 'agrees' }, linkedin_refused: null })
})

test('#1102 request body and cost helpers are strict', () => {
  assert.deepEqual(readResearchInput({ company: ' Brightloop  Dental ', domain: 'BrightloopDental.example', roles: ['Owner'], where: ['Toronto'] }), { input: { company: 'Brightloop Dental', domain: 'brightloopdental.example', roles: ['Owner'], where: ['Toronto'] }, model: 'haiku' })
  assert.equal(readResearchInput({ company: 'Acme', model: 'default' })?.model, 'default')
  for (const bad of [null, [], 'x', {}, { company: 'A' }, { company: 'A'.repeat(81) }, { company: 'Acme', roles: 'Owner' }, { company: 'Acme', roles: [5] }, { company: 'Acme', roles: Array(7).fill('Owner') }, { company: 'Acme', domain: 'http://acme.example/x' }, { company: 'Acme', domain: 'localhost' }, { company: 'Acme', model: 'opus' }, { company: 'Acme', where: ['a', 'b', 'c', 'd'].map(x => x + x) }])
    assert.equal(readResearchInput(bad), null, JSON.stringify(bad))
  assert.equal(listedCostUsd({ searches: 2, reads: 0, model: 'claude-haiku-5-5', input_tokens: 2000, output_tokens: 400 }), (2000 * 0.1 + 400 * 0.5) / 1e6)
  assert.equal(listedCostUsd({ searches: 2, reads: 0, model: 'claude-sonnet-4-5-20250929', input_tokens: 1000, output_tokens: 100 }), (1000 * 3 + 100 * 15) / 1e6)
  assert.equal(listedCostUsd({ searches: 2, reads: 0, model: 'some-model', input_tokens: 1, output_tokens: 1 }), null); assert.equal(listedCostUsd({ searches: 0, reads: 0, model: null, input_tokens: null, output_tokens: null }), null)
})

test('#1102 Haiku is a priced model the provider can be asked for; an unlisted model is refused before any request', async () => {
  const p = anthropicWithModel(CONTACT_RESEARCH_MODEL)
  assert.equal(p.configuredModel!(), 'claude-haiku-5-5')
  // Priced at the higher (over-100K-token) tier on purpose: a reservation can only over-count.
  assert.equal(modelCostUsd('claude-haiku-5-5', 'x'.repeat(1000), 2000), ((1000 + 1000) * 0.5 + 2000 * 2.5) / 1e6)
  assert.throws(() => modelCostUsd('claude-haiku-9', 'x', 10), (e: unknown) => e instanceof SpendRefused && e.reason === 'model_unpriced')
  // The deployment default is untouched by the per-model provider.
  const { anthropicProvider } = await import('../lib/llm/provider.ts')
  assert.equal(anthropicProvider.configuredModel!(), process.env.DAZL_ANTHROPIC_MODEL || 'claude-sonnet-4-5')
})

// ---- the grounding the first council round found too loose (each is a concrete wrong person the loose version KEPT) ----
const SRC = (title: string, snippet: string, url = 'https://news.example.test/x') => ({ url, title, snippet })
async function ground(hit: { url: string; title: string; snippet: string }, answer: unknown, input: ResearchInput = INPUT) {
  const s = stubs([[hit], []], answer)
  return researchContact(input, s.deps(setup()))
}
const D = ' brightloopdental.example'
test('#1102 grounding: a title that is another person\'s, a longer name, a past role outside the quote, another company\'s person in the same sentence are all refused', async () => {
  const cases: [string, ReturnType<typeof SRC>, unknown, string][] = [
    ['the title belongs to someone else in the same snippet', SRC('Team', 'Brightloop Dental hygienist Jane Roe thanked owner Bob Lee.' + D), person('Jane Roe', 'Owner', 'S1', 'Jane Roe thanked owner'), 'title_not_next_to_name'],
    ['a receptionist quoted as the owner', SRC('Team', 'Jane Roe, receptionist at Brightloop Dental in Toronto, thanked owner Sam Lee.' + D), person('Jane Roe', 'Owner', 'S1', 'Jane Roe, receptionist at Brightloop Dental'), 'quote_does_not_give_title'],
    ['"Owner" inside "Homeowners"', SRC('Team', 'Homeowners love Jane Roe, hygienist at Brightloop Dental.' + D), person('Jane Roe', 'Owner', 'S1', 'Homeowners love Jane Roe, hygienist'), 'title_not_in_source'],
    ['a name that is the start of a longer name', SRC('Team', 'Joann Smith, Owner of Brightloop Dental.' + D), person('Ann Smith', 'Owner', 'S1', 'ann Smith, Owner of Brightloop Dental'), 'name_not_in_source'],
    ['"Former" dropped from the quote', SRC('News', 'Former owner Jane Roe sold Brightloop Dental in Toronto last year.' + D), person('Jane Roe', 'owner', 'S1', 'owner Jane Roe sold Brightloop Dental'), 'past_role'],
    ['another company\'s CEO in the same sentence', SRC('News', 'Brightloop Dental was acquired by Globex Health in Toronto; Globex CEO Jane Roe said more deals follow.' + D), person('Jane Roe', 'CEO', 'S1', 'CEO Jane Roe said'), 'source_does_not_name_company'],
    ['a department head is not a decision-maker', SRC('Team', 'Jane Roe, Director of Marketing at Brightloop Dental.' + D), person('Jane Roe', 'Director of Marketing', 'S1', 'Jane Roe, Director of Marketing at Brightloop Dental'), 'not_a_buyer_role'],
    ['a vice president is not the president', SRC('Team', 'Jane Roe, Vice President at Brightloop Dental.' + D), person('Jane Roe', 'Vice President', 'S1', 'Jane Roe, Vice President at Brightloop Dental'), 'not_a_buyer_role'],
  ]
  for (const [what, hit, answer, why] of cases) {
    const r = await ground(hit, answer); assert.equal(r.status, 'not_grounded', what); assert.equal(r.refused, why, what); assert.equal(r.person, null, what)
  }
  // The same sentence read right is kept: the person, the title and the company together, and the website named.
  const ok = await ground(SRC('Team', 'Jane Roe, Owner of Brightloop Dental in Toronto.' + D), person('Jane Roe', 'Owner', 'S1', 'Jane Roe, Owner of Brightloop Dental')); assert.equal(ok.status, 'found'); assert.equal(ok.person?.name, 'Jane Roe')
  const ceo = await ground(SRC('News', 'Brightloop Dental CEO Jane Roe said the clinic opens in November.' + D), person('Jane Roe', 'CEO', 'S1', 'Brightloop Dental CEO Jane Roe said')); assert.equal(ceo.status, 'found', JSON.stringify(ceo))
})

test('#1102 the company tie (Hermes decision on #1164): off the company\'s own site a source must name the CONFIRMED website; with none, only the company\'s own page can ground a person', async () => {
  const hit = SRC('Team', 'Jane Roe, Owner of Brightloop Dental in Toronto.')   // names the company, not the website
  const r = await ground(hit, person('Jane Roe', 'Owner', 'S1', 'Jane Roe, Owner of Brightloop Dental'))
  assert.equal(r.status, 'not_grounded'); assert.equal(r.refused, 'company_unconfirmed')
  // No confirmed website at all: nothing off-site can be tied.
  const none = await ground(SRC('Team', 'Jane Roe, Owner of Brightloop Dental in Toronto. brightloopdental.example'), person('Jane Roe', 'Owner', 'S1', 'Jane Roe, Owner of Brightloop Dental'), { ...INPUT, domain: null })
  assert.equal(none.refused, 'company_unconfirmed')
  // The company's own page needs no tie (it IS the company's site).
  const own = await ground(SRC('Our team | Brightloop Dental', 'Meet Jane Roe, Owner of Brightloop Dental.', 'https://brightloopdental.example/team'), person('Jane Roe', 'Owner', 'S1', 'Jane Roe, Owner of Brightloop Dental'))
  assert.equal(own.status, 'found'); assert.equal(own.person?.place, 'no_geography')
  // A same-name business: the website named is not this company's.
  const other = await ground(SRC('Team', 'Jane Roe, Owner of Brightloop Dental in Columbus. brightloopdental.com'), person('Jane Roe', 'Owner', 'S1', 'Jane Roe, Owner of Brightloop Dental'))
  assert.equal(other.refused, 'company_unconfirmed')
})

test('#1102 an owner the operator named is refused a model their pool does not price BEFORE any search is spent', async () => {
  const s = stubs([[PROFILE_HIT], []], { person: null })
  const db = setup()
  await assert.rejects(() => researchContact(INPUT, { ...s.deps(db), env: { ...env, DAZL_RUN_MAX_USD_USERS: 'A:5' } }), (e: unknown) => e instanceof SpendRefused && e.reason === 'model_unpriced')
  assert.equal(s.calls.searches.length, 0, 'no TinyFish search was sent'); assert.equal(s.calls.prompts.length, 0)
})
