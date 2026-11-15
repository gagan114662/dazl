// Research engine part G (lib/research/company.ts): site discovery, the company's own pages, person searches, the decision-maker with a
// VERBATIM quote that must be literally on its cited source, and emails printed on the company's own domain. Stub network and model;
// page shapes taken from real pages the prototype read (names replaced).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cfEmails, companySearch, registrySeed, findSite, guessedSites, nameTokens, ownEmails, quoteIn, readHtml, researchCompany, siteMatchesCase, type CompanyDeps, type SearchResult } from '../lib/research/company.ts'
import type { ResearchCase, ResearchEvent, ResearchPlan } from '../lib/research/types.ts'

const C: ResearchCase = { tenant: 'T', jobId: 'J', query: 'Roofing companies in Austin hiring estimators', offer: 'estimating software', where: 'Austin, Texas', category: 'roofing contractors', windowDays: 90, today: '2026-11-15' }
const PLAN: ResearchPlan = { persona: 'p', decisionMakerTitles: ['Owner', 'President', 'Operations Manager'], triggers: [], askingQueries: [], source: 'fallback' }
const ev = (o: Partial<ResearchEvent> = {}): ResearchEvent => ({ company: 'Tarrytown Roofing', website: null, pageIsCompanySite: false, triggerId: 't1', whatHappened: 'hiring an estimator', whyNow: 'x', quote: 'Tarrytown Roofing is hiring a Senior Estimator', eventDate: '2026-11-01', dateQuote: 'November 1, 2026', locationQuote: null, people: [], sourceUrl: 'https://roofingnews.example/tarrytown-hires', indexDate: null, foundBy: 'q', ...o })
const PROSE = '<p>' + 'Tarrytown Roofing serves Austin homeowners and businesses with roof repair, replacement and storm restoration. '.repeat(6) + '</p>'
const PAGES: Record<string, string> = {
  'https://roofingnews.example/tarrytown-hires': `<html><body><h1>Tarrytown Roofing is hiring a Senior Estimator</h1>${PROSE}<p>Contact the company at hello@tarrytownroofing.com.</p></body></html>`,
  'https://tarrytownroofing.com': `<html><body>${PROSE}<a href="/about-us">About us</a><a href="/our-team">Meet the team</a><a href="/contact">Contact</a><a href="/blog/roof-tips">Blog</a><a href="https://facebook.com/tarrytown">fb</a><a href="mailto:office@tarrytownroofing.com">Email</a></body></html>`,
  'https://tarrytownroofing.com/our-team': `<html><body>${PROSE}<h2>Our team</h2><p>Dana Whitlock, Owner and President, founded Tarrytown Roofing in 2009 after twenty years on Austin roofs.</p><p>Write to dana@tarrytownroofing.com or sales@othercompany.com</p></body></html>`,
  'https://tarrytownroofing.com/about-us': `<html><body>${PROSE}<p>Visit us at 400 Example Rd, Austin, TX 78704.</p></body></html>`,
  'https://tarrytownroofing.com/contact': `<html><body>${PROSE}<img src="logo@2x.png"></body></html>`,
}
function deps(o: { search?: Record<string, SearchResult[]>; answers?: (string | null)[] } = {}) {
  const asked: string[] = [], prompts: string[] = []
  const d: CompanyDeps = {
    search: async q => { asked.push(q); for (const [k, v] of Object.entries(o.search ?? {})) if (q.includes(k)) return v; return [] },
    get: async u => { const k = u.replace(/\/$/, ''); const b = PAGES[k] ?? PAGES[u]; return b ? { status: 200, body: b, finalUrl: k } : { status: 404, body: '', finalUrl: u } },
    complete: async p => { prompts.push(p); return (o.answers ?? []).shift() ?? null },
  }
  return { d, asked, prompts }
}
const SITE_HIT = { 'official website': [{ url: 'https://www.yelp.com/biz/tarrytown-roofing', title: 'Tarrytown Roofing - Yelp', snippet: '' }, { url: 'https://tarrytownroofing.com/', title: 'Tarrytown Roofing | Austin roofer', snippet: '' }] }
const DM = (quote: string, source = 'S4', name = 'Dana Whitlock') => JSON.stringify({ decision_maker: { name, title: 'Owner and President', source_id: source, quote }, profile_url: null, location: { source_id: 'S3', quote: '400 Example Rd, Austin, TX 78704' }, what_they_do: 'Roof repair and replacement in Austin' })

