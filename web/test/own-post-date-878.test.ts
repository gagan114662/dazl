// #878 / #1107: a request for companies that POSTED about something is dated by the company's own post.
// REAL: test/fixtures/own-post-pages-20261114.json holds the nine pages behind undated-held leads of the prod matrix of 2026-11-14 (deployed 3fb162e5, mxprod3):
// each page fetched once from this PC and passed through the repo's own htmlToText (title, published, JSON-LD blocks, text), with the lead's stored company and
// quote and the prod job / hold reason. Four are the Sydney agencies' own posts; five are the negatives this rule must never date.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { asksForPost, domainLabel, earlierStamp, isArticleAddress, isOwnSite, ownPostDate, statesDay } from '../lib/scan/own-post-date.ts'
import { finishUndatedLeads } from '../lib/scan/structured-date.ts'

interface Real { company: string; url: string; excerpt: string; prod: { job: string; review_reason: string; published_at: string | null }; page: { title: string; published: string | null; structured: string[]; text: string } }
const REAL = JSON.parse(readFileSync(new URL('./fixtures/own-post-pages-20261114.json', import.meta.url), 'utf8')) as Real[]
const SYDNEY = 'Marketing agencies in Sydney, Australia posting about outbound, cold email or lead generation in the last 90 days'   // the matrix request, verbatim
const of = (c: string) => REAL.find(r => r.company === c)!

test('#878 the data: all nine leads were held outside_window_undated on prod, every page had a publication day in its markup, and dazl kept it as a label only', () => {
  assert.equal(REAL.length, 9)
  for (const r of REAL) { assert.equal(r.prod.review_reason, 'outside_window_undated', r.company); assert.ok(r.page.published, r.company) }
})

test('#878 real pages: the agencies\' own posts are dated by their own day (3 of 4); the fourth\'s byline shows another day and it stays held', () => {
  const got = Object.fromEntries(['Digital Symantec', 'Outbounda', 'David Eid', 'Sagar Sethi'].map(c => { const r = of(c); return [c, ownPostDate({ request: SYDNEY, company: c, url: r.url, excerpt: r.excerpt, page: r.page })] }))
  assert.equal(got['Digital Symantec'].date, '2026-10-17')
  assert.equal(got['Outbounda'].date, '2026-09-22')
  assert.equal(got['David Eid'].date, '2026-08-23')
  // markup 2026-10-03T15:43Z (UTC), byline "October 4, 2026" (Australian time): held, never guessed
  assert.equal(got['Sagar Sethi'].date, null); assert.match(got['Sagar Sethi'].why, /visible text does not state 2026-10-03/)
})

test('#878 real pages: a project page, a roundup on another site, a quote page of a roofer, a client case study and a funding story are never dated by this rule', () => {
  const why: Record<string, RegExp> = { 'Garner Collective': /not a single article/, 'Moss': /not the company's own site/, 'Texas Specialty Roofing': /not the company's own site/, 'Vytalise': /not the company's own site/, 'mika': /not the company's own site/ }
  for (const [c, re] of Object.entries(why)) { const r = of(c); const x = ownPostDate({ request: SYDNEY, company: c, url: r.url, excerpt: r.excerpt, page: r.page }); assert.equal(x.date, null, c); assert.match(x.why, re, c) }
})

test('#878 the same real posts under a request that is not about posting are never dated (the publication day stays a label)', () => {
  for (const req of ['Marketing agencies in Sydney, Australia that opened a new office in the last 90 days', 'Marketing agencies in Sydney that are hiring an SDR', 'Find marketing agencies in Sydney. Exclude agencies posting about outbound.']) {
    for (const c of ['Digital Symantec', 'Outbounda', 'David Eid']) { const r = of(c); assert.equal(ownPostDate({ request: req, company: c, url: r.url, excerpt: r.excerpt, page: r.page }).date, null, `${req} / ${c}`) }
  }
  assert.equal(asksForPost(SYDNEY), true)
  for (const r of ['Agencies that wrote about cold email', 'Founders blogging about fundraising', 'Brands that posted on LinkedIn about a launch', 'Agencies posting on their blog about SEO']) assert.equal(asksForPost(r), true, r)
  for (const r of ['Firms that published an update on hiring', 'Agencies with a blog', 'Companies that opened a new office', 'Agencies that post jobs']) assert.equal(asksForPost(r), false, r)
  assert.equal(asksForPost('Firms that published a report about hiring'), false, 'only "<verb> about|on" counts: no guessing at objects in between')
})

