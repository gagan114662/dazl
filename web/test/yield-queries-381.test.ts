// #381 yield, measured first on REAL data (staging, 2026-11-13, the 8-market matrix; test/fixtures/yield-381-matrix-20261113.json holds the requests, the profiles,
// the queries each scan really sent, every result URL with its fetch selection and every candidate with its fate; search snippets were not stored and are not in it).
// The measured loss before any page is read: the job-board query took one of the three searches of 5 of the 7 scans and found unrelated software companies' Greenhouse
// pages; 8 of the 23 candidates came from login-walled hosts and all 8 died.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { boardQueries, localServiceCategory, directQueries } from '../lib/search/direct-queries.ts'
import { isLoginWalled } from '../lib/search/tinyfish.ts'

interface Job { job: string; query: string; icp: { where: string[]; signals: string[]; industries: string[] }; queries: string[]; urls: { url: string; selected: boolean; walled: boolean }[]; candidates: { company: string; url: string; fate: string }[] }
const REAL = JSON.parse(readFileSync(new URL('./fixtures/yield-381-matrix-20261113.json', import.meta.url), 'utf8')) as { jobs: Job[] }
const BOARD = /site:boards\.greenhouse\.io|site:job-boards\.greenhouse\.io/

test('#381 the data: the job-board query was in 5 of the 7 real scans (3 of them without any hiring ask in the request)', () => {
  const withBoard = REAL.jobs.filter(j => j.queries.some(q => BOARD.test(q)))
  assert.equal(REAL.jobs.length, 7)
  assert.deepEqual(withBoard.map(j => j.query.split(' ')[0]).sort(), ['Dental', 'Fintech', 'Law', 'Restaurants', 'Roofing'])
})

test('#381 no job-board query for any of the 7 real requests: the request does not ask for hiring, or the category does not use job boards', () => {
  for (const j of REAL.jobs) assert.deepEqual(boardQueries(j.query, j.icp), [], `${j.job} ${j.query}`)
  // main's rule (request OR profile signals asked for hiring) produced the query for the ones whose profile signals mention hiring
  const before = REAL.jobs.filter(j => directQueries(j.query, j.icp.signals, j.icp.where).length > 0)
  assert.equal(before.length, 5, 'the old rule: Toronto, Austin, Chicago, Vancouver, Berlin')
})

test('#381 non-vacuity: a hiring request for a category that is not local-service still gets its board queries (status quo for the unrecognised)', () => {
  const icp = { signals: ['Hired first account executive in last 30 days'], where: ['Austin'], industries: ['B2B SaaS', 'Enterprise Software'] }
  const q = boardQueries('Austin B2B SaaS companies hiring their first account executive in the last 30 days', icp)
  assert.ok(q.length >= 1 && q.every(x => /site:/.test(x)), JSON.stringify(q))
  // the existing Ohio payroll request (no category word) keeps its board queries
  assert.ok(boardQueries('Find Ohio companies with 10 to 100 employees that recently posted a payroll, HR or office manager job', { signals: ['payroll job'], where: ['Ohio'], industries: [] }).length >= 1)
  assert.equal(localServiceCategory('Dental clinics in Toronto hiring front-desk staff', ['Dental clinics', 'Dentistry']), true)
  assert.equal(localServiceCategory('Berlin fintech startups hiring a CTO', ['Fintech']), false)
  // a request with no hiring ask gets none even when the profile's signals say hiring
  assert.deepEqual(boardQueries('SaaS companies in Berlin that raised a funding round', { signals: ['hiring a CTO'], where: ['Berlin'], industries: ['Software'] }), [])
})

test('#381 the data: 8 of the 23 real candidates came from walled / aggregator hosts and every one of them died; none of the 28 pages read was on such a host', () => {
  const walledOrAgg = (u: string) => isLoginWalled(u)
  const cands = REAL.jobs.flatMap(j => j.candidates), bad = cands.filter(c => walledOrAgg(c.url))
  assert.equal(cands.length, 23); assert.equal(bad.length, 8)
  assert.ok(bad.every(c => /blocked_by_site|quote_unconfirmed|outside_window_undated/.test(c.fate)), JSON.stringify(bad.map(c => c.fate)))
  assert.equal(REAL.jobs.flatMap(j => j.urls).filter(u => u.selected && walledOrAgg(u.url)).length, 0)
})

