// #1102 / #1037: the council's findings on the grounded named-person step (2026-11-14), each pinned. Wrong people that must never be stored, and the
// step's own limits. TEST-ONLY: invented companies and people; TinyFish and the model are stubbed; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { findGroundedPeople, groundedPeopleSkip, newGroundedStats, readableSource, sourceOwnSite } from '../lib/people/grounded-people.ts'
import { groundPerson, CONTACT_RESEARCH_MODEL, type ResearchInput, type Source } from '../lib/people/contact-research.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { setup, env, type Row } from './helpers/people-held-fixture.ts'

const STORY = 'https://news.example.test/acme-law-expands'
const page = (text: string, title = 'Acme Law expands in Chicago'): Source[] => [{ id: 'S1', kind: 'page', url: STORY, title, text }]
const ans = (name: string, title: string, quote: string) => ({ name, title, source: 'S1', quote, linkedin_source: null })
const EV: ResearchInput = { company: 'Acme Law', domain: null, roles: ['Managing Partner'], where: ['Chicago, Illinois'], evidenceUrl: STORY }
const why = (g: ReturnType<typeof groundPerson>) => ('refused' in g ? g.refused : `kept:${g.person.name}`)

test('council: on the lead\'s source page, "of the <place> office" is this company\'s office only in the narrow case; another firm\'s office, an acquirer and another city are refused', () => {
  // The case it exists for (chicago-law, real): the story is about the lead, and the person heads its office in the requested city.
  assert.equal(why(groundPerson(ans('Jane Roe', 'managing partner', 'Jane Roe, managing partner of the Chicago office, added'), page('Acme Law added four partners. "A significant step," its chair said. Jane Roe, managing partner of the Chicago office, added, "Our team is growing."'), EV)), 'kept:Jane Roe')
  const bad: [string, Source[], ReturnType<typeof ans>, ResearchInput?][] = [
    ['the office of ANOTHER firm', page('Acme Law opened a new office downtown this week, adding twelve lawyers to its team. In other news, Jane Roe, managing partner of the Chicago office of Baker Hostetler, said the market is busy.'), ans('Jane Roe', 'managing partner', 'Jane Roe, managing partner of the Chicago office of Baker Hostetler')],
    ['"the company" is the acquirer', page('Acme Dental has been sold to Globex Health, a national chain. Jane Roe, CEO of the company, said the deal closes in May.', 'Acme Dental sold'), ans('Jane Roe', 'CEO', 'Jane Roe, CEO of the company'), { ...EV, company: 'Acme Dental', roles: ['CEO'] }],
    ['"the firm" likewise', page('Acme Law is merging with Globex Legal. Jane Roe, managing partner of the firm, said the deal closes in May.'), ans('Jane Roe', 'managing partner', 'Jane Roe, managing partner of the firm')],
    ['an office in another city, on a Chicago request', page('Acme Law added four partners. Jane Roe, managing partner of the London office, said the team is growing.'), ans('Jane Roe', 'managing partner', 'Jane Roe, managing partner of the London office')],
    ['a request that names no place cannot confirm an office', page('Acme Law added four partners. Jane Roe, managing partner of the Chicago office, said the team is growing.'), ans('Jane Roe', 'managing partner', 'Jane Roe, managing partner of the Chicago office'), { ...EV, where: [] }],
    ['the story is not about this company (its title does not name it)', page('Acme Law is mentioned in passing. Jane Roe, managing partner of the Chicago office, said the market is busy.', 'Chicago legal market roundup'), ans('Jane Roe', 'managing partner', 'Jane Roe, managing partner of the Chicago office')],
  ]
  for (const [what, sources, a, input] of bad) assert.ok('refused' in groundPerson(a, sources, input ?? EV), `${what}: ${why(groundPerson(a, sources, input ?? EV))}`)
})

test('council: a role that has ended is refused even when the title is followed directly by the company', () => {
  const IN: ResearchInput = { company: 'Acme Dental', domain: null, roles: ['CEO'], where: [], evidenceUrl: STORY }
  for (const text of ['Jane Roe, CEO of Acme Dental from 2010 to 2018, now runs Globex Health in Ohio.', 'Jane Roe, CEO of Acme Dental for a decade, now runs Globex Health in Ohio.', 'Jane Roe, founder of Acme Dental, has died at 81.', 'Jane Roe, CEO of Acme Dental through 2019, spoke at the event.'])
    assert.ok('refused' in groundPerson(ans('Jane Roe', text.includes('founder') ? 'founder' : 'CEO', text.split(',').slice(0, 2).join(',')), page(text, 'Acme Dental news'), IN), text)
  // The plain present statement is still kept.
  assert.equal(why(groundPerson(ans('Jane Roe', 'CEO', 'Jane Roe, CEO of Acme Dental'), page('Jane Roe, CEO of Acme Dental, said the new clinic opens in May.', 'Acme Dental news'), IN)), 'kept:Jane Roe')
})