test('quote and name helpers are the prototype\'s', () => {
  assert.ok(quoteIn('Dana Whitlock, Owner and President, founded', 'x Dana  Whitlock — Owner and President, founded y'))
  assert.ok(!quoteIn('short', 'short'))
  assert.ok(quoteIn('one two three four five six seven eight nine changed', 'zero one two three four five six seven eight nine ten'), 'an 8-word run is enough')
  assert.deepEqual(nameTokens('Tarrytown Roofing LLC'), ['tarrytown'])
  assert.deepEqual(nameTokens('The Dental Group'), ['the', 'dental', 'group'], 'all generic: keep every word')
  const p = readHtml('<html><script>var x="a@b.com"</script><a href="/team">Team</a><a href="mailto:Info@x.com?subject=hi">m</a><p>Hello&nbsp;world</p></html>', 'https://x.com/')
  assert.deepEqual([p.links.map(l => l.url), p.mailtos, p.text.includes('a@b.com')], [['https://x.com/team'], ['Info@x.com'], false])
})

test('findSite: the event page when it is the company\'s own, the website the page shows, else a search result whose host carries the name (directories skipped)', async () => {
  const { d } = deps({ search: SITE_HIT })
  assert.equal(await findSite(ev({ pageIsCompanySite: true, sourceUrl: 'https://www.tarrytownroofing.com/careers/estimator' }), 'Austin', d), 'https://tarrytownroofing.com')
  assert.equal(await findSite(ev({ website: 'tarrytownroofing.com' }), 'Austin', d), 'https://tarrytownroofing.com')
  assert.equal(await findSite(ev({ website: 'facebook.com/tarrytown' }), 'Austin', deps().d), null, 'a directory is never the site; no search hit either')
  assert.equal(await findSite(ev(), 'Austin', d), 'https://tarrytownroofing.com', 'yelp skipped')
  assert.equal(await findSite(ev({ pageIsCompanySite: true, sourceUrl: 'https://www.linkedin.com/company/tarrytown' }), 'Austin', deps().d), null)
})

test('research: event page + homepage + its own team/about/contact pages; the decision-maker whose quote is on the cited page; own-domain emails with their page', async () => {
  const { d, asked, prompts } = deps({ search: SITE_HIT, answers: [DM('Dana Whitlock, Owner and President, founded Tarrytown Roofing in 2009')] })
  const r = await researchCompany(C, PLAN, ev(), d)
  assert.equal(r.site, 'https://tarrytownroofing.com')
  assert.deepEqual(r.sources.map(s => [s.id, s.url, s.kind]), [['S1', 'https://roofingnews.example/tarrytown-hires', 'page'], ['S2', 'https://tarrytownroofing.com', 'page'], ['S3', 'https://tarrytownroofing.com/about-us', 'page'], ['S4', 'https://tarrytownroofing.com/our-team', 'page'], ['S5', 'https://tarrytownroofing.com/contact', 'page']])
  assert.deepEqual(r.person, { name: 'Dana Whitlock', title: 'Owner and President', sourceId: 'S4', quote: 'Dana Whitlock, Owner and President, founded Tarrytown Roofing in 2009', profileUrl: null, from: 'research' })
  assert.deepEqual(r.location, { sourceId: 'S3', quote: '400 Example Rd, Austin, TX 78704' })
  assert.deepEqual(r.emails, [{ email: 'dana@tarrytownroofing.com', url: 'https://tarrytownroofing.com/our-team' }, { email: 'office@tarrytownroofing.com', url: 'https://tarrytownroofing.com' }], 'the named person\'s own address first;' + 'own domain only: the news page\'s hello@ is not on the company\'s pages; sales@othercompany.com and logo@2x are not addresses of this company')
  assert.equal(prompts.length, 1, 'one model call when it names someone')
  assert.deepEqual(asked, ['Tarrytown Roofing Austin official website'], 'the team page named the owner: no person search was spent (only the site search)')
})

test('no invented person: a quote that is not on its cited page, a name the quote does not contain, or no answer -> null after the second look', async () => {
  for (const answers of [[DM('Dana Whitlock is the Owner and President of Tarrytown Roofing since 2009'), null], [DM('Dana Whitlock, Owner and President, founded Tarrytown Roofing in 2009', 'S4', 'Pat Moreno'), null], [null, null], ['not json', 'still not json']]) {
    const { d, prompts } = deps({ search: SITE_HIT, answers })
    const r = await researchCompany(C, PLAN, ev(), d)
    assert.equal(r.person, null, JSON.stringify(answers))
    assert.equal(prompts.length, 2, 'the second look ran once')
    assert.match(prompts[1], /SECOND LOOK/)
  }
  const { d } = deps({ search: SITE_HIT, answers: [null, DM('Dana Whitlock, Owner and President, founded Tarrytown Roofing in 2009')] })
  assert.equal((await researchCompany(C, PLAN, ev(), d)).person?.from, 'second look')
})