test('#878 guards: each condition holds the lead on its own (synthetic variations of the real David Eid post)', () => {
  const r = of('David Eid'), base = { request: SYDNEY, company: 'David Eid', url: r.url, excerpt: r.excerpt, page: r.page }
  assert.equal(ownPostDate(base).date, '2026-08-23', 'control: the real page dates')
  // a republished / backdated piece: any JSON-LD stamp earlier than the publication day
  const older = JSON.stringify({ '@context': 'https://schema.org', '@type': 'BlogPosting', datePublished: '2026-08-23', dateCreated: '2024-02-01' })
  assert.match(ownPostDate({ ...base, page: { ...r.page, structured: [...r.page.structured, older] } }).why, /earlier dateCreated 2024-02-01/)
  // the quote is from another page of the site
  assert.match(ownPostDate({ ...base, excerpt: 'We help Australian B2B companies book more meetings every single month.' }).why, /quote is not on this page/)
  // no single publication day in the markup (the fetcher found none or several)
  assert.match(ownPostDate({ ...base, page: { ...r.page, published: null } }).why, /no single publication day/)
  // a listing, not one article
  for (const u of ['https://davideid.co/blog/', 'https://davideid.co/blog/category/cold-outreach-tips-here', 'https://davideid.co/tag/does-cold-outreach-work', 'https://davideid.co/blog/page/2', 'https://davideid.co/outreach']) assert.match(ownPostDate({ ...base, url: u }).why, /not a single article/, u)
  // another company's site, a lookalike, a short name
  assert.match(ownPostDate({ ...base, url: 'https://medium.com/@davideid/does-cold-outreach-still-work' }).why, /own site/)
  assert.match(ownPostDate({ ...base, url: 'https://davideidmarketing.co/blog/does-cold-outreach-still-work' }).why, /own site/)
  assert.equal(isOwnSite('https://jkd.com.au/blog/a-b-c', 'JKD'), false, 'a name under four letters never matches a domain')
})

test('#878 helpers: registrable labels, article addresses, bylines', () => {
  assert.equal(domainLabel('https://sagarsethi.com.au/x'), 'sagarsethi'); assert.equal(domainLabel('https://www.digitalsymantec.com/x'), 'digitalsymantec'); assert.equal(domainLabel('https://blog.outbounda.io/x'), 'outbounda'); assert.equal(domainLabel('https://acme.co.uk/x'), 'acme')
  assert.equal(isOwnSite('https://outbounda.io/blog/x', 'Outbounda'), true); assert.equal(isOwnSite('https://www.digitalsymantec.com/x', 'Digital Symantec Pty Ltd'), true)
  assert.equal(isArticleAddress('https://outbounda.io/blog/b2b-saas-outbound-playbook'), true); assert.equal(isArticleAddress('https://garnercollective.com.au/projects/updapt'), false)
  for (const t of ['Posted 2026-08-23 by', '23 August 2026 3 min read', 'August 23, 2026', 'Aug 23 2026', '23rd of August, 2026']) assert.equal(statesDay(t, '2026-08-23'), true, t)
  for (const t of ['23/08/2026', 'August 2026', '24 August 2026', 'August 3, 2026']) assert.equal(statesDay(t, '2026-08-23'), false, t)
  assert.equal(earlierStamp([JSON.stringify({ '@graph': [{ '@type': 'WebPage', dateModified: '2026-09-01' }] })], '2026-08-23'), null, 'a later update is fine')
})

