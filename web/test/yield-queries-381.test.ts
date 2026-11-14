// #381 yield, measured first on REAL data (staging, 2026-11-13, the 8-market matrix; test/fixtures/yield-381-matrix-20261113.json holds the requests, the profiles,
// the queries each scan really sent, every result URL with its fetch selection and every candidate with its fate; search snippets were not stored and are not in it).
// The measured loss before any page is read: the job-board query took one of the three searches of 5 of the 7 scans (3 of them without any hiring ask in the request)
// and found unrelated software companies' Greenhouse pages; 8 of the 23 candidates came from login-walled hosts and all 8 died.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { boardQueries, directQueries } from '../lib/search/direct-queries.ts'
import { isLoginWalled } from '../lib/search/tinyfish.ts'

interface Job { job: string; query: string; icp: { where: string[]; signals: string[]; industries: string[] }; queries: string[]; urls: { url: string; selected: boolean; walled: boolean }[]; candidates: { company: string; url: string; fate: string }[] }
const REAL = JSON.parse(readFileSync(new URL('./fixtures/yield-381-matrix-20261113.json', import.meta.url), 'utf8')) as { jobs: Job[] }
const BOARD = /site:boards\.greenhouse\.io|site:job-boards\.greenhouse\.io/

test('#381 the data: the job-board query was in 5 of the 7 real scans (3 of them without any hiring ask in the request)', () => {
  const withBoard = REAL.jobs.filter(j => j.queries.some(q => BOARD.test(q)))
  assert.equal(REAL.jobs.length, 7)
  assert.deepEqual(withBoard.map(j => j.query.split(' ')[0]).sort(), ['Dental', 'Fintech', 'Law', 'Restaurants', 'Roofing'])
})

test('#381 the job-board query needs the request\'s own hiring ask: 3 of the 7 real requests (Chicago, Vancouver, Berlin) asked for none and got one from the model\'s profile signals', () => {
  const NO_HIRING = ['Chicago', 'Vancouver', 'Berlin']
  for (const j of REAL.jobs) {
    const city = NO_HIRING.find(c => j.query.includes(c)), now = boardQueries(j.query, j.icp).length, before = directQueries(j.query, j.icp.signals, j.icp.where).length
    if (city) { assert.equal(now, 0, `${j.job} ${j.query}`); assert.ok(before > 0, `${city}: main's rule produced ${before} board queries from the profile signals`) }
    else assert.equal(now, before, `${j.job}: a request that asks for hiring keeps its board queries`)
  }
  assert.equal(REAL.jobs.filter(j => j.queries.some(q => BOARD.test(q))).length, 5)
  assert.equal(REAL.jobs.filter(j => boardQueries(j.query, j.icp).length > 0).length, 2, 'Toronto and Austin remain')
})

test('#381 non-vacuity: a request that asks for hiring keeps its board queries; the profile signals never add the query type', () => {
  const icp = { signals: ['Hired first account executive in last 30 days'], where: ['Austin'] }
  const q = boardQueries('Austin B2B SaaS companies hiring their first account executive in the last 30 days', icp)
  assert.ok(q.length >= 1 && q.every(x => /site:/.test(x)), JSON.stringify(q))
  assert.ok(boardQueries('Find Ohio companies with 10 to 100 employees that recently posted a payroll, HR or office manager job', { signals: ['payroll job'], where: ['Ohio'] }).length >= 1)
  assert.deepEqual(boardQueries('SaaS companies in Berlin that raised a funding round', { signals: ['hiring a CTO'], where: ['Berlin'] }), [])
})

test('#381 the data: 8 of the 23 real candidates came from walled / aggregator hosts and every one of them died; none of the 28 pages read was on such a host', () => {
  const walledOrAgg = (u: string) => isLoginWalled(u)
  const cands = REAL.jobs.flatMap(j => j.candidates), bad = cands.filter(c => walledOrAgg(c.url))
  assert.equal(cands.length, 23); assert.equal(bad.length, 8)
  assert.ok(bad.every(c => /blocked_by_site|quote_unconfirmed|outside_window_undated/.test(c.fate)), JSON.stringify(bad.map(c => c.fate)))
  assert.equal(REAL.jobs.flatMap(j => j.urls).filter(u => u.selected && walledOrAgg(u.url)).length, 0)
})

import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import type { Hit } from './helpers/acceptance-harness.ts'
// Runner level fixture. REAL: the request and the profile of staging job 4f6581f2 (Toronto dental). SYNTHETIC: titles, snippets, pages and model replies.
const TORONTO = REAL.jobs.find(j => j.job === '4f6581f2')!
const hitsOf = (urls: string[]): Hit[] => urls.map((u, i) => ({ url: u, title: `Result ${i} ${new URL(u).hostname}`, snippet: `Synthetic snippet ${i}: a dental clinic in Toronto Ontario opened a new location this month and is hiring front desk staff ${i}.`, date: daysAgo(10) }))
function fx(urls: string[]): Fixture {
  return { request: TORONTO.query, modelIcp: { ...TORONTO.icp, summary: TORONTO.query, who: ['Owner'], sizes: [], exclude: [], language: 'en', window_days: 90 }, modelQueries: [...TORONTO.queries.slice(1), 'Toronto dentist office announces new location'], hits: [], hitsFor: n => hitsOf(urls.slice(n * 7, n * 7 + 7)), tfPages: {}, own: {}, extraction: [], extractionFn: () => [] }
}
test('#381 hosts: walled by name in any country domain (glassdoor.ca, jobleads.com were missed), never by substring', () => {
  for (const u of ['https://www.glassdoor.ca/Job/x', 'https://www.jobleads.com/ca/job/x', 'https://ca.indeed.com/q-x', 'https://uk.linkedin.com/jobs/view/1', 'https://www.instagram.com/p/1', 'https://m.facebook.com/x', 'https://x.com/a/status/1', 'https://www.tiktok.com/@a']) assert.equal(isLoginWalled(u), true, u)
  for (const u of ['https://smilecitydental.ca/', 'https://wallindeed.com/', 'https://www.toronto.ca/x', 'https://job-boards.greenhouse.io/a/jobs/1', 'https://rex.com/', 'https://linkedinsight.example/']) assert.equal(isLoginWalled(u), false, u)
})

// Grounding of snippet candidates. REAL: the request and profile of staging job 4f6581f2 (Toronto dental), whose real candidates died quote_unconfirmed /
// excerpt_not_on_page when their quote came from a search snippet (REAL fates in the fixture). SYNTHETIC: the page, the snippet, and both model replies (the model
// is a stub; what it proves is the pipeline: the grounded quote is the page's own text, so the strict verifier now passes it).
const CLINIC = 'https://www.example-dental-toronto.ca/news/second-location'
const PAGE_QUOTE = 'Example Dental Toronto announced the opening of its second clinic on Queen Street in Toronto, Ontario this month'
const PAGE = { title: 'Example Dental Toronto opens a second clinic', text: `Example Dental Toronto news, published ${daysAgo(12)}. ${PAGE_QUOTE} (${daysAgo(12)}). The new Toronto clinic welcomes patients from the first of the month.`, published: daysAgo(12), structured: [daysAgo(12)] }
const SNIPPET_QUOTE = 'Example Dental Toronto is opening a second clinic downtown Toronto ...'   // what a search snippet showed: NOT on the page
function groundFx(): Fixture {
  const f = fx([CLINIC])
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
