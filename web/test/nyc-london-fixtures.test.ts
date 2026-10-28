// SYNTHETIC regression fixtures for the failed #204 live searches (NYC dental, London seed SaaS).
// What this is NOT: a replay. The real runs' search responses, fetched pages and model replies were never stored, so none of
// them can be reconstructed; every hit, page, model reply and token count below is INVENTED and stubbed. It runs the REAL
// profile normalisation, query planner, source selection, extraction parsing, verifier, window gate and run report. It shows
// which candidates the code lets through and why the others are stopped; it says nothing about live yield.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'

const NYC = 'Find independent dental practices in New York City that opened a new location or posted a front desk receptionist job in the past 90 days. Exclude chains and software vendors. Provide dated source evidence and a practice manager contact.'
const LONDON = 'Find London UK B2B SaaS startups with 10-50 employees that announced seed funding within the past 90 days and are hiring sales staff. Exclude agencies and recruiters. Include founder contacts and dated evidence.'
const pad = (s: string) => `${s} ${'The practice serves families across the borough and welcomes new patients every week. '.repeat(6)}`
const page = (title: string, text: string) => ({ title, text: pad(text) })

// ---------- NYC (all SYNTHETIC) ----------
const nycIcp = { summary: 'Independent dental practices in New York City', who: ['Practice manager'], industries: ['dental'], sizes: [], where: ['New York City'], signals: ['opened a new location', 'posted a front desk receptionist job'], exclude: ['chains', 'software vendors'], country: 'US', language: 'en' }
const Q_OPEN = 'BrightSmile Dental opened its second location on Court Street in Brooklyn this month'
const Q_JOB = 'Midtown Family Dental is hiring a front desk receptionist for its Manhattan office'
const Q_OLD = 'Cobble Hill Dental opened a new location on Smith Street last spring'
const Q_UNDATED = 'Riverside Dental has opened a new office in Queens and is welcoming patients'
const Q_FB = 'Anyone know if the new dental office on 5th Ave is hiring a front desk receptionist'
const Q_WRONG = 'Lakeside Orthodontics opened its new Brooklyn office and is welcoming new patients'
const nyc: Fixture = {
  request: NYC, modelIcp: nycIcp,
  modelQueries: ['independent dental practice opens new location New York City', 'dental office front desk receptionist job New York City'],
  hits: [
    { url: 'https://news.example/brightsmile-opens', title: 'BrightSmile Dental opens in Brooklyn', snippet: Q_OPEN, date: daysAgo(20) },
    { url: 'https://jobs.example/midtown-receptionist', title: 'Front desk receptionist - Midtown Family Dental', snippet: Q_JOB, date: daysAgo(10) },
    { url: 'https://www.facebook.com/groups/nycdental/posts/1', title: 'NYC dental group', snippet: Q_FB, date: null },
    { url: 'https://blog.example/cobble-hill-opening', title: 'Cobble Hill Dental opening', snippet: Q_OLD, date: daysAgo(200) },
    { url: 'https://dental.example/riverside-new-office', title: 'Riverside Dental new office', snippet: Q_UNDATED, date: null },
    { url: 'https://news.example/lakeside-opens', title: 'Lakeside Orthodontics opens', snippet: Q_WRONG, date: daysAgo(15) },
  ],
  tfPages: {
    'https://news.example/brightsmile-opens': page('BrightSmile Dental opens in Brooklyn', `Published ${daysAgo(20)}. ${Q_OPEN}.`),
    'https://jobs.example/midtown-receptionist': page('Front desk receptionist - Midtown Family Dental', `Posted ${daysAgo(10)}. ${Q_JOB}.`),
    'https://blog.example/cobble-hill-opening': page('Cobble Hill Dental opening', `Published ${daysAgo(200)}. ${Q_OLD}. Visit us in Brooklyn, NY.`),
    'https://dental.example/riverside-new-office': page('Riverside Dental new office', Q_UNDATED + '.'),
    'https://news.example/lakeside-opens': page('Lakeside Orthodontics opens', `Published ${daysAgo(15)}. ${Q_WRONG}.`),
  },
  own: {},
  extraction: [],
}
nyc.own = Object.fromEntries(Object.entries(nyc.tfPages).map(([u, p]) => [u, p])) // readable by the verifier too
nyc.own['https://www.facebook.com/groups/nycdental/posts/1'] = 'blocked'
const cOpen: Cand = { company: 'BrightSmile Dental', signal: 'Opened a second location', source_url: 'https://news.example/brightsmile-opens', excerpt: Q_OPEN, event_date: daysAgo(20) }
const cJob: Cand = { company: 'Midtown Family Dental', signal: 'Hiring a front desk receptionist', source_url: 'https://jobs.example/midtown-receptionist', excerpt: Q_JOB, event_date: daysAgo(10) }
const cOld: Cand = { company: 'Cobble Hill Dental', signal: 'Opened a location', source_url: 'https://blog.example/cobble-hill-opening', excerpt: Q_OLD, event_date: daysAgo(200) }
const cUndated: Cand = { company: 'Riverside Dental', signal: 'New office', source_url: 'https://dental.example/riverside-new-office', excerpt: Q_UNDATED, event_date: null }
const cFb: Cand = { company: 'Fifth Avenue Dental', signal: 'Hiring front desk', source_url: 'https://www.facebook.com/groups/nycdental/posts/1', excerpt: Q_FB, event_date: null }
const cWrong: Cand = { company: 'Harbor Dental', signal: 'Opened a location', source_url: 'https://news.example/lakeside-opens', excerpt: Q_WRONG, event_date: daysAgo(15) }
const fate = (x: Awaited<ReturnType<typeof runFixture>>, company: string) => x.report!.candidates.find((c: { company: string }) => c.company === company)?.fate as string | undefined

