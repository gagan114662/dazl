// #878 / #1107: a request for companies that POSTED about something is dated by the company's own post.
// REAL: test/fixtures/own-post-pages-20261114.json holds ten pages behind undated-held leads: nine from the prod matrix of 2026-11-14 (deployed 3fb162e5, mxprod3):
// each page fetched once from this PC and passed through the repo's own htmlToText (title, published, JSON-LD blocks, text), with the lead's stored company and
// quote and its hold reason (nine from prod; Surf Digital from a local matrix:local run on main 02dd2e55, 2026-11-15). Email addresses and phone numbers in the page text are replaced by <email> / <phone>; no prod id is kept. Four are the Sydney agencies' own posts; five are the negatives this rule must never date.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { asksForPost, domainLabel, earlierStamp, isArticleAddress, isOwnSite, looksLikePost, ownPostDate, statesDay } from '../lib/scan/own-post-date.ts'
import { evidenceRecheck } from '../lib/scan/evidence-recheck.ts'
import { finishUndatedLeads } from '../lib/scan/structured-date.ts'

interface Real { company: string; url: string; excerpt: string; prod: { review_reason: string; published_at: string | null; source?: string }; page: { title: string; published: string | null; structured: string[]; text: string } }
const REAL = JSON.parse(readFileSync(new URL('./fixtures/own-post-pages-20261114.json', import.meta.url), 'utf8')) as Real[]
const SYDNEY = 'Marketing agencies in Sydney, Australia posting about outbound, cold email or lead generation in the last 90 days'   // the matrix request, verbatim
const of = (c: string) => REAL.find(r => r.company === c)!

test('#878 the data: all ten leads were held outside_window_undated (nine on prod, Surf Digital on a local main run), every page had a publication day in its markup, and dazl kept it as a label only', () => {
  assert.equal(REAL.length, 10)
  for (const r of REAL) { assert.equal(r.prod.review_reason, 'outside_window_undated', r.company); assert.ok(r.page.published, r.company) }
})