test('council: a source page on a job board or a publisher whose name the company merely STARTS with is not the company\'s site; a never-read host stays never read', () => {
  for (const [company, url] of [['Greenhouse Cafe', 'https://boards.greenhouse.io/greenhousecafe/jobs/123'], ['Breezy Bakery', 'https://breezybakery.breezy.hr/p/abc'], ['Fortune Dental', 'https://fortune.com/2026/05/01/dental-chains/'], ['Workable Solutions', 'https://apply.workable.com/workable-solutions/j/1']])
    assert.equal(sourceOwnSite(company, url), null, `${company} at ${url}`)
  assert.equal(sourceOwnSite('Roof Royale', 'https://roofroyale.example/careers'), 'roofroyale.example')
  for (const u of ['https://linkedin.com./in/x', 'https://www.linkedin.com/jobs/view/1', 'https://lnkd.in/abc', 'https://youtu.be/x', 'https://m.facebook.com/acme', 'ftp://news.example.test/x', 'nope'])
    assert.equal(readableSource(u, null), null, u)
  assert.equal(readableSource(STORY, null), STORY); assert.equal(readableSource(STORY, 'outside_window_undated'), STORY)
  // A hold that leaves the page unconfirmed as this lead's evidence (or a wall): the page is not read and not trusted.
  for (const hold of ['quote_unconfirmed', 'source_review_required', 'login_required', 'blocked_by_site', 'needs_javascript']) assert.equal(readableSource(STORY, hold), null, hold)
})

test('council: a site derived from the source page is the company\'s for its OWN pages only; it never ties another site\'s source to the company', () => {
  const offsite: Source[] = [{ id: 'S1', kind: 'search', url: 'https://news.example.test/x', title: 'Local news', text: 'Jane Roe, Owner of Acme Dental. See acmedental.example for hours.' }]
  const a = ans('Jane Roe', 'Owner', 'Jane Roe, Owner of Acme Dental')
  const IN: ResearchInput = { company: 'Acme Dental', domain: 'acmedental.example', roles: ['Owner'], where: [] }
  assert.equal(why(groundPerson(a, offsite, IN)), 'kept:Jane Roe', 'a CONFIRMED website named by the source ties it')
  assert.equal(why(groundPerson(a, offsite, { ...IN, domainConfirmed: false })), 'company_unconfirmed', 'a derived site does not')
  const own: Source[] = [{ id: 'S1', kind: 'search', url: 'https://acmedental.example/about', title: 'About | Acme Dental', text: 'Jane Roe, Owner of Acme Dental, opened the clinic in 2014.' }]
  assert.equal(why(groundPerson(a, own, { ...IN, domainConfirmed: false })), 'kept:Jane Roe', 'its own page still counts')
})

// ---- the step ----
const DANA = { person: { name: 'Dana Okoye', title: 'Head of Sales', source: 'S1', quote: 'Dana Okoye, Head of Sales at Pagewake', linkedin_source: null } }
function harness(o: { answer?: unknown; complete?: () => Promise<{ text: string }> } = {}) {
  const calls = { searches: 0, reads: 0, prompts: 0 }
  const fetchImpl = (async (u: string) => {
    if (new URL(String(u)).hostname !== 'api.search.tinyfish.ai') { calls.reads++; return new Response(JSON.stringify({ results: [] })) }
    calls.searches++; return new Response(JSON.stringify({ results: [{ url: 'https://pagewake.example/team', title: 'Our team | Pagewake', snippet: 'Dana Okoye, Head of Sales at Pagewake in Chicago, Illinois.' }] }))
  }) as unknown as typeof fetch
  const provider: Provider = { research: async () => { throw new Error('never') }, configuredModel: () => CONTACT_RESEARCH_MODEL, completeDetailed: async () => { calls.prompts++; const r = o.complete ? await o.complete() : { text: JSON.stringify(o.answer ?? DANA) }; return { ...r, model: CONTACT_RESEARCH_MODEL, usage: { input_tokens: 1500, output_tokens: 120 } } } }
  return { calls, opts: { provider, apiKey: 'sk-test', env, fetchImpl } }
}
const people = (db: ReturnType<typeof setup>['db']) => (db.prepare("SELECT COUNT(*) n FROM lead_enrichments WHERE kind = 'person' AND connector = 'research:person'").get() as { n: number }).n
const FIVE: Row[] = ['Pagewake', 'Meshgate', 'Surveyhive', 'Northgate', 'Tutorhive'].map((c, i) => [`L-${i}`, c, null, 90 - i] as Row)