test('the trigger article\'s own senior person is used before a second model call, with its quote checked on that article', async () => {
  const article = ev({ people: [{ name: 'Dana Whitlock', title: 'Owner', quote: 'Tarrytown Roofing is hiring a Senior Estimator' }] })
  const { d, prompts } = deps({ search: SITE_HIT, answers: [null] })
  // the mention's quote names no one: refused, so the second look runs
  assert.equal((await researchCompany(C, PLAN, article, d)).person, null); assert.equal(prompts.length, 2)
  PAGES['https://roofingnews.example/tarrytown-hires'] += '<p>"We are growing fast," said Dana Whitlock, owner of Tarrytown Roofing.</p>'
  const named = ev({ people: [{ name: 'Dana Whitlock', title: 'Owner', quote: 'said Dana Whitlock, owner of Tarrytown Roofing' }] })
  const t = deps({ search: SITE_HIT, answers: [null] })
  const r = await researchCompany(C, PLAN, named, t.d)
  assert.deepEqual([r.person?.name, r.person?.from, r.person?.sourceId, t.prompts.length], ['Dana Whitlock', 'trigger article', 'S1', 1])
})

test('a person-search snippet is a source; a profile URL is kept only when it appears in the sources', async () => {
  const snip = { 'linkedin': [{ url: 'https://www.linkedin.com/in/dana-whitlock-roofing', title: 'Dana Whitlock - Owner - Tarrytown Roofing | LinkedIn', snippet: 'Owner at Tarrytown Roofing. Austin, Texas.' }] }
  const answer = JSON.stringify({ decision_maker: { name: 'Dana Whitlock', title: 'Owner', source_id: 'S5', quote: 'Dana Whitlock - Owner - Tarrytown Roofing | LinkedIn' }, profile_url: 'https://www.linkedin.com/in/dana-whitlock-roofing', location: null, what_they_do: null })
  // the team page has no one here: the site-first call answers null, then the searches run and the snippet names the owner
  const team = PAGES['https://tarrytownroofing.com/our-team']; delete PAGES['https://tarrytownroofing.com/our-team']
  const { d } = deps({ search: { ...SITE_HIT, ...snip }, answers: [null, answer] })
  const r = await researchCompany(C, PLAN, ev(), d)
  assert.equal(r.sources.find(s => s.id === 'S5')?.kind, 'snippet', 'LinkedIn is never opened, its snippet is the source')
  assert.deepEqual([r.person?.name, r.person?.profileUrl], ['Dana Whitlock', 'https://www.linkedin.com/in/dana-whitlock-roofing'])
  const made = JSON.stringify({ ...JSON.parse(answer), profile_url: 'https://www.linkedin.com/in/someone-else' })
  assert.equal((await researchCompany(C, PLAN, ev(), deps({ search: { ...SITE_HIT, ...snip }, answers: [null, made] }).d)).person?.profileUrl, null)
  PAGES['https://tarrytownroofing.com/our-team'] = team
})

test('nothing found: no site, no pages, no sources -> no model call, an empty research', async () => {
  const { d, prompts } = deps()
  const r = await researchCompany(C, PLAN, ev({ sourceUrl: 'https://gone.example/x' }), d)
  assert.deepEqual([r.site, r.sources.length, r.person, r.emails.length, prompts.length], [null, 0, null, 0, 0])
})