// Runner level: what the extraction step is OFFERED. REAL: the request, the profile, and the 21 result URLs of staging job 4f6581f2 (Toronto dental; 3 on walled hosts).
// SYNTHETIC: the title and snippet of each result (never stored) and the model replies.
import { runFixture, daysAgo, type Fixture, type Hit } from './helpers/acceptance-harness.ts'
const TORONTO = REAL.jobs.find(j => j.job === '4f6581f2')!
const hitsOf = (urls: string[]): Hit[] => urls.map((u, i) => ({ url: u, title: `Result ${i} ${new URL(u).hostname}`, snippet: `Synthetic snippet ${i}: a dental clinic in Toronto Ontario opened a new location this month and is hiring front desk staff ${i}.`, date: daysAgo(10) }))
const offeredIn = (prompt: string): string[] => { const m = prompt.match(/Items \(index, source, url, title, text, date\): (\[.*\])\n/); return m ? (JSON.parse(m[1]) as { url: string }[]).map(x => x.url) : [] }
function fx(urls: string[], seen: string[][]): Fixture {
  return { request: TORONTO.query, modelIcp: { ...TORONTO.icp, summary: TORONTO.query, who: ['Owner'], sizes: [], exclude: [], language: 'en', window_days: 90 }, modelQueries: [...TORONTO.queries.slice(1), 'Toronto dentist office announces new location'], hits: [], hitsFor: n => hitsOf(urls.slice(n * 7, n * 7 + 7)), tfPages: {}, own: {}, extraction: [], extractionFn: p => { if (/pre-collected public items/.test(p)) seen.push(offeredIn(p)); return [] } }
}
test('#381 hosts: walled by name in any country domain (glassdoor.ca, jobleads.com were missed), never by substring', () => {
  for (const u of ['https://www.glassdoor.ca/Job/x', 'https://www.jobleads.com/ca/job/x', 'https://ca.indeed.com/q-x', 'https://uk.linkedin.com/jobs/view/1', 'https://www.instagram.com/p/1', 'https://m.facebook.com/x', 'https://x.com/a/status/1', 'https://www.tiktok.com/@a']) assert.equal(isLoginWalled(u), true, u)
  for (const u of ['https://smilecitydental.ca/', 'https://wallindeed.com/', 'https://www.toronto.ca/x', 'https://job-boards.greenhouse.io/a/jobs/1', 'https://rex.com/', 'https://linkedinsight.example/']) assert.equal(isLoginWalled(u), false, u)
})

test('#381 runner: with enough readable results the walled ones (3 of the 21 real URLs of job 4f6581f2) are not offered to extraction; with too few they stay', async () => {
  const all = TORONTO.urls.map(u => u.url), walled = all.filter(u => isLoginWalled(u))
  assert.equal(all.length, 21); assert.ok(walled.length >= 3, `walled in the real result list: ${walled.length}`)
  const seen: string[][] = []
  await runFixture(fx(all, seen))
  const offered = seen.at(-1)!; assert.ok(offered.length > 0)
  assert.deepEqual(offered.filter(u => isLoginWalled(u)), [], 'no walled result offered')
  assert.deepEqual(all.filter(u => !isLoginWalled(u)).filter(u => !offered.includes(u)), [], 'every readable result is offered')
  assert.equal(offered.length, all.length - walled.length)
  // below the threshold (here 5 readable results + the walled ones) they all stay: a thin list needs every item
  const thin = [...all.filter(u => !isLoginWalled(u)).slice(0, 5), ...walled]
  const seen2: string[][] = []; await runFixture(fx(thin, seen2))
  assert.equal(seen2.at(-1)!.length, thin.length, 'a thin result list keeps its walled results')
})

