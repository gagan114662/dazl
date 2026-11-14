// #1102 / #1037: the council's findings on the grounded named-person step (2026-11-14), each pinned. Wrong people that must never be stored, and the
// step's own limits. TEST-ONLY: invented companies and people; TinyFish and the model are stubbed; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { findGroundedPeople, groundedPeopleSkip, newGroundedStats, readableSource, sourceOwnSite } from '../lib/people/grounded-people.ts'
import { groundPerson, CONTACT_RESEARCH_MODEL, type ResearchInput, type Source } from '../lib/people/contact-research.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { setup, env, type Row } from './helpers/people-held-fixture.ts'
import { SpendAccountingFailed } from '../lib/llm/spend-guard.ts'

const STORY = 'https://news.example.test/acme-law-expands'
const page = (text: string, title = 'Acme Law expands in Chicago'): Source[] => [{ id: 'S1', kind: 'page', url: STORY, title, text }]
const ans = (name: string, title: string, quote: string) => ({ name, title, source: 'S1', quote, linkedin_source: null })
const EV: ResearchInput = { company: 'Acme Law', domain: null, roles: ['Managing Partner'], where: ['Chicago, Illinois'], evidenceUrl: STORY }
const why = (g: ReturnType<typeof groundPerson>) => ('refused' in g ? g.refused : `kept:${g.person.name}`)