test('NYC planner: the exact request yields role queries for the real role, no instruction fragments, and the 90-day window', async () => {
  const x = await runFixture({ ...nyc, extraction: [cOpen, cJob] })
  const direct = x.calls.searches.filter(q => /site:/.test(q))
  assert.ok(direct.length >= 1 && direct.every(q => /"front desk receptionist"/.test(q)), direct.join('\n'))
  for (const q of x.calls.searches) assert.doesNotMatch(q, /dated source evidence|practice manager contact|"location"|\bexclude\b/i, `instruction fragment in query: ${q}`)
  assert.ok(x.calls.afters.length > 0 && x.calls.afters.every(a => a === daysAgo(90)), `every search is limited to the 90-day cutoff: ${x.calls.afters}`)
  assert.match(x.calls.prompts[0], /90 days/, 'the query-writing prompt carries the user window')
})

test('NYC stage report: readable dated pages are selected, fetched and reach extraction; undated/walled/stale/wrong-company are stopped with a reason at each stage', async () => {
  const x = await runFixture({ ...nyc, extraction: [cOpen, cJob, cOld, cUndated, cFb, cWrong] })
  const rep = x.report!
  // stage 1 - search + selection (report.urls)
  assert.equal(rep.search.hits_unique_urls, 6); assert.equal(rep.urls.length, 6)
  const u = (url: string) => rep.urls.find((r: { url: string }) => r.url === url)
  for (const url of ['https://news.example/brightsmile-opens', 'https://jobs.example/midtown-receptionist']) { assert.equal(u(url).selected, true, url); assert.ok(u(url).tinyfish_text_chars > 200, url); assert.ok(u(url).hit_date, url) }
  assert.equal(u('https://www.facebook.com/groups/nycdental/posts/1').walled, true); assert.equal(u('https://www.facebook.com/groups/nycdental/posts/1').tinyfish_text_chars, null)
  assert.deepEqual(x.calls.tfFetchBatches.flat().indexOf('https://www.facebook.com/groups/nycdental/posts/1') > x.calls.tfFetchBatches.flat().indexOf('https://news.example/lakeside-opens'), true, 'walled page is fetched after every readable one')
  // stage 2 - what extraction saw: readable dated text, not just snippets
  assert.match(x.extractionPrompt, /BrightSmile Dental opened its second location/); assert.ok(x.extractionPrompt.includes(daysAgo(20)))
  assert.equal(rep.evidence.with_page_text, 5); assert.equal(rep.evidence.snippet_only, 1)
  assert.equal(rep.extracted_candidates, 6)
  // stage 3 - verification fate per candidate
  assert.equal(fate(x, 'BrightSmile Dental'), 'verified'); assert.equal(fate(x, 'Midtown Family Dental'), 'verified')
  assert.equal(fate(x, 'Cobble Hill Dental'), 'review:outside_window', 'readable and dated, but 200 days old: outside the 90-day window')
  assert.equal(fate(x, 'Riverside Dental'), 'review:outside_window_undated', 'readable but no date anywhere: cannot be placed in the window')
  assert.equal(fate(x, 'Fifth Avenue Dental'), 'review:blocked_by_site', 'walled, undated, no readable text: stays in review under the real failure')
  assert.equal(fate(x, 'Harbor Dental'), 'dropped:entity_mismatch', 'the quote is about another company')
  // the same stages as counts
  assert.deepEqual(x.report!.funnel, { candidates: 6, verified: 2, needs_review: 3, dropped: 1, review_reasons: { outside_window: 1, outside_window_undated: 1, blocked_by_site: 1 }, drop_reasons: { entity_mismatch: 1 }, verifier_drop_counts: { entity_mismatch: 1 } })
  assert.deepEqual([x.job.candidates, x.job.verified, x.job.needs_review, x.job.dropped], [6, 2, 3, 1])
  // only the two verified rows are qualified; nothing else has a null review_reason
  assert.deepEqual(x.leads.filter(l => !l.review_reason).map(l => l.company).sort(), ['BrightSmile Dental', 'Midtown Family Dental'])
  // the per-URL own-fetch outcome is recorded next to the candidate
  assert.equal(x.report!.candidates.find((c: { company: string }) => c.company === 'Fifth Avenue Dental').own_fetch, 'blocked')
  assert.equal(x.report!.candidates.find((c: { company: string }) => c.company === 'BrightSmile Dental').own_fetch, 'ok')
})