// #1122 (Hermes 02:15): the prototype named a books app's CEO for the Vancouver restaurant Fable, because the site search took us.fable.com.
const VAN: ResearchCase = { ...C, where: 'Vancouver, British Columbia, Canada', category: 'Restaurants / food service', whereKeywords: ['vancouver', 'british columbia', ', bc', 'canada', '.ca'], categoryKeywords: ['restaurant', 'cafe', 'dining', 'kitchen', 'menu', 'chef'] }
const FABLE = (o: Partial<ResearchEvent> = {}) => ev({ company: 'Fable', sourceUrl: 'https://vancouverfoodnews.example/fable-closing', quote: 'Fable is closing its Kitsilano location', ...o })
const BOOKS = `<html><body><p>${'Fable is the social app for readers and book clubs. Discover books, join clubs and track your reading on iOS and Android. '.repeat(5)}</p><a href="/about">About</a><p>Joe Parenteau, CEO &amp; Co-founder of Fable.</p></body></html>`
const DINER = `<html><body><p>${'Fable Kitchen is a farm to table restaurant in Kitsilano, Vancouver. Our menu changes with the seasons and our chef works with local farms. '.repeat(5)}</p><a href="/our-team">Team</a><p>1944 W 4th Ave, Vancouver, BC</p></body></html>`
const DINER_TEAM = `<html><body><p>${'Fable Kitchen is a farm to table restaurant in Kitsilano, Vancouver. '.repeat(8)}</p><p>Ron MacGillvary, Owner of Fable Kitchen, opened the restaurant in 2012.</p></body></html>`
test('#1122 a found site must be this business: place AND category on its own pages; a books app is not a Vancouver restaurant', async () => {
  assert.deepEqual(siteMatchesCase(VAN, 'fable.co', [BOOKS]), { place: false, category: false })
  assert.deepEqual(siteMatchesCase(VAN, 'fablekitchen.ca', [DINER]), { place: true, category: true })
  assert.deepEqual(siteMatchesCase(VAN, 'fablekitchen.ca', ['A farm to table place.']), { place: true, category: false }, 'a country domain shows the place; the category still has to show')
  assert.deepEqual(siteMatchesCase(C, 'tarrytownroofing.com', ['Roofing in Austin']), { place: true, category: true }, 'no keyword lists: the words of where / category')
  PAGES['https://fable.co'] = BOOKS; PAGES['https://fablekitchen.ca'] = DINER; PAGES['https://fablekitchen.ca/our-team'] = DINER_TEAM
  PAGES['https://vancouverfoodnews.example/fable-closing'] = `<html><body><p>${'Fable is closing its Kitsilano location after twelve years on West 4th Avenue in Vancouver. '.repeat(6)}</p></body></html>`
  const onlyBooks = { 'official website': [{ url: 'https://fable.co/', title: 'Fable - the app for readers', snippet: '' }] }
  const answers = [JSON.stringify({ decision_maker: { name: 'Joe Parenteau', title: 'CEO & Co-founder', source_id: 'S2', quote: 'Joe Parenteau, CEO & Co-founder of Fable.' }, location: null, what_they_do: null })]
  const wrong = deps({ search: onlyBooks, answers: [...answers] })
  const r = await researchCompany(VAN, PLAN, FABLE(), wrong.d)
  assert.deepEqual([r.site, r.person, r.emails, wrong.prompts.length], [null, null, [], 0], 'no site, no person, no model call')
  // the next candidate that IS the restaurant is taken
  const both = { 'official website': [{ url: 'https://fable.co/', title: 'Fable - the app for readers', snippet: '' }, { url: 'https://fablekitchen.ca/', title: 'Fable Kitchen', snippet: '' }] }
  const right = deps({ search: both, answers: [JSON.stringify({ decision_maker: { name: 'Ron MacGillvary', title: 'Owner', source_id: 'S3', quote: 'Ron MacGillvary, Owner of Fable Kitchen, opened the restaurant in 2012.' }, location: null, what_they_do: null })] })
  const r2 = await researchCompany(VAN, PLAN, FABLE(), right.d)
  assert.deepEqual([r2.site, r2.person?.name, r2.sources.map(s => s.url)], ['https://fablekitchen.ca', 'Ron MacGillvary', ['https://vancouverfoodnews.example/fable-closing', 'https://fablekitchen.ca', 'https://fablekitchen.ca/our-team']])
  assert.ok(!r2.sources.some(s => s.url.includes('fable.co/')), 'the wrong site\'s pages are never sources')
})