test('council: "of the <place> office" never ties a title to the company (a story may quote either firm; on its own site a hire or co-counsel line names others); the person\'s clause must not name another place or organisation', () => {
  const OWN: ResearchInput = { company: 'Acme Law', domain: 'acmelaw.example', roles: ['Managing Partner'], where: ['Chicago, Illinois'] }
  const ownPage = (text: string): Source[] => [{ id: 'S1', kind: 'page', url: 'https://acmelaw.example/news/expansion', title: 'Acme Law expands', text }]
  const A = ans('Jane Roe', 'managing partner', 'Jane Roe, managing partner of the Chicago office')
  const bad: [string, Source[], ReturnType<typeof ans>, ResearchInput][] = [
    ['own site: "of the Chicago office" with no firm named (refused: a known recall loss)', ownPage('Acme Law added four partners. "A significant step," Alden Marsh said. Jane Roe, managing partner of the Chicago office, added, "Our team is growing."'), A, OWN],
    ['own site: a lateral hire', ownPage('Globex Legal hired Jane Roe, managing partner of its Chicago office.'), ans('Jane Roe', 'managing partner', 'Jane Roe, managing partner of its Chicago office'), OWN],
    ['own site: co-counsel', ownPage('We advised Globex Legal, whose Jane Roe, managing partner of the Chicago office, led the deal.'), A, OWN],
    ['a possessive place', page('Jane Roe, CEO of Acme Law\'s London branch, spoke.'), ans('Jane Roe', 'CEO', 'Jane Roe, CEO of Acme Law'), { ...EV, roles: ['CEO'] }],
    ['a place after a comma', page('Jane Roe, Managing Partner, Acme Law, London, said the team is growing.'), ans('Jane Roe', 'Managing Partner', 'Jane Roe, Managing Partner, Acme Law'), EV],
    ['a place in brackets', page('Jane Roe, Managing Partner at Acme Law (London), said the team is growing.'), ans('Jane Roe', 'Managing Partner', 'Jane Roe, Managing Partner at Acme Law'), EV],
    ['a legal suffix with a period does not end her clause', page('Jane Roe, Managing Partner of Acme Law Inc. was named CEO of Globex Health.'), ans('Jane Roe', 'Managing Partner', 'Jane Roe, Managing Partner of Acme Law'), EV],
    ['the same, another wording', page('Jane Roe, Managing Partner of Acme Law Corp. now leads Globex Health.'), ans('Jane Roe', 'Managing Partner', 'Jane Roe, Managing Partner of Acme Law'), { ...EV, where: [] }],
    ['named to another organisation in the same clause', page('Jane Roe, Managing Partner of Acme Law, was named CEO of Globex Health.'), ans('Jane Roe', 'Managing Partner', 'Jane Roe, Managing Partner of Acme Law'), EV],
    ['own site: the office of ANOTHER firm', ownPage('Acme Law welcomes a guest. Jane Roe, managing partner of the Chicago office of Baker Hostetler, said the market is busy.'), ans('Jane Roe', 'managing partner', 'Jane Roe, managing partner of the Chicago office of Baker Hostetler'), OWN],
    ['own site: an office in another city, on a Chicago request', ownPage('Acme Law added four partners. Alden Marsh spoke first. Jane Roe, managing partner of the London office, said the team is growing.'), ans('Jane Roe', 'managing partner', 'Jane Roe, managing partner of the London office'), OWN],
    ['own site: a request that names no place cannot confirm an office', ownPage('Acme Law added four partners. Alden Marsh spoke first. Jane Roe, managing partner of the Chicago office, said the team is growing.'), A, { ...OWN, where: [] }],
    ['a story about two firms (headline names both)', page('Globex Legal hires three Acme Law partners. Jane Roe, managing partner of the Chicago office, said Globex is growing.', 'Globex Legal poaches Acme Law partners in Chicago'), A, EV],
    ['a story about this firm quoting the other side', page('Acme Law lost its largest client to Globex Legal. "We are delighted," said Jane Roe, managing partner of the Chicago office.', 'Acme Law loses client'), A, EV],
    ['a merger story, "our Chicago office"', page('Acme Law and Globex Legal will merge. Jane Roe, managing partner of our Chicago office, said the deal closes in May.', 'Acme Law, Globex merge'), ans('Jane Roe', 'managing partner', 'Jane Roe, managing partner of our Chicago office'), EV],
    ['"the company" is the acquirer', page('Acme Dental has been sold to Globex Health, a national chain. Jane Roe, CEO of the company, said the deal closes in May.', 'Acme Dental sold'), ans('Jane Roe', 'CEO', 'Jane Roe, CEO of the company'), { ...EV, company: 'Acme Dental', roles: ['CEO'] }],
    ['"the firm" likewise', page('Acme Law is merging with Globex Legal. Jane Roe, managing partner of the firm, said the deal closes in May.'), ans('Jane Roe', 'managing partner', 'Jane Roe, managing partner of the firm'), EV],
    ['the person\'s own sentence puts them in another city (source page)', page('Jane Roe, Managing Partner at Acme Law in London, said the team is growing.'), ans('Jane Roe', 'Managing Partner', 'Jane Roe, Managing Partner at Acme Law'), EV],
    ['the same on the company\'s own site', ownPage('Jane Roe, Managing Partner at Acme Law in London, said the team is growing.'), ans('Jane Roe', 'Managing Partner', 'Jane Roe, Managing Partner at Acme Law'), OWN],
  ]
  for (const [what, sources, a, input] of bad) assert.ok('refused' in groundPerson(a, sources, input), `${what}: ${why(groundPerson(a, sources, input))}`)
  // The lead's source page still names a person tied to the company BY NAME.
  assert.equal(why(groundPerson(ans('Jane Roe', 'Managing Partner', 'Jane Roe, Managing Partner at Acme Law'), page('Jane Roe, Managing Partner at Acme Law, said the Chicago team is growing.'), EV)), 'kept:Jane Roe')
})

test('council: a role that has ended is refused even when the title is followed directly by the company', () => {
  const IN: ResearchInput = { company: 'Acme Dental', domain: null, roles: ['CEO'], where: [], evidenceUrl: STORY }
  for (const text of ['Jane Roe, CEO of Acme Dental from 2010 to 2018, now runs Globex Health in Ohio.', 'Jane Roe, CEO of Acme Dental for a decade, now runs Globex Health in Ohio.', 'Jane Roe, founder of Acme Dental, has died at 81.', 'Jane Roe, CEO of Acme Dental through 2019, spoke at the event.', 'Jane Roe, CEO of Acme Dental from 2010-18, spoke at the event.', 'Jane Roe, CEO of Acme Dental, was succeeded by John Doe in March.', 'Jane Roe, CEO of Acme Dental, was replaced by John Doe in March.', 'Jane Roe, CEO of Acme Dental, was ousted in March.', 'Jane Roe, founder of Acme Dental, is survived by her husband and two sons.', 'Jane Roe, CEO of Acme Dental, announced her retirement.', 'Jane Roe, CEO of Acme Dental, is leaving the company in June.', 'Jane Roe, CEO of Acme Dental 2010—2018, spoke.', 'Jane Roe, CEO of Acme Dental, was dismissed in June.'])
    assert.ok('refused' in groundPerson(ans('Jane Roe', text.includes('founder') ? 'founder' : 'CEO', text.split(',').slice(0, 2).join(',')), page(text, 'Acme Dental news'), IN), text)
  // The plain present statement is still kept.
  assert.equal(why(groundPerson(ans('Jane Roe', 'CEO', 'Jane Roe, CEO of Acme Dental'), page('Jane Roe, CEO of Acme Dental, said the new clinic opens in May.', 'Acme Dental news'), IN)), 'kept:Jane Roe')
})

