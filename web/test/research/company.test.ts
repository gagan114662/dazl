// Research engine part G (lib/research/company.ts): site discovery, the company's own pages, person searches, the decision-maker with a
// VERBATIM quote that must be literally on its cited source, and emails printed on the company's own domain. Stub network and model;
// page shapes taken from real pages the prototype read (names replaced).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findSite, nameTokens, quoteIn, readHtml, researchCompany, type CompanyDeps, type SearchResult } from '../../lib/research/company.ts'
import type { ResearchCase, ResearchEvent, ResearchPlan } from '../../lib/research/types.ts'

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
  assert.deepEqual(r.emails, [{ email: 'office@tarrytownroofing.com', url: 'https://tarrytownroofing.com' }, { email: 'dana@tarrytownroofing.com', url: 'https://tarrytownroofing.com/our-team' }], 'own domain only: the news page\'s hello@ is not on the company\'s pages; sales@othercompany.com and logo@2x are not addresses of this company')
  assert.equal(prompts.length, 1, 'one model call when it names someone')
  assert.ok(asked.some(q => q.startsWith('site:tarrytownroofing.com')) && asked.some(q => q.startsWith('who owns Tarrytown Roofing Austin')))
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
  const answer = JSON.stringify({ decision_maker: { name: 'Dana Whitlock', title: 'Owner', source_id: 'S6', quote: 'Dana Whitlock - Owner - Tarrytown Roofing | LinkedIn' }, profile_url: 'https://www.linkedin.com/in/dana-whitlock-roofing', location: null, what_they_do: null })
  const { d } = deps({ search: { ...SITE_HIT, ...snip }, answers: [answer] })
  const r = await researchCompany(C, PLAN, ev(), d)
  assert.equal(r.sources.find(s => s.id === 'S6')?.kind, 'snippet', 'LinkedIn is never opened, its snippet is the source')
  assert.deepEqual([r.person?.name, r.person?.profileUrl], ['Dana Whitlock', 'https://www.linkedin.com/in/dana-whitlock-roofing'])
  const made = JSON.stringify({ ...JSON.parse(answer), profile_url: 'https://www.linkedin.com/in/someone-else' })
  assert.equal((await researchCompany(C, PLAN, ev(), deps({ search: { ...SITE_HIT, ...snip }, answers: [made] }).d)).person?.profileUrl, null)
})

test('nothing found: no site, no pages, no sources -> no model call, an empty research', async () => {
  const { d, prompts } = deps()
  const r = await researchCompany(C, PLAN, ev({ sourceUrl: 'https://gone.example/x' }), d)
  assert.deepEqual([r.site, r.sources.length, r.person, r.emails.length, prompts.length], [null, 0, null, 0, 0])
})