// Grounding of snippet candidates. REAL: the request and profile of staging job 4f6581f2 (Toronto dental), whose real candidates died quote_unconfirmed /
// excerpt_not_on_page when their quote came from a search snippet (REAL fates in the fixture). SYNTHETIC: the page, the snippet, and both model replies (the model
// is a stub; what it proves is the pipeline: the grounded quote is the page's own text, so the strict verifier now passes it).
const CLINIC = 'https://www.example-dental-toronto.ca/news/second-location'
const PAGE_QUOTE = 'Example Dental Toronto announced the opening of its second clinic on Queen Street in Toronto, Ontario this month'
const PAGE = { title: 'Example Dental Toronto opens a second clinic', text: `Example Dental Toronto news, published ${daysAgo(12)}. ${PAGE_QUOTE} (${daysAgo(12)}). The new Toronto clinic welcomes patients from the first of the month.`, published: daysAgo(12), structured: [daysAgo(12)] }
const SNIPPET_QUOTE = 'Example Dental Toronto is opening a second clinic downtown Toronto ...'   // what a search snippet showed: NOT on the page
function groundFx(): Fixture {
  const f = fx([CLINIC], [])
  f.hits = []; f.hitsFor = n => n === 0 ? [{ url: CLINIC, title: 'Example Dental Toronto opens a second clinic', snippet: SNIPPET_QUOTE, date: daysAgo(12) }] : []
  f.own = { [CLINIC]: PAGE }; f.deps = { ...(f.deps ?? {}), ground: true }   // the harness switches grounding off by default
  f.extractionFn = p => /^You research sales leads/.test(p)
    ? [{ company: 'Example Dental Toronto', signal: 'opened a second clinic', source_url: CLINIC, excerpt: PAGE_QUOTE, event_date: daysAgo(12) }]   // grounding: verbatim from the page
    : [{ company: 'Example Dental Toronto', signal: 'opened a second clinic', source_url: CLINIC, excerpt: SNIPPET_QUOTE.replace(' ...', ''), event_date: daysAgo(12) }]   // extraction: from the snippet
  return f
}
test('#381 runner: a candidate built from a search snippet is grounded on its real page and then passes the strict verifier (before: held quote_unconfirmed)', async () => {
  const x = await runFixture(groundFx())
  assert.ok(x.calls.prompts.some(p => /^You research sales leads/.test(p)), 'the grounding pass ran')
  const lead = x.leads.find(l => l.company === 'Example Dental Toronto')
  assert.ok(lead, JSON.stringify(x.leads))
  assert.equal(lead!.review_reason, null, `verified, not held: ${JSON.stringify(x.leads.map(l => [l.company, l.review_reason]))}`)
  // control: with grounding off the same scan holds it, exactly as on main
  const f = groundFx(); f.deps = { ground: false }
  const y = await runFixture(f)
  assert.ok(!y.calls.prompts.some(p => /^You research sales leads/.test(p)))
  assert.equal(y.leads.find(l => l.company === 'Example Dental Toronto')?.review_reason, 'quote_unconfirmed')
})

test('#381 runner: a candidate the model cannot ground stays held for review, and a walled-host candidate is never sent to the grounding pass', async () => {
  const f = groundFx(); f.extractionFn = p => /^You research sales leads/.test(p) ? [] : [{ company: 'Example Dental Toronto', signal: 'opened a second clinic', source_url: CLINIC, excerpt: SNIPPET_QUOTE.replace(' ...', ''), event_date: daysAgo(12) }]
  const x = await runFixture(f)
  assert.equal(x.leads.find(l => l.company === 'Example Dental Toronto')?.review_reason, 'quote_unconfirmed', 'nothing grounded: unchanged, never lost')
  const IG = 'https://www.instagram.com/p/De2f-9eu7u6/'
  const g = groundFx(); g.hitsFor = n => n === 0 ? [{ url: IG, title: 'TDot Dental on Instagram', snippet: 'TDot Dental is growing: new location opening in Toronto', date: daysAgo(12) }] : []
  g.extractionFn = p => /^You research sales leads/.test(p) ? [] : [{ company: 'TDot Dental', signal: 'new location', source_url: IG, excerpt: 'TDot Dental is growing: new location opening in Toronto', event_date: null as never }]
  const y = await runFixture(g)
  assert.ok(!y.calls.prompts.some(p => /^You research sales leads/.test(p)), 'no grounding call for a walled host')
})