test('council: a source page on a job board or a publisher whose name the company merely STARTS with is not the company\'s site; a never-read host stays never read', () => {
  for (const [company, url] of [['Greenhouse Cafe', 'https://boards.greenhouse.io/greenhousecafe/jobs/123'], ['Breezy Bakery', 'https://breezybakery.breezy.hr/p/abc'], ['Fortune Dental', 'https://fortune.com/2026/05/01/dental-chains/'], ['Workable Solutions', 'https://apply.workable.com/workable-solutions/j/1']])
    assert.equal(sourceOwnSite(company, url), null, `${company} at ${url}`)
  assert.equal(sourceOwnSite('Roof Royale', 'https://roofroyale.example/careers'), 'roofroyale.example')
  assert.equal(sourceOwnSite('Acme Inc', 'https://acme.example/news'), 'acme.example', 'a legal suffix is not part of the host name'); assert.equal(sourceOwnSite('The Acme Company', 'https://www.acme.example/x'), 'acme.example')
  assert.equal(sourceOwnSite('Co Op Dental', 'https://opdental.example/x'), null, 'only a leading article and a trailing suffix are dropped')
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
  const on = { env: {}, searchEnabled: true, peopleCap: null, vendor: 'anthropic', trial: false, firstPlay: false }
  assert.equal(groundedPeopleSkip(on), null)
  assert.match(groundedPeopleSkip({ ...on, firstPlay: true, peopleCap: 10 }) ?? '', /first play/)
  assert.match(groundedPeopleSkip({ ...on, env: { GROUNDED_PEOPLE_ENABLED: '0' } }) ?? '', /GROUNDED_PEOPLE_ENABLED=0/)
  assert.match(groundedPeopleSkip({ ...on, searchEnabled: false }) ?? '', /not configured/)
  assert.match(groundedPeopleSkip({ ...on, peopleCap: 0 }) ?? '', /DAZL_FIRST_PLAY_PEOPLE_SEARCHES=0/)
  assert.match(groundedPeopleSkip({ ...on, vendor: 'openai' }) ?? '', /another vendor/)
  assert.match(groundedPeopleSkip({ ...on, trial: true }) ?? '', /free-trial/)
  assert.match(groundedPeopleSkip({ ...on, paidFallback: false }) ?? '', /paid steps/); assert.match(groundedPeopleSkip({ ...on, scheduled: true }) ?? '', /scheduled run/)
  assert.equal(groundedPeopleSkip({ ...on, paidFallback: true, scheduled: false }), null)
})