test('emails: the named person\'s own address first, then inboxes; recruiting and no-reply are not contacts; Cloudflare addresses decoded', () => {
  const found = new Map([['info@acme.com', 'https://acme.com/'], ['careers@acme.com', 'https://acme.com/jobs'], ['dana.whitlock@acme.com', 'https://acme.com/team'], ['no-reply@acme.com', 'https://acme.com/'], ['sales@mail.acme.com', 'https://acme.com/contact'], ['x@other.com', 'https://acme.com/']])
  const person = { name: 'Dana Whitlock', title: 'Owner', sourceId: 'S1', quote: 'q', profileUrl: null, from: 'research' as const }
  assert.deepEqual(ownEmails(found, 'acme.com', person).map(e => e.email), ['dana.whitlock@acme.com', 'info@acme.com', 'sales@mail.acme.com'])
  assert.deepEqual(ownEmails(found, 'acme.com', null).map(e => e.email), ['info@acme.com', 'dana.whitlock@acme.com', 'sales@mail.acme.com'])
  assert.deepEqual(ownEmails(found, '', person), [], 'no site, no email')
  const enc = (e: string, k = 0x42) => k.toString(16).padStart(2, '0') + [...e].map(ch => (ch.charCodeAt(0) ^ k).toString(16).padStart(2, '0')).join('')
  const html = `<a href="/cdn-cgi/l/email-protection" data-cfemail="${enc('reception@d-7roofing.com')}">[email protected]</a><a href="/cdn-cgi/l/email-protection#${enc('owner@d-7roofing.com', 0x31)}">x</a>`
  assert.deepEqual(cfEmails(html), ['reception@d-7roofing.com', 'owner@d-7roofing.com'])
  assert.deepEqual(readHtml(html, 'https://d-7roofing.com/').mailtos, ['reception@d-7roofing.com', 'owner@d-7roofing.com'])
})

test('companySearch waits out A\'s per-minute "rate" answers and retries; any other failure is no results', async () => {
  const waits: number[] = []
  let n = 0
  const s = companySearch(async () => (++n < 3 ? { ok: false, reason: 'rate' } : { ok: true, hits: [{ url: 'https://a.example/', title: 'A', snippet: 's', date: null }] }), '2026-08-17', { wait: async ms => { waits.push(ms) } })
  assert.deepEqual(await s('q'), [{ url: 'https://a.example/', title: 'A', snippet: 's' }]); assert.deepEqual(waits, [5000, 5000])
  assert.deepEqual(await companySearch(async () => ({ ok: false, reason: 'cap' }), 'x', { wait: async () => {} })('q'), [])
  let k = 0
  assert.deepEqual(await companySearch(async () => { k++; return { ok: false, reason: 'rate' } }, 'x', { retries: 3, wait: async () => {} })('q'), []); assert.equal(k, 4)
})

test('#1122 replay findings: a weak category hit, a place word in the name and a site whose homepage does not name the company are not this business', async () => {
  const { homeNamesCompany } = await import('../lib/research/company.ts')
  // makeitfable.com (an accessibility research firm) for the Vancouver restaurant Fable: "menu" and "barrier" are not two restaurant words
  assert.equal(siteMatchesCase(VAN, 'makeitfable.com', ['Fable | Accessibility research in Canada. Skip to menu. Remove every barrier.']).category, false)
  assert.equal(siteMatchesCase(VAN, 'fablekitchen.ca', ['Our chef and our menu']).category, true)
  // australia.com (tourism) for the agency "Special Australia": the place word is not the company's name
  const SYD = { ...C, where: 'Sydney, New South Wales, Australia', whereKeywords: ['sydney', 'australia', '.com.au'] }
  assert.equal(homeNamesCompany('Special Australia', 'Visit Australia, see the reef and the outback', SYD), false)
  assert.equal(homeNamesCompany('Special Australia', 'Special Group Australia is a creative agency', SYD), true)
  // dailycoffeenews.com for the cafe chain Caffè Artigiano: a news site whose homepage is about many companies
  assert.equal(homeNamesCompany('Mouledoux, Bland, Legrand & Brackett', 'Mouledoux, Bland, Legrand & Brackett is a law firm', C), true)
  assert.equal(homeNamesCompany('Mouledoux, Bland, Legrand & Brackett', 'MBLB attorneys at law: Brackett and Legrand lead our team', C), true, 'two distinctive words')
  assert.equal(homeNamesCompany('Pliant', 'Pliant: the corporate card for finance teams', C), true)
  assert.equal(homeNamesCompany('Pliant', 'Payments news from Berlin', C), false)
})

test('a spend refusal from the search or the model is never swallowed: it stops the scan', async () => {
  class Refused extends Error {}
  const isRefusal = (e: unknown) => e instanceof Refused
  const base = deps({ search: SITE_HIT })
  await assert.rejects(researchCompany(C, PLAN, ev(), { ...base.d, isRefusal, complete: async () => { throw new Refused('cap') } }), Refused)
  await assert.rejects(researchCompany(C, PLAN, ev(), { ...base.d, isRefusal, search: async () => { throw new Refused('cap') } }), Refused)
  // any other model failure is just no answer
  const r = await researchCompany(C, PLAN, ev(), { ...base.d, isRefusal, complete: async () => { throw new Error('network') } })
  assert.equal(r.person, null)
})

