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
    'https://blog.example/cobble-hill-opening': page('Cobble Hill Dental opening', `Published ${daysAgo(200)}. ${Q_OLD}.`),
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
  assert.equal(x.icp.window_days, 90); assert.match(x.queryPrompt || x.calls.prompts[0], /90 days/)
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
  console.log('NYC fates', JSON.stringify(rep.candidates.map((c: { company: string; fate: string; own_fetch: string }) => [c.company, c.fate, c.own_fetch])))
  console.log('NYC funnel', JSON.stringify(rep.funnel), 'job', JSON.stringify(x.job))
})