test('council round 2: the deadline cancels a hanging page read and NO model call is started after it; an unsaved cost stops the pass; a hold that questions the page gives no site', async () => {
  // A page read that hangs until its signal fires (the lead has a confirmed website and an off-site source page).
  const { db, job } = setup([['L-a', 'Pagewake', null, 90]])
  const calls = { prompts: 0 }
  const fetchImpl = ((u: string, init?: RequestInit) => new URL(String(u)).hostname === 'api.search.tinyfish.ai'
    ? Promise.resolve(new Response(JSON.stringify({ results: [{ url: 'https://pagewake.example/team', title: 'Our team | Pagewake', snippet: 'Dana Okoye, Head of Sales at Pagewake in Chicago, Illinois.' }] })))
    : new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch
  const provider: Provider = { research: async () => { throw new Error('never') }, configuredModel: () => CONTACT_RESEARCH_MODEL, completeDetailed: async () => { calls.prompts++; return { text: JSON.stringify(DANA), model: CONTACT_RESEARCH_MODEL, usage: { input_tokens: 1, output_tokens: 1 } } } }
  assert.equal(await findGroundedPeople(db, 'A', job, { provider, apiKey: 'k', env, fetchImpl, deadlineMs: 200 }), 0)
  await new Promise(res => setTimeout(res, 1500))
  assert.equal(calls.prompts, 0, 'no paid model call after the deadline'); assert.equal(people(db), 0)
  // A cost that could not be saved: no further lookups start.
  const five = setup(FIVE); const h = harness({ complete: async () => { throw new SpendAccountingFailed(new Error('x')) } }); const stopped: string[] = []
  assert.equal(await findGroundedPeople(five.db, 'A', five.job, { ...h.opts, onStop: w => stopped.push(w) }), 0)
  assert.deepEqual(stopped, ['spend_unsaved']); assert.ok(h.calls.prompts <= 3, `at most the lookups already in flight: ${h.calls.prompts}`)
  // quote_unconfirmed: the page itself is in question, so its host is not taken as the company's site (blocked_by_site is: the URL alone says it).
  const q = setup([['L-a', 'Pagewake', 'quote_unconfirmed', 90]], undefined, { domains: false })
  q.db.prepare("UPDATE leads SET source_url = 'https://www.pagewake.example/careers' WHERE id = 'L-a'").run()
  const h2 = harness(); const stats = newGroundedStats()
  assert.equal(await findGroundedPeople(q.db, 'A', q.job, { ...h2.opts, stats }), 0); assert.equal(stats.no_website, 1); assert.equal(h2.calls.searches + h2.calls.reads + h2.calls.prompts, 0)
})

test('council round 3: a page read that finishes after the deadline starts no model call', async () => {
  const { db, job } = setup([['L-a', 'Pagewake', null, 90]])
  let prompts = 0
  const fetchImpl = ((u: string) => new URL(String(u)).hostname === 'api.search.tinyfish.ai'
    ? Promise.resolve(new Response(JSON.stringify({ results: [{ url: 'https://pagewake.example/team', title: 'Our team | Pagewake', snippet: 'Dana Okoye, Head of Sales at Pagewake in Chicago, Illinois.' }] })))
    : new Promise<Response>(res => setTimeout(() => res(new Response(JSON.stringify({ results: [] }))), 400))) as unknown as typeof fetch   // ignores the abort, answers late
  const provider: Provider = { research: async () => { throw new Error('never') }, configuredModel: () => CONTACT_RESEARCH_MODEL, completeDetailed: async () => { prompts++; return { text: JSON.stringify(DANA), model: CONTACT_RESEARCH_MODEL, usage: { input_tokens: 1, output_tokens: 1 } } } }
  assert.equal(await findGroundedPeople(db, 'A', job, { provider, apiKey: 'k', env, fetchImpl, deadlineMs: 100 }), 0)
  await new Promise(res => setTimeout(res, 900))
  assert.equal(prompts, 0); assert.equal(people(db), 0)
})

test('the company right before the title ("<Company> Managing Partner <Name> said") ties the title to it; another firm, a former role and a move elsewhere are refused', () => {
  const OWN: ResearchInput = { company: 'Acme Law', domain: 'acmelaw.example', domainConfirmed: false, roles: ['Managing Partner'], where: ['Chicago, Illinois'] }
  const ownPage = (text: string): Source[] => [{ id: 'S1', kind: 'page', url: 'https://acmelaw.example/news/expansion', title: 'Acme Law expands corporate practice in Chicago', text }]
  const A = ans('Jane Roe', 'Managing Partner', 'Acme Law Managing Partner Jane Roe')
  // The real shape (chicago-law, 2026-11-14), with other partners named around it.
  assert.equal(why(groundPerson(A, ownPage('Sam Lee joins the Corporate Services practice in Chicago from Northgate LLP. "Sam is a great addition," said Acme Law Managing Partner Jane Roe. "Our Chicago office keeps growing."'), OWN)), 'kept:Jane Roe')
  assert.equal(why(groundPerson(ans('Jane Roe', 'CEO', "Acme Law's CEO Jane Roe"), ownPage("The award went to Acme Law's CEO Jane Roe on Tuesday."), { ...OWN, roles: ['CEO'] })), 'kept:Jane Roe')
  const bad: [string, string, ReturnType<typeof ans>][] = [
    ['another firm before the title', '"A great hire," said Northgate Managing Partner Jane Roe. Acme Law declined to comment.', ans('Jane Roe', 'Managing Partner', 'Northgate Managing Partner Jane Roe')],
    ['a longer-named business', '"A great hire," said Acme Law Group Managing Partner Jane Roe.', ans('Jane Roe', 'Managing Partner', 'Managing Partner Jane Roe')],
    ['a former role', 'The firm thanked former Acme Law Managing Partner Jane Roe for her service.', A],
    ['the company is only the end of a longer business name', '"Great hire," said North Acme Law Managing Partner Jane Roe.', A],
    ['the same, joined by an ampersand', '"Great hire," said Smith & Acme Law Managing Partner Jane Roe.', A],
    ['the same, hyphenated', '"Great hire," said Globex-Acme Law Managing Partner Jane Roe.', A],
    ['not yet the title-holder', 'Future Acme Law Managing Partner Jane Roe spoke at the event.', A],
    ['no longer the title-holder, another wording', 'Erstwhile Acme Law Managing Partner Jane Roe spoke at the event.', A],
    ['she moved elsewhere in the same clause', 'Acme Law Managing Partner Jane Roe has joined Globex Legal as chair.', A],
    ['another place in her clause, on a Chicago request', 'Acme Law Managing Partner Jane Roe of London said the team is growing.', A],
  ]
  for (const [what, text, a] of bad) assert.ok('refused' in groundPerson(a, ownPage(text), OWN), `${what}: ${why(groundPerson(a, ownPage(text), OWN))}`)
})

test('the price estimate states the lookups in its maxima, at the step\'s own limits and the guard\'s price; none on a trial, a first play or with paid steps off', async () => {
  const { estimateRun } = await import('../lib/scan/price-estimate.ts')
  const rb = await import('../lib/scan/run-budget.ts'); const gp = await import('../lib/people/grounded-people.ts'); const cr = await import('../lib/people/contact-research.ts'); const { scanModelPrice } = await import('../lib/scan/spend-cap.ts')
  assert.equal(rb.GROUNDED_LOOKUPS_PER_SCAN, gp.MAX_LEADS); assert.equal(rb.GROUNDED_SEARCHES_PER_SCAN, gp.MAX_LEADS * cr.MAX_SEARCHES); assert.equal(rb.GROUNDED_READS_PER_SCAN, gp.MAX_LEADS * cr.MAX_READS)
  assert.equal(rb.GROUNDED_MODEL.id, cr.CONTACT_RESEARCH_MODEL); assert.deepEqual(rb.GROUNDED_MODEL.usd_per_m, scanModelPrice(cr.CONTACT_RESEARCH_MODEL)); assert.equal(rb.GROUNDED_MODEL.outK * 1000, cr.MAX_OUTPUT_TOKENS); assert.equal(rb.GROUNDED_MODEL.inK * 1000, cr.PROMPT_BYTES, 'the guard reserves one token per prompt byte')
  const priced = { DAZL_PRICE_TINYFISH_SEARCH_USD: '0.01', DAZL_PRICE_TINYFISH_FETCH_USD: '0.002', DAZL_ADAPTIVE_DISCOVERY_ENABLED: '0' }
  const rows = (e: ReturnType<typeof estimateRun>) => Object.fromEntries(e.rows.map(r => [r.id, r]))
  const on = rows(estimateRun({ budget: null, payer: 'you', env: priced })), off = rows(estimateRun({ budget: null, payer: 'you', env: { ...priced, GROUNDED_PEOPLE_ENABLED: '0' } }))
  assert.equal(on.tinyfish_search.units.max - off.tinyfish_search.units.max, 10); assert.equal(on.tinyfish_fetch.units.max - off.tinyfish_fetch.units.max, 5)
  assert.equal(on.named_person_lookup.units.max, 5); assert.ok(Math.abs(on.named_person_lookup.usd!.max - 0.1775) < 1e-9, String(on.named_person_lookup.usd!.max))
  assert.equal(off.named_person_lookup, undefined)
  for (const e of [estimateRun({ budget: { paid_fallback: false }, payer: 'you', env: priced }), estimateRun({ budget: { first5: true }, payer: 'you', env: priced }), estimateRun({ budget: null, payer: 'trial', env: priced })]) assert.equal(rows(e).named_person_lookup, undefined)
  assert.ok(rb.BUDGET_EXCLUDED_PATHS.some(p => /Named-person lookup after the scan/.test(p)))
})