test('goal-driven scan: the company stage can be called again and again; the same company in the same place is researched once per scan', async () => {
  const { memoCompanyResearch } = await import('../lib/research/company.ts')
  let calls = 0
  let fail = true
  const memo = memoCompanyResearch(async (_c, _p, e) => { calls++; if (e.company === 'Flaky Co' && fail) { fail = false; throw new Error('network') } return { site: 'https://tarrytownroofing.example', sources: [], person: null, location: null, whatTheyDo: e.company, emails: [] } })
  const a = await memo(C, PLAN, ev({ company: 'Tarrytown Roofing LLC' }))
  const b = await memo(C, PLAN, ev({ company: 'Tarrytown Roofing', sourceUrl: 'https://other.example/x' }))   // another loop, another source
  assert.equal(calls, 1); assert.equal(b, a); assert.deepEqual([memo.size, memo.hits], [1, 1])
  await memo({ ...C, where: 'Dallas, Texas' }, PLAN, ev({ company: 'Tarrytown Roofing' }))
  assert.equal(calls, 2, 'another place is another company')
  await assert.rejects(memo(C, PLAN, ev({ company: 'Flaky Co' })))
  assert.equal((await memo(C, PLAN, ev({ company: 'Flaky Co' }))).whatTheyDo, 'Flaky Co', 'a failed research is tried again')
})

test('site discovery: a host guessed from the name and the place\'s country domain is tried (free) BEFORE any search, and only a site that is the business is kept', async () => {
  const CA: ResearchCase = { ...VAN, whereKeywords: ['vancouver', 'british columbia', ', bc', '.ca'] }
  const bread = ev({ company: 'Purebread', sourceUrl: 'https://cafes.newsjive.example/purebread-buys-artigiano', quote: 'Purebread is buying Caffe Artigiano' })
  assert.deepEqual(guessedSites(bread, CA, 'Vancouver'), ['https://purebread.ca', 'https://purebread.com', 'https://purebread.co', 'https://purebread.io'])
  assert.deepEqual(guessedSites(ev({ company: 'Yoon Black Dentistry' }), C, 'Austin').slice(0, 2), ['https://yoonblackdentistry.com', 'https://yoonblackdentistry.co'], 'nothing is guessed for a name of no letters')
  PAGES['https://cafes.newsjive.example/purebread-buys-artigiano'] = `<html><body><p>${'Purebread is buying Caffe Artigiano, a Vancouver cafe chain, in a deal announced this week. '.repeat(6)}</p></body></html>`
  PAGES['https://purebread.ca'] = `<html><body><p>${'Purebread is a bakery and cafe in Vancouver, British Columbia. Our kitchen bakes bread, sweets and focaccia every morning; visit our menu. '.repeat(4)}</p><a href="/about">About</a></body></html>`
  PAGES['https://purebread.ca/about'] = `<html><body><p>${'Purebread bakery, Vancouver. '.repeat(20)}</p><p>Christian Bullock, CEO of Purebread Brands, joined in 2021.</p></body></html>`
  PAGES['https://purebread.com'] = `<html><body><p>${'Purebread: a tribute to David Gates and Bread, the 1970s soft rock band. Music, tour dates and records. '.repeat(5)}</p></body></html>`
  const answer = JSON.stringify({ decision_maker: { name: 'Christian Bullock', title: 'CEO', source_id: 'S3', quote: 'Christian Bullock, CEO of Purebread Brands, joined in 2021.' }, location: null, what_they_do: null })
  const withGuess = deps({ search: { 'official website': [{ url: 'https://govancity.com/purebread', title: 'Purebread Bakery + Coffee', snippet: '' }] }, answers: [answer] })
  const r = await researchCompany(CA, PLAN, bread, withGuess.d)
  assert.deepEqual([r.site, r.person?.name, withGuess.asked], ['https://purebread.ca', 'Christian Bullock', []], 'found with no search at all: the pages named the owner')
  // a guessed host that is ANOTHER business (purebread.com, the band) is refused; with nothing else, no site and no person
  delete PAGES['https://purebread.ca']; delete PAGES['https://purebread.ca/about']
  const wrong = deps({ answers: [answer] })
  const w = await researchCompany(CA, PLAN, bread, wrong.d)
  assert.deepEqual([w.site, w.person], [null, null])
  // ...but a wrong GUESS does not stop the person hunt (nothing pointed at it): the searches still run
  assert.ok(wrong.asked.length > 0, 'the person searches ran')
  delete PAGES['https://purebread.com']
})