test('council: an operator\'s per-scan search limit binds the whole pass, not each lookup', async () => {
  const { db, job } = setup(FIVE)
  const h = harness()
  await findGroundedPeople(db, 'A', job, { ...h.opts, env: { ...env, TINYFISH_SEARCHES_PER_SCAN: '1', TINYFISH_FETCHES_PER_SCAN: '2' } })
  assert.equal(h.calls.searches, 1, 'one search for five leads'); assert.equal(h.calls.reads, 2, 'two page reads for five leads')
  // Without an operator limit: at most 2 searches and 1 read per lookup.
  const b = setup(FIVE); const h2 = harness()
  await findGroundedPeople(b.db, 'A', b.job, h2.opts)
  assert.ok(h2.calls.searches <= 10 && h2.calls.reads <= 5, JSON.stringify(h2.calls)); assert.equal(h2.calls.prompts, 5)
})

test('council: the deadline bounds the pass; a lookup still in flight then is never written', async () => {
  const { db, job } = setup([['L-a', 'Pagewake', null, 90]])
  let release: (v: { text: string }) => void = () => {}
  const h = harness({ complete: () => new Promise(res => { release = res }) })
  const stopped: string[] = []
  const t0 = Date.now()
  const n = await findGroundedPeople(db, 'A', job, { ...h.opts, deadlineMs: 200, onStop: w => stopped.push(w) })
  assert.equal(n, 0); assert.ok(Date.now() - t0 < 5_000, 'returned at the deadline, not at the model call\'s own timeout'); assert.deepEqual(stopped, ['deadline'])
  release({ text: JSON.stringify(DANA) }); await new Promise(res => setTimeout(res, 50))
  assert.equal(people(db), 0, 'the late answer is dropped')
})

test('council: a job lost AFTER the model call writes nothing; two leads of one company: the one that can be looked up is', async () => {
  const { db, job } = setup([['L-a', 'Pagewake', null, 90]])
  const h = harness(); let alive = true
  const n = await findGroundedPeople(db, 'A', job, { ...h.opts, alive: () => alive, provider: { ...h.opts.provider, completeDetailed: async (...a: Parameters<NonNullable<Provider['completeDetailed']>>) => { const r = await h.opts.provider.completeDetailed!(...a); alive = false; return r } } })
  assert.equal(n, 0); assert.equal(h.calls.prompts, 1); assert.equal(people(db), 0)
  // The better-ranked lead of the company has no website and a LinkedIn source; the second one has the confirmed website.
  const two = setup([['L-x', 'Pagewake', null, 90], ['L-y', 'Pagewake', 'quote_unconfirmed', 80]], undefined, { domains: false })
  two.db.prepare("UPDATE leads SET source_url = 'https://www.linkedin.com/jobs/view/1' WHERE id = 'L-x'").run()
  const { confirmDomain } = await import('./helpers/people-held-fixture.ts'); confirmDomain(two.db, 'L-y', 'pagewake.example')
  const h2 = harness(); const stats = newGroundedStats()
  assert.equal(await findGroundedPeople(two.db, 'A', two.job, { ...h2.opts, stats }), 1)
  assert.equal(stats.no_website, 1); assert.equal(stats.looked_up, 1); assert.equal(h2.calls.prompts, 1)
  assert.equal((two.db.prepare("SELECT lead_id FROM lead_enrichments WHERE connector = 'research:person'").get() as { lead_id: string }).lead_id, 'L-y')
})

test('council: when the scan does not run the step at all', () => {
  const on = { env: {}, searchEnabled: true, peopleCap: null, vendor: 'anthropic', trial: false }
  assert.equal(groundedPeopleSkip(on), null)
  assert.equal(groundedPeopleSkip({ ...on, peopleCap: 10 }), null, 'a first play with its people cap above 0 runs it')
  assert.match(groundedPeopleSkip({ ...on, env: { GROUNDED_PEOPLE_ENABLED: '0' } }) ?? '', /GROUNDED_PEOPLE_ENABLED=0/)
  assert.match(groundedPeopleSkip({ ...on, searchEnabled: false }) ?? '', /not configured/)
  assert.match(groundedPeopleSkip({ ...on, peopleCap: 0 }) ?? '', /DAZL_FIRST_PLAY_PEOPLE_SEARCHES=0/)
  assert.match(groundedPeopleSkip({ ...on, vendor: 'openai' }) ?? '', /another vendor/)
  assert.match(groundedPeopleSkip({ ...on, trial: true }) ?? '', /free-trial/)
})