// The finishing pass (structured-date.ts finishUndatedLeads): the rule runs only when the structured-data rule found nothing, and only for an undated lead.
test('#878 finishUndatedLeads: an undated lead from a real own post gets the day, the page_bound proof and a note that says where the day came from', async () => {
  const r = of('Outbounda')
  const lead = { company: 'Outbounda', signal: 'Posted about outbound for B2B SaaS', excerpt: r.excerpt, source_url: r.url, event_date: null as string | null, timing_note: null as string | null, event_date_proof: null as 'page_bound' | 'ats_structured' | null, event_date_proof_note: null as string | null }
  const fetchPage = async () => ({ text: r.page.text, published: r.page.published, structured: r.page.structured })
  const done = await finishUndatedLeads([lead], fetchPage, 6, ['Sydney, Australia'], SYDNEY)
  assert.deepEqual(done, [{ company: 'Outbounda', date: '2026-09-22', kind: 'OwnPost', url: r.url }])
  assert.equal(lead.event_date, '2026-09-22'); assert.equal(lead.event_date_proof, 'page_bound'); assert.match(lead.timing_note!, /own post on its own site/)
  // control: without the request (every caller before this change) nothing is dated
  const lead2 = { ...lead, event_date: null, event_date_proof: null, timing_note: null }
  assert.deepEqual(await finishUndatedLeads([lead2], fetchPage, 6, ['Sydney, Australia']), []); assert.equal(lead2.event_date, null)
})

// Runner level: the real verifier, the window gate and the stored lead. REAL: the Sydney request and the Outbounda post's text. SYNTHETIC: the day (moved to 20 days
// ago so the test never ages out of the 90-day window: the byline and the markup are rewritten to that day together), the profile, the search result and the model replies.
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const byline = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}` }
function postFx(request: string): Fixture {
  const r = of('Outbounda'), day = daysAgo(20)
  const text = r.page.text.replace(/22 September 2026/g, byline(day))
  const ld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'BlogPosting', headline: r.page.title, datePublished: day })
  const icp = { summary: request, who: ['Agency owner'], industries: ['Marketing agencies'], sizes: [], where: ['Sydney, Australia'], signals: ['posting about outbound'], exclude: [], language: 'en', window_days: 90 }
  return {
    request, modelIcp: icp, modelQueries: ['Sydney agency outbound cold email blog'],
    hits: [{ url: r.url, title: r.page.title, snippet: r.excerpt.slice(0, 140), date: null as unknown as string }],
    tfPages: { [r.url]: { title: r.page.title, text } }, own: { [r.url]: { title: r.page.title, text, published: day, structured: [ld] } },
    extraction: [{ company: 'Outbounda', signal: 'Posted a guide to outbound for B2B SaaS', source_url: r.url, excerpt: r.excerpt, event_date: null as unknown as string }],
  }
}
test('#878 runner: the own post of a "posting about" request is stored dated and page_bound, not held outside_window_undated (control: the same page for another request stays held)', async () => {
  const x = await runFixture(postFx(SYDNEY))
  const lead = x.leads.find(l => l.company === 'Outbounda'); assert.ok(lead, JSON.stringify(x.leads))
  const row = x.db.prepare("SELECT event_date, event_date_proof, review_reason, timing_note FROM leads WHERE company = 'Outbounda'").get() as Record<string, string | null>
  assert.equal(row.event_date, daysAgo(20)); assert.equal(row.event_date_proof, 'page_bound'); assert.notEqual(row.review_reason, 'outside_window_undated', JSON.stringify(row))
  const c = await runFixture(postFx('Marketing agencies in Sydney, Australia that published a new service page in the last 90 days'))
  const crow = c.db.prepare("SELECT event_date, event_date_proof, review_reason FROM leads WHERE company = 'Outbounda'").get() as Record<string, string | null>
  assert.equal(crow.review_reason, 'outside_window_undated', JSON.stringify(crow)); assert.equal(crow.event_date_proof, null)
})
