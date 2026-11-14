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
import { GROUND_MAX_OUT, groundingFits, groundLeads, groundPrompt, mergeGrounded, parseLeads, quoteOnPage, sameCompanyName, ScanStopped, ScanTimedOut, snippetCandidates } from '../lib/scan/runner.ts'
import { callCostUsd, SpendAccountingFailed, SpendGuard } from '../lib/llm/spend-guard.ts'
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
  // (review) the fixture HAS a readable page for the Instagram URL whose text does not carry the quote: only the host rule keeps it out of the grounding pass
  g.own = { [IG]: { title: 'TDot Dental', text: `TDot Dental on Instagram. ${'We posted photos of the team and the new chairs at the clinic this week. '.repeat(6)}` } }
  const y = await runFixture(g)
  assert.ok(!y.calls.prompts.some(p => /^You research sales leads/.test(p)), 'no grounding call for a walled host')
  // the selection itself, on the same shapes: a walled host and a page the extraction step already read are both left out
  const d = (u: string) => ({ name: '', company: 'X', contact: null, signal: 's', source_url: u, excerpt: 'q', event_date: null, score: 50 })
  assert.deepEqual(snippetCandidates([d(IG), d(CLINIC), d('https://read.example/a'), d('https://not-a-hit.example/')], [IG, CLINIC, 'https://read.example/a'], new Set(['https://read.example/a'])).map(l => l.source_url), [CLINIC])
})

test('#381 runner (review): a page with two candidates where the model grounds one: the other stays held, never lost', async () => {
  const OTHER_QUOTE = 'Another Smile Clinic is also opening downtown Toronto next month'
  const f = groundFx()
  f.own = { [CLINIC]: { ...PAGE, text: `${PAGE.text} Another Smile Clinic is also opening downtown in Toronto next month (${daysAgo(12)}).` } }   // B is on the page, its snippet quote is not verbatim
  f.extractionFn = p => /^You research sales leads/.test(p)
    ? [{ company: 'Example Dental Toronto', signal: 'opened a second clinic', source_url: CLINIC, excerpt: PAGE_QUOTE, event_date: daysAgo(12) }]   // grounds A only
    : [{ company: 'Example Dental Toronto', signal: 'opened a second clinic', source_url: CLINIC, excerpt: SNIPPET_QUOTE.replace(' ...', ''), event_date: daysAgo(12) },
       { company: 'Another Smile Clinic', signal: 'opening a clinic', source_url: CLINIC, excerpt: OTHER_QUOTE, event_date: daysAgo(12) }]
  const x = await runFixture(f)
  assert.equal(x.leads.find(l => l.company === 'Example Dental Toronto')?.review_reason, null, 'A grounded and verified')
  assert.ok(x.leads.find(l => l.company === 'Another Smile Clinic'), `B is not lost: ${JSON.stringify(x.leads.map(l => [l.company, l.review_reason]))}`)
})