test('NYC: EITHER signal alone qualifies (a new location without a job post, a receptionist job without a new location)', async () => {
  const a = await runFixture({ ...nyc, extraction: [cOpen] }); assert.deepEqual(a.leads.filter(l => !l.review_reason).map(l => l.company), ['BrightSmile Dental'])
  const b = await runFixture({ ...nyc, extraction: [cJob] }); assert.deepEqual(b.leads.filter(l => !l.review_reason).map(l => l.company), ['Midtown Family Dental'])
})

test('NYC rejection variants never qualify: the same evidence with a missing quote, a company named only elsewhere, and a stale date', async () => {
  const noQuote = await runFixture({ ...nyc, extraction: [{ ...cOpen, excerpt: 'BrightSmile Dental announced a brand new flagship clinic with twelve operatories' }] })
  assert.equal(fate(noQuote, 'BrightSmile Dental'), 'review:quote_unconfirmed'); assert.equal(noQuote.leads.filter(l => !l.review_reason).length, 0)
  const stale = await runFixture({ ...nyc, extraction: [{ ...cOpen, event_date: daysAgo(500) }] })
  assert.match(fate(stale, 'BrightSmile Dental')!, /^review:event_date_stale$/); assert.equal(stale.leads.filter(l => !l.review_reason).length, 0)
})