test('#878 real pages: the agencies\' own posts are dated by their own day (4 of 5); the fifth\'s byline shows another day and it stays held', () => {
  const got = Object.fromEntries(['Digital Symantec', 'Outbounda', 'David Eid', 'Surf Digital', 'Sagar Sethi'].map(c => { const r = of(c); return [c, ownPostDate({ request: SYDNEY, company: c, url: r.url, excerpt: r.excerpt, page: r.page })] }))
  assert.equal(got['Digital Symantec'].date, '2026-10-17')
  assert.equal(got['Outbounda'].date, '2026-09-22')
  assert.equal(got['David Eid'].date, '2026-08-23')
  assert.equal(got['Surf Digital'].date, '2026-10-20', 'surf-digital.com: a hyphen in the domain is not part of the name')
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
  assert.equal(domainLabel('https://sagarsethi.com.au/x'), 'sagarsethi'); assert.equal(isOwnSite('https://surf-digital.com/x', 'Surf Digital'), true); assert.equal(domainLabel('https://www.digitalsymantec.com/x'), 'digitalsymantec'); assert.equal(domainLabel('https://blog.outbounda.io/x'), 'outbounda'); assert.equal(domainLabel('https://acme.co.uk/x'), 'acme')
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

// Independent review (fresh reviewer, 4/10 CHANGES): each case below dated on the first version of the rule and is held now.
const ACME = (over: Partial<{ request: string; url: string; excerpt: string; text: string; published: string; structured: string[] }> = {}) => {
  const excerpt = over.excerpt ?? 'Cold email still books meetings for B2B agencies when the list is small and the offer is specific.'
  const text = over.text ?? `Acmegrowth Blog. Cold email in 2026. Published 1 October 2026 by the Acmegrowth team. ${excerpt} More on outbound below. ${'Outbound paragraph. '.repeat(20)}`
  return { request: over.request ?? SYDNEY, company: 'Acmegrowth', url: over.url ?? 'https://acmegrowth.com.au/blog/cold-email-in-2026', excerpt, page: { text, published: over.published ?? '2026-10-01', structured: over.structured ?? [] } }
}
test('#878 (review) the post must be the request\'s only event, asked for and not excluded; a quote that dates its own story is held', () => {
  assert.equal(ownPostDate(ACME()).date, '2026-10-01', 'control: a plain own post under the Sydney request dates')
  for (const request of [
    'Agencies in Sydney that opened a new office or are posting about outbound in the last 90 days',   // another event before the post
    'Agencies in Sydney posting about outbound or that opened a new office in the last 90 days',       // another event after it
    'Marketing agencies in Sydney that are not posting about outbound in the last 90 days',
    'SaaS companies hiring SDRs in the last 30 days, excluding companies posting about AI',
    // (second review) a second event joined AFTER the phrase, or in a later sentence
    'Agencies in Sydney posting about outbound or opened a new office in the last 90 days',
    'Agencies in Sydney posting about cold email, or hiring SDRs, in the last 90 days',
    'Agencies in Sydney posting about outbound and hiring SDRs in the last 90 days',
    'Agencies in Sydney posting about outbound in the last 90 days. They must also have opened an office.',
  ]) assert.equal(ownPostDate(ACME({ request })).date, null, request)
  const melbourne = 'Back in March 2023 we opened our Melbourne office, and it has grown to twelve people since then.'
  assert.match(ownPostDate(ACME({ excerpt: melbourne })).why, /quote dates its own event/)
  for (const q of ['We opened in 2024 and have run cold email for every client since day one.', 'Last month our team booked forty meetings for a single client with cold email.', 'In Q3 our outbound programme for clients booked 140 meetings across Sydney.']) assert.equal(ownPostDate(ACME({ excerpt: q })).date, null, q)
  assert.equal(asksForPost('Agencies in the U.S. posting about cold email in the last 90 days'), true, 'an abbreviation does not end the sentence')
  for (const r of ['Agencies posting about hiring and onboarding SDRs', 'Founders blogging about fundraising and growth', 'Agencies posting about outbound, excluding those that raised funding']) assert.equal(asksForPost(r), true, `the post's topic is not a second event: ${r}`)
})
test('#878 (review) a slug is not a post: service, careers and landing pages need an article node or a blog / news address', () => {
  for (const url of ['https://acmegrowth.com.au/services/cold-email-outreach', 'https://acmegrowth.com.au/careers/senior-sales-development-rep', 'https://acmegrowth.com.au/contact-us-today']) assert.match(ownPostDate(ACME({ url })).why, /not a single article/, url)
  const article = JSON.stringify({ '@context': 'https://schema.org', '@type': 'BlogPosting', datePublished: '2026-10-01' })
  assert.equal(ownPostDate(ACME({ url: 'https://acmegrowth.com.au/cold-email-in-2026-what-works', structured: [article] })).date, '2026-10-01', 'an article node on a root slug')
  assert.equal(looksLikePost('https://acmegrowth.com.au/cold-email-in-2026-what-works', []), false)
})
test('#878 (review) the day must be the byline (top of the page or next to the quote), not a "recent posts" list; platforms are not anyone\'s own site', () => {
  const excerpt = 'Cold email still books meetings for B2B agencies when the list is small and the offer is specific.'
  const text = `Acmegrowth Blog. Cold email in 2026. By the Acmegrowth team. ${'Intro paragraph about outbound. '.repeat(60)}${excerpt} ${'Body paragraph about outbound. '.repeat(80)} Related posts: 1 October 2026 - Ten subject lines that work.`
  assert.match(ownPostDate(ACME({ text })).why, /does not state 2026-10-01 as the post's byline/)
  assert.equal(isOwnSite('https://medium.com/@someone/how-to-do-cold-email-well', 'Medium'), false)
  assert.equal(isOwnSite('https://www.linkedin.com/pulse/how-cold-email-works-jane-doe', 'LinkedIn'), false)
})
// (review R3) the evidence recheck re-derives the proof from the page. It must agree with the scan for a day this rule gave (it called it "not tied" before).
test('#878 (review) the evidence recheck agrees: the stored own-post day is bound and inside the window (the recheck called it not tied before)', async () => {
  const x = await runFixture(postFx(SYDNEY))
  const id = (x.db.prepare("SELECT id FROM leads WHERE company = 'Outbounda'").get() as { id: string }).id
  x.db.prepare('UPDATE scan_jobs SET offer = ?, seller = ?').run('Outbound appointment setting for agencies', 'Outbound appointment setting for agencies')
  const f = postFx(SYDNEY), url = Object.keys(f.own)[0], o = f.own[url] as { title: string; text: string; published: string; structured: string[] }
  const page = async () => ({ text: o.text, title: o.title, retrievedAt: Math.floor(Date.now() / 1000), published: o.published, structured: o.structured })
  const r = await evidenceRecheck(x.db, 'A', id, page)
  assert.equal(r?.status, 'checked', JSON.stringify(r))
  assert.equal(r?.checks?.event_date_bound, true, JSON.stringify(r?.checks)); assert.equal(r?.checks?.window, 'inside')
})