// (review 2) The room check prices the REAL grounding prompt as the guard reserves it. A free-trial run on a priced model (claude-sonnet-4-5): the calls before the
// grounding block reserve US$0.071741 and the grounding call needs US$0.067071 more, so a US$0.12 reserve reaches the block with too little room. Without the check the
// reservation is refused, the guard stays refused and the run ends 'trial_budget_reached'; with it the call is skipped and the run ends clean with the lead held.
const TRIAL_ENV = { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-test-fixture', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '5', DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_ENABLED: '1', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.001', DAZL_TRIAL_TINYFISH_FETCH_USD: '0', DAZL_FIRST_PLAY_PEOPLE_SEARCHES: '0', NEWS_SEARCH_ENABLED: '0' }
async function withEnv<T>(e: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(e).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(e)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { return await fn() } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const trialRun = (reserveUsd: string) => { const f = groundFx(); f.model = 'claude-sonnet-4-5'; f.fundedBy = 'trial'; return withEnv({ ...TRIAL_ENV, DAZL_TRIAL_SCAN_RESERVE_USD: reserveUsd }, () => runFixture(f)) }
const reservedUsd = (x: Awaited<ReturnType<typeof runFixture>>) => (x.db.prepare('SELECT spend_reserved_usd AS s FROM scan_jobs').get() as { s: number | null }).s ?? 0
test('#381 runner (review 2): a priced trial run that reaches the grounding block with too little room skips the call and ends clean (without the check: trial_budget_reached)', async () => {
  const tight = await trialRun('0.12')
  assert.ok(tight.calls.prompts.some(p => p.startsWith('You turn pre-collected public items')), 'the run reached extraction, so it reached the grounding block')
  assert.ok(!tight.calls.prompts.some(p => /^You research sales leads/.test(p)), 'no grounding call')
  assert.equal(tight.job.error, null, 'the guard was never refused: the run is not a budget stop')
  assert.equal(tight.leads.find(l => l.company === 'Example Dental Toronto')?.review_reason, 'quote_unconfirmed', 'the lead is held as before, never lost')
  assert.ok(Math.abs(reservedUsd(tight) - 0.071741) < 1e-6, `reserved before the block: ${reservedUsd(tight)}`)
  // control: with room the same run makes the call, and the reservation is what groundingFits priced
  const roomy = await trialRun('0.15')
  assert.ok(roomy.calls.prompts.some(p => /^You research sales leads/.test(p)), 'the grounding call ran with room')
  assert.equal(roomy.job.error, null)
  assert.equal(roomy.leads.find(l => l.company === 'Example Dental Toronto')?.review_reason, null)
  const groundPromptSent = roomy.calls.prompts.find(p => /^You research sales leads/.test(p))!
  assert.ok(Math.abs((reservedUsd(roomy) - reservedUsd(tight)) - callCostUsd('claude-sonnet-4-5', Buffer.byteLength(groundPromptSent), GROUND_MAX_OUT)) < 1e-9, 'the room check prices the call exactly as the guard reserves it')
})

test('#381 groundingFits (review 2): the real worst case (8 pages x 3,000 characters, 4,000 tokens out) is US$0.14, more than the old flat US$0.08', () => {
  const pages = Array.from({ length: 8 }, (_, i) => ({ url: `https://example.test/p/${i}`, text: 'x'.repeat(3000) }))
  const prompt = groundPrompt('Law firms in Chicago, Illinois that opened a new office or expanded a practice group in the last 90 days', pages)
  const cost = callCostUsd('claude-sonnet-4-5', Buffer.byteLength(prompt), GROUND_MAX_OUT)
  assert.ok(cost > 0.13 && cost < 0.15, String(cost))
  const guard = (limit: number, reserved: number) => new SpendGuard(limit, reserved)
  assert.equal(groundingFits([guard(0.5, 0.5 - 0.10)], 'claude-sonnet-4-5', prompt, GROUND_MAX_OUT), false, 'US$0.10 of room passed the old flat check and is too little for this prompt')
  assert.equal(groundingFits([guard(0.5, 0.5 - cost - 0.001)], 'claude-sonnet-4-5', prompt, GROUND_MAX_OUT), true)
  assert.equal(groundingFits([guard(0.5, 0), guard(0.2, 0.15)], 'claude-sonnet-4-5', prompt, GROUND_MAX_OUT), false, 'every guard must have room')
  assert.equal(groundingFits([guard(0.5, 0)], 'stub-model-requested', prompt, GROUND_MAX_OUT), false, 'an unpriced model under a guard is never sent')
  assert.equal(groundingFits([], 'stub-model-requested', prompt, GROUND_MAX_OUT), true, 'no dollar guard: nothing to protect')
  const refused = guard(0.5, 0); refused.refused = true
  assert.equal(groundingFits([refused], 'claude-sonnet-4-5', prompt, GROUND_MAX_OUT), false)
})

// (review 3) groundLeads never swallows a paid call whose cost was not recorded, or a stop: those end the scan. Any other failure is "nothing grounded".
test('#381 groundLeads (review 3): SpendAccountingFailed, ScanStopped and ScanTimedOut are rethrown; any other error returns null; a prompt that does not fit is never sent', async () => {
  const cand = [{ name: '', company: 'Example Dental Toronto', contact: null, signal: 's', source_url: CLINIC, excerpt: 'not on the page at all, twenty chars', event_date: null, score: 50 }]
  const fetchPage = async () => ({ text: PAGE.text.repeat(3), title: PAGE.title, retrievedAt: 1 })
  const failing = (e: Error) => ({ research: async () => ({ text: '', citedUrls: [] }), complete: async () => { throw e } }) as unknown as Parameters<typeof groundLeads>[0]
  for (const e of [new SpendAccountingFailed(new Error('ledger down')), new ScanStopped(), new ScanTimedOut()]) await assert.rejects(() => groundLeads(failing(e), 'k', 'q', cand, fetchPage as never), (got: unknown) => got === e, e.message)
  assert.equal(await groundLeads(failing(new Error('http 500')), 'k', 'q', cand, fetchPage as never), null)
  let sent = 0
  const ok = { research: async () => ({ text: '', citedUrls: [] }), complete: async () => { sent++; return '[]' } } as unknown as Parameters<typeof groundLeads>[0]
  assert.equal(await groundLeads(ok, 'k', 'q', cand, fetchPage as never, undefined, () => false), null); assert.equal(sent, 0, 'not sent when it does not fit')
  await groundLeads(ok, 'k', 'q', cand, fetchPage as never, undefined, (prompt, maxOut) => prompt.includes(CLINIC) && maxOut === GROUND_MAX_OUT); assert.equal(sent, 1)
})

// (review 1) REAL, from the reviewer's scans of fc0294b3 (~/work/verify/rv1212/run1-head, run2-head): for usemeteor.ai/jobs/271311805 the model returned "Flynn Companies"
// where the candidate was "Flynn Group of Companies" and both rows stayed (4 candidates from 3); for one Chicago page it returned Armstrong Teasdale twice (10 from 9).
test('#381 runner (review 1): the grounding reply renames the company -> ONE row under the candidate\'s own name; candidates equals the number that went in', async () => {
  const URL_ = 'https://usemeteor.ai/jobs/271311805'
  const QUOTE = 'Flynn Group of Companies is seeking a Roofing Operations Manager where the focus is on commercial roofing. The position is based in our Toronto location.'
  const f = groundFx()
  f.hitsFor = n => n === 0 ? [{ url: URL_, title: 'Roofing Operations Manager', snippet: 'Flynn is hiring a Roofing Operations Manager', date: daysAgo(12) }] : []
  f.own = { [URL_]: { title: 'Roofing Operations Manager', text: `Posted ${daysAgo(12)}. ${QUOTE} Flynn Companies is an equal opportunity employer. ${'Benefits and details of the role follow. '.repeat(5)}`, published: daysAgo(12), structured: [daysAgo(12)] } }
  f.extractionFn = p => /^You research sales leads/.test(p)
    ? [{ company: 'Flynn Companies', signal: 'hiring', source_url: URL_, excerpt: QUOTE, event_date: daysAgo(12) }]
    : [{ company: 'Flynn Group of Companies', signal: 'hiring', source_url: URL_, excerpt: 'Flynn Group of Companies is hiring a Roofing Operations Manager in Toronto', event_date: daysAgo(12) }]
  const x = await runFixture(f)
  assert.ok(x.calls.prompts.some(p => /^You research sales leads/.test(p)), 'the grounding pass ran')
  assert.equal(x.job.candidates, 1, JSON.stringify(x.job))
  assert.deepEqual(x.leads.map(l => l.company), ['Flynn Group of Companies'], 'one row, the candidate\'s own name')
})

test('#381 runner (review 1): the grounding reply returns the same company twice, and a company it was never given -> still one row per candidate', async () => {
  const OTHER_QUOTE = 'Another Smile Clinic is also opening downtown in Toronto next month'
  const f = groundFx()
  f.own = { [CLINIC]: { ...PAGE, text: `${PAGE.text} ${OTHER_QUOTE} (${daysAgo(12)}). Third Tooth Dental is also mentioned on this page as a sponsor of the event.` } }
  f.extractionFn = p => /^You research sales leads/.test(p)
    ? [{ company: 'Example Dental Toronto', signal: 'opened a second clinic', source_url: CLINIC, excerpt: PAGE_QUOTE, event_date: daysAgo(12) },
       { company: 'Example Dental Toronto', signal: 'welcomes patients', source_url: CLINIC, excerpt: 'The new Toronto clinic welcomes patients from the first of the month.', event_date: daysAgo(12) },
       { company: 'Third Tooth Dental', signal: 'sponsor', source_url: CLINIC, excerpt: 'Third Tooth Dental is also mentioned on this page as a sponsor of the event.', event_date: daysAgo(12) }]
    : [{ company: 'Example Dental Toronto', signal: 'opened a second clinic', source_url: CLINIC, excerpt: SNIPPET_QUOTE.replace(' ...', ''), event_date: daysAgo(12) },
       { company: 'Another Smile Clinic', signal: 'opening a clinic', source_url: CLINIC, excerpt: 'Another Smile Clinic is opening a clinic downtown Toronto soon', event_date: daysAgo(12) }]
  const x = await runFixture(f)
  assert.equal(x.job.candidates, 2, JSON.stringify(x.job))
  assert.deepEqual(x.leads.map(l => l.company).sort(), ['Another Smile Clinic', 'Example Dental Toronto'], 'no second Example Dental row, no Third Tooth row')
  assert.equal(x.leads.find(l => l.company === 'Example Dental Toronto')?.review_reason, null, 'the first grounded quote is the one kept')
})

test('#381 mergeGrounded (review 1): one grounded item per candidate, matched on the same page; the candidate keeps its name; nothing new comes in', () => {
  const d = (company: string, url: string, excerpt: string, event_date: string | null = null) => ({ name: '', company, contact: null, signal: `${company} signal`, source_url: url, excerpt, event_date, score: 70 })
  const P = 'https://example.test/a', Q = 'https://example.test/b'
  const flynn = d('Flynn Group of Companies', P, 'old flynn'), roof = d('Roof Royale', Q, 'old roof'), armstrong = d('Armstrong Teasdale', Q, 'old armstrong')
  const got = mergeGrounded([flynn, roof, armstrong], [
    d('Flynn Companies', P, 'new flynn', '2026-09-15'),            // renamed, the page's only candidate
    d('Armstrong Teasdale LLP', Q, 'new armstrong 1'), d('Armstrong Teasdale', Q, 'new armstrong 2'),   // the same company twice on a page with two candidates
    d('Dechert', Q, 'never given'),                                // not a candidate: dropped (the page has two candidates, so no match by page alone)
    d('Roof Royale', 'https://example.test/elsewhere', 'other page'),   // another page: dropped
  ])
  assert.equal(got.size, 2)
  assert.deepEqual(got.get(flynn), { ...flynn, excerpt: 'new flynn', event_date: '2026-09-15' })
  assert.equal(got.get(armstrong)!.excerpt, 'new armstrong 1'); assert.equal(got.get(armstrong)!.company, 'Armstrong Teasdale')
  assert.equal(got.has(roof), false)
  assert.equal(sameCompanyName('Flynn Companies', 'Flynn Group of Companies'), true)
  assert.equal(sameCompanyName('Armstrong Teasdale LLP', 'Armstrong Teasdale'), true)
  assert.equal(sameCompanyName('Roof Royale', 'Armstrong Teasdale'), false)
  assert.equal(sameCompanyName('Group', 'Flynn Group'), false, 'a name of generic words only matches nothing')
})

// (review, not blocking) In the reviewer's Austin scan the Roof Royale quote was already word for word on the page, and the pass replaced it with one that does not
// name the company. A candidate whose quote is on its page is not sent; when no candidate is left, no call is made.
test('#381 runner (review): a snippet candidate whose quote is already on its page is not sent to the grounding pass (no call, quote unchanged)', async () => {
  const f = groundFx()
  f.extractionFn = p => /^You research sales leads/.test(p)
    ? [{ company: 'Example Dental Toronto', signal: 'x', source_url: CLINIC, excerpt: 'The new Toronto clinic welcomes patients from the first of the month.', event_date: daysAgo(12) }]
    : [{ company: 'Example Dental Toronto', signal: 'opened a second clinic', source_url: CLINIC, excerpt: PAGE_QUOTE, event_date: daysAgo(12) }]
  const x = await runFixture(f)
  assert.ok(!x.calls.prompts.some(p => /^You research sales leads/.test(p)), 'no grounding call')
  assert.equal(x.leads.find(l => l.company === 'Example Dental Toronto')?.review_reason, null)
  assert.equal(quoteOnPage('  the NEW Toronto   clinic welcomes patients', PAGE.text), true); assert.equal(quoteOnPage('welcomes patients', PAGE.text), false, 'under 20 characters proves nothing'); assert.equal(quoteOnPage(SNIPPET_QUOTE, PAGE.text), false)
})

import { boardQueries as bq } from '../lib/search/direct-queries.ts'
test('#381 board queries (review): a request in another language lets the profile signals decide; genuine hiring asks that use "opening" survive; a business opening does not count', () => {
  const de = { signals: ['hiring a sales rep'], where: ['Berlin'], language: 'de' }
  assert.ok(bq('Unternehmen in Berlin, die einen Vertriebsmitarbeiter einstellen', de).length >= 1, 'non-English request: signals decide, as before')
  assert.deepEqual(bq('Unternehmen in Berlin, die einen Vertriebsmitarbeiter einstellen', { ...de, language: 'en' }), [], 'an English profile reads the request only')
  for (const r of ['Austin roofing companies with an opening for an estimator', 'Austin companies with job openings for project managers', 'Austin firms opening a position for a receptionist']) assert.ok(bq(r, { signals: [], where: ['Austin'] }).length >= 1, r)
  for (const r of ['Roofing companies opening their second branch in Austin', 'Restaurants in Vancouver that are opening a second location']) assert.deepEqual(bq(r, { signals: ['hiring a manager'], where: ['Austin'] }), [], r)
})

test('#381 hosts (review): a walled name must be the registrable domain, not any label', () => {
  for (const u of ['https://threads.acme.com/x', 'https://indeed.com.evil.example/x', 'https://x.acme.io/y']) assert.equal(isLoginWalled(u), false, u)
  for (const u of ['https://www.glassdoor.co.uk/x', 'https://au.indeed.com/x', 'https://www.linkedin.com/jobs/1']) assert.equal(isLoginWalled(u), true, u)
})

// REAL scans, 2026-11-14 (chicago-law at fc0294b3 and f622b297, 3 searches / 4 page reads): 2 of 9 scans ended `unbounded_fallback_hold` with 0 candidates after a paid
// extraction call. The logged reply of one (4,507 characters, 9 items, complete, closed with "]") did not parse as JSON, so all 9 candidates were thrown away.
// SYNTHETIC below: the shape of such a reply (one item with an unescaped double quote inside its quote, one with a trailing comma), not the logged text.
test('#381 parseLeads: one malformed item in the reply loses that item, not the whole reply (before: null, the scan ended with 0 candidates)', () => {
  const item = (company: string, url: string, excerpt: string) => `{\n  "name": "",\n  "company": "${company}",\n  "contact": null,\n  "signal": "${company} expanded in Chicago",\n  "source_url": "${url}",\n  "excerpt": "${excerpt}",\n  "event_date": "2026-10-13",\n  "score": 90\n}`
  const urls = ['https://a.example/1', 'https://b.example/2', 'https://c.example/3']
  const broken = '```json\n[\n' + [item('Karns & Karns', urls[0], 'Karns & Karns has announced the opening of a new office location in Lincoln Park'), item('Benesch', urls[1], 'Benesch said "we are growing in Chicago" as it added two partners'), item('Milbank', urls[2], 'Milbank launches in Chicago, hiring a practice leader')].join(',\n') + '\n]\n```'
  assert.throws(() => JSON.parse(broken.slice(broken.indexOf('['), broken.lastIndexOf(']') + 1)), 'the reply as a whole is not JSON')
  assert.deepEqual(parseLeads(broken, urls)?.map(l => l.company), ['Karns & Karns', 'Milbank'], 'the two valid items survive; the broken one is not repaired or guessed')
  // unchanged: a valid reply, a reply with no usable item, and no array at all
  const valid = '[' + [item('Karns & Karns', urls[0], 'q one two three'), item('Milbank', urls[2], 'q four five six')].join(',') + ']'
  assert.deepEqual(parseLeads(valid, urls)?.map(l => l.company), ['Karns & Karns', 'Milbank'])
  assert.equal(parseLeads('[not json', urls), null); assert.equal(parseLeads('[{"company": "x" "broken"}]', urls), null); assert.equal(parseLeads('no json here', urls), null)
  // a salvaged item still has to cite an allowed URL, like any other
  assert.deepEqual(parseLeads(broken, [urls[2]])?.map(l => l.company), ['Milbank'])
})