test('control: the model finds no candidates -> a failed scan with reason no_candidates; the report still shows every earlier stage', async () => {
  const x = await runFixture({ ...nyc, extraction: [] })
  assert.equal(x.job.status, 'failed'); assert.equal(x.job.error, 'no_candidates'); assert.equal(x.leads.length, 0)
  const rep = x.report!; assert.equal(rep.extracted_candidates, 0); assert.equal(rep.funnel.candidates, 0); assert.equal(rep.search.hits_unique_urls, 6); assert.ok(rep.urls.length === 6 && rep.queries.length >= 3)
})
test('control: the search returns nothing at all -> nothing to extract; queries are still recorded and the funnel is empty', async () => {
  const x = await runFixture({ ...nyc, hits: [], extraction: [cOpen] })
  assert.equal(x.leads.length, 0); assert.ok(x.report, 'a report is written for a failed scan'); assert.ok(x.report!.queries.length >= 3); assert.equal(x.report!.search.hits_unique_urls, 0); assert.equal(x.report!.funnel.verified, null, 'verification never ran: unobserved, not zero')
})

// ---------- London (all SYNTHETIC) ----------
// The "model" reply for the profile deliberately WIDENS the stage ("seed or Series A"): the real guard must bring it back to seed.
const lonIcp = { summary: 'London B2B SaaS startups that raised seed or Series A funding and are hiring sales', who: ['Founder', 'CEO'], industries: ['B2B SaaS'], sizes: ['10-50 employees'], where: ['London', 'UK'], signals: ['announced seed or Series A funding', 'hiring sales staff'], exclude: ['agencies', 'recruiters'], country: 'UK', language: 'en' }
const L_SEED = 'Nimbus Analytics, a London B2B SaaS startup, announced a 2m pound seed round led by Atlas Ventures'
const L_SALES = 'Nimbus Analytics is hiring an Account Executive to build its UK sales team in London'
const L_SERIESA = 'Orbit Software, a London SaaS startup, announced a 12m dollar Series A round'
const L_OLD = 'Pine Metrics, a London SaaS startup, announced a seed round of 1.5m pounds'
const L_UNDATED = 'Quill Systems, a London SaaS startup, announced its seed funding led by Northstar'
const L_LI = 'Congrats to the Vector Labs team in London on closing their seed round'
const L_WRONG = 'Quartz Systems, a London SaaS startup, announced its seed round of 3m pounds'
const london: Fixture = {
  request: LONDON, modelIcp: lonIcp,
  modelQueries: ['London B2B SaaS startup announces seed round', 'London SaaS startup hiring account executive sales'],
  hits: [
    { url: 'https://news.example/nimbus-seed', title: 'Nimbus Analytics raises seed', snippet: L_SEED, date: daysAgo(30) },
    { url: 'https://careers.example/nimbus-sales', title: 'Account Executive - Nimbus Analytics', snippet: L_SALES, date: daysAgo(12) },
    { url: 'https://news.example/orbit-seriesa', title: 'Orbit Software raises Series A', snippet: L_SERIESA, date: daysAgo(25) },
    { url: 'https://news.example/pine-seed', title: 'Pine Metrics seed', snippet: L_OLD, date: daysAgo(300) },
    { url: 'https://blog.example/quill-seed', title: 'Quill Systems seed', snippet: L_UNDATED, date: null },
    { url: 'https://www.linkedin.com/posts/vector-labs-seed', title: 'Vector Labs on LinkedIn', snippet: L_LI, date: null },
    { url: 'https://news.example/quartz-seed', title: 'Quartz Systems raises seed', snippet: L_WRONG, date: daysAgo(18) },
  ],
  tfPages: {
    'https://news.example/nimbus-seed': page('Nimbus Analytics raises seed', `Published ${daysAgo(30)}. ${L_SEED}.`),
    'https://careers.example/nimbus-sales': page('Account Executive - Nimbus Analytics', `Posted ${daysAgo(12)}. ${L_SALES}.`),
    'https://news.example/orbit-seriesa': page('Orbit Software raises Series A', `Published ${daysAgo(25)}. ${L_SERIESA}.`),
    'https://news.example/pine-seed': page('Pine Metrics seed', `Published ${daysAgo(300)}. ${L_OLD}.`),
    'https://blog.example/quill-seed': page('Quill Systems seed', `${L_UNDATED}.`),
    'https://news.example/quartz-seed': page('Quartz Systems raises seed', `Published ${daysAgo(18)}. ${L_WRONG}.`),
  },
  own: {}, extraction: [],
}
london.own = Object.fromEntries(Object.entries(london.tfPages)); london.own['https://www.linkedin.com/posts/vector-labs-seed'] = 'blocked'
const lSeed: Cand = { company: 'Nimbus Analytics', signal: 'Raised a seed round', source_url: 'https://news.example/nimbus-seed', excerpt: L_SEED, event_date: daysAgo(30) }
const lSales: Cand = { company: 'Nimbus Analytics', signal: 'Hiring an account executive', source_url: 'https://careers.example/nimbus-sales', excerpt: L_SALES, event_date: daysAgo(12) }
const lA: Cand = { company: 'Orbit Software', signal: 'Raised a Series A', source_url: 'https://news.example/orbit-seriesa', excerpt: L_SERIESA, event_date: daysAgo(25) }
const lOld: Cand = { company: 'Pine Metrics', signal: 'Raised seed', source_url: 'https://news.example/pine-seed', excerpt: L_OLD, event_date: daysAgo(300) }
const lUndated: Cand = { company: 'Quill Systems', signal: 'Raised seed', source_url: 'https://blog.example/quill-seed', excerpt: L_UNDATED, event_date: null }
const lLi: Cand = { company: 'Vector Labs', signal: 'Raised seed', source_url: 'https://www.linkedin.com/posts/vector-labs-seed', excerpt: L_LI, event_date: null }
const lWrong: Cand = { company: 'Vector Labs', signal: 'Raised seed', source_url: 'https://news.example/quartz-seed', excerpt: L_WRONG, event_date: daysAgo(18) }