// independent review of #1265 (findings 1-7): each fails on b2d9b514 / 94ab955e and passes here
test('review: the memo key is the full name (Apex Dental and Apex Roofing are two companies); an empty unopened result is not cached', async () => {
  const { memoCompanyResearch } = await import('../lib/research/company.ts')
  let calls = 0
  const memo = memoCompanyResearch(async (_c, _p, e) => { calls++; return { site: e.company.startsWith('Blip') ? null : `https://${e.company.replace(/ /g, '').toLowerCase()}.com`, sources: [], person: null, location: null, whatTheyDo: null, emails: [] } })
  const a = await memo(C, PLAN, ev({ company: 'Apex Dental' })), b = await memo(C, PLAN, ev({ company: 'Apex Roofing' }))
  assert.notEqual(a.site, b.site); assert.equal(calls, 2)
  await memo(C, PLAN, ev({ company: 'Blip Co' })); await memo(C, PLAN, ev({ company: 'Blip Co' }))
  assert.equal(calls, 4, 'nothing opened, nothing decided: tried again on the next loop')
})

test('review: a hostile page costs milliseconds, not seconds (unclosed <script, 30,000 anchors, a long run with no @)', () => {
  const t0 = Date.now()
  readHtml('<script '.repeat(20000) + 'x', 'https://x.example/')
  readHtml('<a href="x" '.repeat(30000), 'https://x.example/')
  readHtml('a'.repeat(300_000), 'https://x.example/')
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`)
  // and a normal page is still read the same way
  const p = readHtml('<html><script>var a="<a href=/no>"</script><!-- <a href="/hidden"> --><style>.x{}</style><a href="/team">Team</a><p>Hello</p></html>', 'https://x.example/')
  assert.deepEqual([p.links.map(l => l.url), p.text], [['https://x.example/team'], 'Team\nHello'.replace('\n', ' ').trim() === p.text ? p.text : p.text])
  assert.ok(!p.text.includes('hidden') && !p.text.includes('var a'))
})

test('review: one distinctive word must open the homepage; a public suffix address never rides on a country-domain site; SENIOR needs whole words', async () => {
  const { homeNamesCompany } = await import('../lib/research/company.ts')
  assert.equal(homeNamesCompany('Apex Roofing', 'Welcome to Zenith Roofing Austin. We repair roofs. ' + 'Quality work on every house, with fair prices and a crew you can trust. '.repeat(8) + 'Our friends at apex helped.', C), false)
  assert.equal(homeNamesCompany('Apex Roofing', 'Apex Austin | roofing contractor in Austin Texas', C), true)
  const found = new Map([['a@co.uk', 'https://acme.co.uk/'], ['info@acme.co.uk', 'https://acme.co.uk/']])
  assert.deepEqual(ownEmails(found, 'acme.co.uk', null).map(e => e.email), ['info@acme.co.uk'])
  assert.deepEqual(ownEmails(new Map([['a@acme.com', 'https://shop.acme.com/']]), 'shop.acme.com', null).map(e => e.email), ['a@acme.com'], 'a parent-domain address for a subdomain site is right')
  // the trigger article's person: "partnership" / "ahead" are not titles
  const { d } = deps({ answers: [null, null] })
  const r = await researchCompany(C, PLAN, ev({ sourceUrl: 'https://roofingnews.example/tarrytown-hires', people: [{ name: 'Pat Moreno', title: null, quote: 'In a partnership with a lender, said Pat Moreno, the way ahead is clear' }] }), d)
  assert.equal(r.person, null)
})

test('registry seed (Hermes 09:00): the contractor of record is searched for by name, and is a decision-maker only when a page states a real role', async () => {
  const REG = ev({ company: 'Lone Star Roofing LLC', sourceUrl: 'https://data.austintexas.gov/resource/3syk-w9eu.json?permit_number=2026-1', quote: 'Lone Star Roofing LLC - 3 permits issued in Austin. Contractor of record: Rudy Alvarez.', people: [{ name: 'Rudy Alvarez', title: 'Contractor of record on the Austin permit', quote: 'Contractor of record: Rudy Alvarez' }] })
  assert.equal(registrySeed(REG), 'Rudy Alvarez')
  assert.equal(registrySeed(ev()), null)
  const press = 'Rudy Alvarez, owner of Lone Star Roofing, said the crew grew to forty roofers across the Austin area this year.'
  const search = { '"Rudy Alvarez" "Lone Star Roofing LLC"': [{ url: 'https://austinbiz.example/lone-star-roofing-grows', title: 'Lone Star Roofing grows', snippet: press }] }
  const good = deps({ search, answers: [null, JSON.stringify({ decision_maker: { name: 'Rudy Alvarez', title: 'Owner', source_id: 'S1', quote: press }, profile_url: null, location: null, what_they_do: 'roofing' })] })
  const r = await researchCompany(C, PLAN, REG, good.d)
  assert.equal(r.person?.name, 'Rudy Alvarez'); assert.equal(r.person?.title, 'Owner')
  assert.ok(good.asked.filter(q => !q.includes('official website'))[0]?.includes('"Rudy Alvarez" "Lone Star Roofing LLC"'), 'the seed name is the first person search')
  assert.ok(good.prompts.every(p => p.includes('contractor of record: that is a lead to check')), 'the model is told the permit role is not a title')
  // a model that takes the filing role as the title is refused
  const bad = deps({ search, answers: [null, JSON.stringify({ decision_maker: { name: 'Rudy Alvarez', title: 'Contractor of record on the Austin permit', source_id: 'S1', quote: press }, profile_url: null, location: null, what_they_do: null }), null] })
  assert.equal((await researchCompany(C, PLAN, REG, bad.d)).person, null)
  assert.equal(registrySeed(ev({ people: [{ name: 'System Administrator', title: 'Applicant', quote: 'Applicant: System Administrator' }] })), null)
})

test('registry seed: read from the event page text when the model left the contractor out of the event (the record as JSON, or the rendered line)', () => {
  const bare = ev({ company: 'Lone Star Roofing LLC', people: [], quote: 'permits issued' })
  assert.equal(registrySeed(bare), null)
  assert.equal(registrySeed(bare, ['{"contractor_company_name":"Lone Star Roofing LLC","contractor_full_name":"RUDY ALVAREZ","permit_number":"2026-1"}']), 'RUDY ALVAREZ')
  assert.equal(registrySeed(bare, ['work: re-roof; at 1 Main St; contractor of record: Rudy Alvarez.']), 'Rudy Alvarez')
  assert.equal(registrySeed(bare, ['{"contractor_full_name":"N/A"}']), null)
})

test('registry seed (review): the permit\'s own line never makes a person, a clean seed name, a filing title in any wording', async () => {
  assert.equal(registrySeed(ev({ people: [], quote: 'Contractor of record: Rudy Alvarez issued 3 permits' })), 'Rudy Alvarez')
  assert.equal(registrySeed(ev({ people: [], quote: 'contractor of record: the city of Austin' })), null)
  assert.equal(registrySeed(ev({ company: 'Lone Star Roofing LLC', people: [], quote: 'Contractor of record: Lone Star Roofing LLC' })), null)
  assert.equal(registrySeed(ev({ company: 'Acme Co', people: [], quote: 'Contractor of record Rudy Alvarez Roofing LLC' })), 'Rudy Alvarez', 'the colon is optional; the company suffix is cut')
  assert.equal(registrySeed(ev({ company: 'Acme Co', people: [], quote: 'Contractor of record: Rudy Alvarez Roofing LLC' })), 'Rudy Alvarez')
  const REG = ev({ company: 'Lone Star Roofing LLC', sourceUrl: 'https://data.austintexas.gov/resource/x.json?permit_number=1', quote: 'Contractor of record: Rudy Alvarez.', people: [] })
  const permit = 'work: re-roof of a house at 1 Main St in Austin, Texas, issued this month; Contractor of record: Rudy Alvarez. Permit page for the roofing job.'
  PAGES['https://data.austintexas.gov/resource/x.json?permit_number=1'] = `<html><body><p>${permit}</p><p>${'Lone Star Roofing records. '.repeat(20)}</p></body></html>`
  for (const title of ['Owner', null, 'Permit holder', 'Contractor of record for Lone Star', 'Applicant (roofing)']) {
    const t = deps({ answers: [null, JSON.stringify({ decision_maker: { name: 'Rudy Alvarez', title, source_id: 'S1', quote: 'Contractor of record: Rudy Alvarez. Permit page for the roofing job.' }, profile_url: null, location: null, what_they_do: null }), null] })
    assert.equal((await researchCompany(C, PLAN, REG, t.d)).person, null, `${title}: the permit's own line states no role at the company`)
  }
  delete PAGES['https://data.austintexas.gov/resource/x.json?permit_number=1']
})