test('London planner/profile: seed stays seed (a widened "seed or Series A" profile is restored), the UK market is GB, sales hiring is searched, the 90-day window applies', async () => {
  const x = await runFixture({ ...london, extraction: [lSeed, lSales] })
  assert.doesNotMatch(JSON.stringify(x.icp), /series a/i, JSON.stringify(x.icp)); assert.match(JSON.stringify(x.icp.signals), /seed/i); assert.equal(x.icp.country, 'GB')
  assert.ok(x.calls.searches.some(q => /site:/.test(q) && /"sales"/.test(q)), x.calls.searches.join('\n'))
  for (const q of x.calls.searches) assert.doesNotMatch(q, /founder contacts|dated evidence|\bexclude\b|"include"/i, `instruction fragment: ${q}`)
  assert.ok(x.calls.afters.every(a => a === daysAgo(90)))
})

test('London stage report: seed funding plus sales hiring for the same company qualifies once; undated, walled, stale and wrong-company evidence is stopped with a reason', async () => {
  const x = await runFixture({ ...london, extraction: [lSeed, lSales, lOld, lUndated, lLi, lWrong] })
  const rep = x.report!
  assert.equal(rep.urls.length, 7); assert.equal(rep.extracted_candidates, 6)
  assert.equal(fate(x, 'Nimbus Analytics'), 'verified')
  assert.equal(fate(x, 'Pine Metrics'), 'review:outside_window'); assert.equal(fate(x, 'Quill Systems'), 'review:outside_window_undated')
  assert.equal(rep.candidates.filter((c: { company: string }) => c.company === 'Vector Labs').map((c: { fate: string }) => c.fate).sort().join(), 'dropped:entity_mismatch,review:blocked_by_site')
  assert.deepEqual(x.leads.filter(l => !l.review_reason).map(l => l.company), ['Nimbus Analytics'])
  console.log('LONDON fates', JSON.stringify(rep.candidates.map((c: { company: string; fate: string }) => [c.company, c.fate])), 'funnel', JSON.stringify(rep.funnel))
})

// Two requested signals ("seed only" and "also hiring sales"). The sales-hiring half is now checked after the contact crawl (lib/scan/sales-hiring-gate.ts):
// a funding-only candidate is moved to review as no_sales_hiring_evidence unless its quote, another verified candidate for the company, or a dated
// posting on a public job board bound to its domain shows the hiring. STILL A KNOWN GAP: nothing checks a funding STAGE, so a Series A candidate
// that also shows sales hiring (or a Series A quote the model pairs with a hiring one) verifies.
test('sales-hiring half is enforced: a funding-only candidate is stored as no_sales_hiring_evidence, a seed + sales-hiring pair stays verified; the funding-STAGE gap remains', async () => {
  const fundingOnly = await runFixture({ ...london, extraction: [lSeed] })
  assert.equal(fate(fundingOnly, 'Nimbus Analytics'), 'verified', 'the verifier\u2019s own fate is unchanged (quote, company and date check out)')
  assert.equal(fundingOnly.leads.find(l => l.company === 'Nimbus Analytics')!.review_reason, 'no_sales_hiring_evidence', 'but the stored lead is not passed on the funding quote alone')
  const pair = await runFixture({ ...london, extraction: [lSeed, lSales] })
  assert.equal(pair.leads.find(l => l.company === 'Nimbus Analytics')!.review_reason, null, 'the verified sales-hiring candidate for the same company keeps it')
  const seriesA = await runFixture({ ...london, extraction: [lA] })
  assert.equal(fate(seriesA, 'Orbit Software'), 'verified', 'no code checks the funding stage of a quote (still a gap)')
})

test('London control: no candidates -> failed with no_candidates and a full report; seed-only evidence for the wrong company is not a lead for the claimed company', async () => {
  const x = await runFixture({ ...london, extraction: [] })
  assert.equal(x.job.error, 'no_candidates'); assert.equal(x.report!.funnel.candidates, 0); assert.equal(x.report!.search.hits_unique_urls, 7)
  const w = await runFixture({ ...london, extraction: [lWrong] }); assert.equal(fate(w, 'Vector Labs'), 'dropped:entity_mismatch'); assert.equal(w.leads.length, 0)
})

// ---------- instrumentation audit: what the next separately approved live scan records ----------
test('instrumentation: one scan records queries, every result URL with date/selection/text/own-fetch, per-candidate fate, funnel and model usage in the job record', async () => {
  const x = await runFixture({ ...nyc, extraction: [cOpen, cJob, cOld, cUndated, cFb, cWrong] })
  const rep = x.report!
  // queries sent (also in scan_source_stats)
  assert.deepEqual(rep.queries, x.calls.searches); assert.deepEqual((x.stats as { queries: string[] }[])[0].queries, x.calls.searches)
  // selected URLs + fetched-text availability + the verifier's own fetch outcome
  for (const r of rep.urls) assert.ok('selected' in r && 'tinyfish_text_chars' in r && 'own_fetch' in r && 'walled' in r && 'hit_date' in r)
  assert.equal(rep.urls.filter((r: { selected: boolean }) => r.selected).length, 6); assert.equal(rep.urls.filter((r: { tinyfish_text_chars: number | null }) => r.tinyfish_text_chars).length, 5)
  assert.equal(rep.urls.find((r: { url: string }) => /facebook/.test(r.url)).own_fetch, 'blocked')
  // verification outcomes, per candidate and per reason (above) and model usage (SYNTHETIC stub counts: 2 calls x 1000 in / 100 out)
  assert.equal(rep.model.requests_recorded, 2); assert.equal(rep.model.input_tokens, 2000); assert.equal(rep.model.output_tokens, 200); assert.equal(rep.model.tokens_complete, true)
  assert.equal(x.usage.recorded, true); assert.equal(x.usage.requests_recorded, 2); assert.equal(x.usage.input_tokens, 2000); assert.equal(x.usage.tokens_complete, true); assert.deepEqual(x.usage.served_models, ['stub-model-served'])
  // tenant scoping and the status route field
  const { runReportFor } = await import('../lib/scan/run-report.ts')
  const jobId = (x.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
  assert.ok(runReportFor(x.db, 'A', jobId)); assert.equal(runReportFor(x.db, 'B', jobId), null); assert.equal(runReportFor(x.db, 'A', 'f'.repeat(24)), null)
})
