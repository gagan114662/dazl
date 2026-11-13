// #1037 item 1 (Hermes decision 2026-11-13): two staging first plays stopped with unbounded_fallback_hold before any search ran
// (report.news null, search.attempted 0, queries []). Root cause reproduced here: a first play (first5) has ONE lead source, the free
// news search; with it switched off (NEWS_SEARCH_ENABLED=0) or not run, nothing searched and the stop was mislabelled as a held
// fallback. Now: the news stage is always recorded (status + counts), a first play falls back to the existing TinyFish lead search
// HARD-capped per run, and a run where no source could run says so (no_lead_source).
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { firstPlayLeadCaps } from '../lib/people/first-play-cap.ts'
import { fallbackStopCode } from '../lib/scan/runner.ts'
import { SourceRunLedger } from '../lib/scan/source-runs.ts'

const FIRST5 = JSON.stringify({ first5: true, paid_fallback: false, credit_enrichment: false })
const NEWS = 'https://sifted.example/brightloop-raises-seed'
const QUOTE = 'Brightloop, a London B2B SaaS startup, raised a 3m GBP seed round this month'
const page = { title: 'Brightloop raises seed round', text: `On ${daysAgo(12)}, ${QUOTE}. ${'More about the company and its people. '.repeat(15)}` }
const ICP = { summary: 's', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
// Job 99a93f32 shape: the news-shaped funding request. Job 2934229e shape: the hiring request.
const FUNDING = 'London B2B SaaS startups that raised seed funding in the last 90 days'
const HIRING = 'B2B SaaS startups hiring their first sales rep (SDR or account executive), job posted in the last 30 days; reach the founder or CEO'
const base = (request: string, over: Partial<Fixture> = {}): Fixture => ({
  request, modelIcp: ICP, modelQueries: ['London SaaS startup seed round', 'SaaS seed funding London', 'B2B SaaS raised seed'],
  hits: [{ url: NEWS, title: page.title, snippet: QUOTE, date: daysAgo(12) }], tfPages: { [NEWS]: page }, own: { [NEWS]: page },
  extraction: [{ company: 'Brightloop', signal: 'raised a seed round', source_url: NEWS, excerpt: QUOTE, event_date: daysAgo(12) }],
  runBudget: FIRST5, ...over,
} as Fixture)
type Rep = { stop?: { code: string } | null; news?: Record<string, unknown> | null; sources?: Record<string, string>; search?: { attempted: number | null } | null }
const rep = (r: Awaited<ReturnType<typeof runFixture>>): Rep => (r.report ?? {}) as Rep
const sourceStatus = (r: Awaited<ReturnType<typeof runFixture>>, name: string) => {
  const rows = r.db.prepare('SELECT collector AS source, status FROM scan_source_runs ORDER BY attempt DESC').all() as { source: string; status: string }[]
  return rows.find(x => x.source === name)?.status ?? null
}
async function withEnv<T>(e: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(e).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(e)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { return await fn() } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

for (const [shape, request] of [['funding (99a93f32)', FUNDING], ['hiring (2934229e)', HIRING]] as const) {
  test(`#1037 first play, ${shape}, free news switched off: the capped TinyFish lead search runs and finds the lead (was unbounded_fallback_hold, nothing searched)`, async () => {
    const r = await withEnv({ NEWS_SEARCH_ENABLED: '0' }, () => runFixture(base(request)))
    assert.notEqual(r.job.error, 'unbounded_fallback_hold')
    assert.ok(r.calls.searches.length >= 1 && r.calls.searches.length <= firstPlayLeadCaps().searches, `capped lead searches: ${r.calls.searches.length}`)
    assert.ok(r.leads.some(l => l.company === 'Brightloop'), `the lead was found: ${JSON.stringify(r.leads.map(l => l.company))} / ${r.job.status} ${r.job.error}`)
    assert.equal(sourceStatus(r, 'search:news'), 'skipped_disabled', 'the report says the news search was switched off')
    assert.deepEqual(rep(r).news, { attempted: 0, failed: 0, limited: 0, malformed: 0, failure_classes: {}, http_statuses: {}, query_classes: {} })
  })
}

test('#1037 first play, news off and no TinyFish: an honest no_lead_source stop (not a held fallback), news recorded as switched off', async () => {
  const r = await withEnv({ NEWS_SEARCH_ENABLED: '0' }, () => runFixture(base(HIRING, { tinyfishOff: true })))
  assert.equal(r.job.status, 'failed'); assert.equal(r.job.error, 'no_lead_source')
  assert.equal(r.calls.searches.length, 0); assert.equal(r.calls.research.length, 0)
  assert.equal(sourceStatus(r, 'search:news'), 'skipped_disabled')
})

test('#1037 first play: the fallback respects the hard cap - DAZL_FIRST_PLAY_LEAD_SEARCHES=1 makes at most one lead search; =0 turns it off', async () => {
  const one = await withEnv({ NEWS_SEARCH_ENABLED: '0', DAZL_FIRST_PLAY_LEAD_SEARCHES: '1' }, () => runFixture(base(FUNDING, { hits: [] })))
  assert.ok(one.calls.searches.length <= 1, String(one.calls.searches.length))
  const off = await withEnv({ NEWS_SEARCH_ENABLED: '0', DAZL_FIRST_PLAY_LEAD_SEARCHES: '0' }, () => runFixture(base(FUNDING)))
  assert.equal(off.calls.searches.length, 0); assert.equal(off.job.error, 'no_lead_source')
})

test('#1037 caps: defaults 3 searches / 6 page reads; settings only lower; garbage is 0', () => {
  assert.deepEqual(firstPlayLeadCaps({}), { searches: 3, fetches: 6 })
  assert.deepEqual(firstPlayLeadCaps({ DAZL_FIRST_PLAY_LEAD_SEARCHES: '2', DAZL_FIRST_PLAY_LEAD_FETCHES: '50' }), { searches: 2, fetches: 6 })
  assert.deepEqual(firstPlayLeadCaps({ DAZL_FIRST_PLAY_LEAD_SEARCHES: 'x', DAZL_FIRST_PLAY_LEAD_FETCHES: '-1' }), { searches: 0, fetches: 0 })
})

test('#1037 an ordinary (own-key, non-first5) scan is unchanged: TinyFish first, at the ordinary count', async () => {
  const r = await withEnv({ NEWS_SEARCH_ENABLED: '0' }, () => runFixture(base(FUNDING, { runBudget: undefined })))
  assert.ok(r.calls.searches.length >= 1)
  assert.ok(r.leads.some(l => l.company === 'Brightloop'))
  assert.equal(sourceStatus(r, 'search:tinyfish'), 'ok', 'the ordinary TinyFish stage served it')
  assert.equal(sourceStatus(r, 'search:news'), null, 'leads already found: the news stage is not recorded as skipped')
})

test('#1037 first play: the page-read cap holds - DAZL_FIRST_PLAY_LEAD_FETCHES=2 reads at most 2 pages however many hits come back', async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ url: `https://news${i}.example/story`, title: `Story ${i}`, snippet: QUOTE, date: daysAgo(12) }))
  const r = await withEnv({ NEWS_SEARCH_ENABLED: '0', DAZL_FIRST_PLAY_LEAD_FETCHES: '2' }, () => runFixture(base(FUNDING, { hits: many, tfPages: Object.fromEntries(many.map(h => [h.url, page])) })))
  const fetched = r.calls.tfFetchBatches.flat()
  assert.ok(fetched.length >= 1 && fetched.length <= 2, `page reads: ${fetched.length}`)
})

// Council R1/R2: a news stage recorded as skipped_* never ran, so it must not block a clean TinyFish result from concluding.
test('#1037 stop code: news skipped + TinyFish searched clean and found nothing -> no_discovery, for a first play and an ordinary scan alike', () => {
  const at = (news: string | null, tf: string | null, first5: boolean) => { const l = new SourceRunLedger(); if (news) l.record('search:news', news); if (tf) l.record('search:tinyfish', tf); return fallbackStopCode(l, first5) }
  for (const first5 of [true, false]) {
    assert.equal(at('skipped_disabled', 'empty', first5), 'no_discovery')
    assert.equal(at(null, 'empty', first5), 'no_discovery')
    assert.equal(at('skipped_disabled', 'error', first5), 'source_error')
  }
  assert.equal(at('skipped_disabled', null, true), 'no_lead_source')
  assert.equal(at('skipped_disabled', 'skipped_hold', true), 'no_lead_source')
  assert.equal(at('skipped_disabled', null, false), 'unbounded_fallback_hold', 'an ordinary scan keeps its classification')
  assert.equal(at('empty', null, true), 'no_discovery')
})

// Council round 1: the hiring shape with its own profile and job-page evidence, the stop code when the fallback searches and finds
// nothing, and the free-trial path.
const JOB = 'https://boards.greenhouse.io/brightloop/jobs/123'
const JOB_QUOTE = 'Brightloop is hiring its first Sales Development Representative (SDR) to build pipeline'
const HIRING_ICP = { ...ICP, signals: ['hiring first sales rep'], where: ['London, UK', 'Manchester, UK', 'Remote'], window_days: 30 }
const hiringShape = (over: Partial<Fixture> = {}) => base(HIRING, {
  modelIcp: HIRING_ICP, modelQueries: ['SaaS startup hiring first SDR', 'founding account executive SaaS', 'first sales hire B2B SaaS'],
  hits: [{ url: JOB, title: 'SDR - Brightloop', snippet: JOB_QUOTE, date: daysAgo(5) }],
  tfPages: { [JOB]: { title: 'SDR - Brightloop', text: `Posted ${daysAgo(5)}. ${JOB_QUOTE}. ${'About the role and the team. '.repeat(15)}` } },
  own: { [JOB]: { title: 'SDR - Brightloop', text: `Posted ${daysAgo(5)}. ${JOB_QUOTE}. ${'About the role and the team. '.repeat(15)}` } },
  extraction: [{ company: 'Brightloop', signal: 'hiring a first SDR', source_url: JOB, excerpt: JOB_QUOTE, event_date: daysAgo(5) }], ...over,
})

test('#1037 hiring shape (2934229e, hiring profile, three places): the capped plan keeps a model-planned query - board site: queries never take every capped search', async () => {
  const r = await withEnv({ NEWS_SEARCH_ENABLED: '0' }, () => runFixture(hiringShape()))
  assert.ok(r.calls.searches.length >= 1 && r.calls.searches.length <= 3, `capped: ${r.calls.searches.length}`)
  assert.ok(r.calls.searches.filter(q => !/site:/.test(q)).length >= 2, `at least 2 model-planned (non site:) queries sent that is not a board site: query was sent: ${JSON.stringify(r.calls.searches)}`)
  assert.notEqual(r.job.error, 'unbounded_fallback_hold')
})

test('#1037 first play: the capped fallback searched and found nothing -> no_discovery (searched, nothing found), never a held fallback', async () => {
  const none = await withEnv({ NEWS_SEARCH_ENABLED: '0' }, () => runFixture(base(FUNDING, { hits: [] })))
  assert.ok(none.calls.searches.length >= 1); assert.equal(none.job.error, 'no_discovery', String(none.job.error))
  const empty = await withEnv({ NEWS_SEARCH_ENABLED: '0' }, () => runFixture(base(FUNDING, { extraction: [] })))
  assert.ok(empty.calls.searches.length >= 1); assert.equal(empty.job.error, 'no_discovery', String(empty.job.error))
  // Council round 2: hits that could not be read (an unusable extraction reply) are NOT 'nothing there'.
  const unread = await withEnv({ NEWS_SEARCH_ENABLED: '0' }, () => runFixture(base(FUNDING, { extractionFn: () => null as never })))
  assert.ok(unread.calls.searches.length >= 1); assert.notEqual(unread.job.error, 'no_discovery', 'an unreadable extraction never concludes')
  assert.equal(sourceStatus(unread, 'search:tinyfish'), 'unavailable')
  assert.equal(sourceStatus(none, 'search:tinyfish'), 'empty', 'every capped search answered with zero hits')
})

test('#1037 ordinary scan, paid_fallback=false, news off, TinyFish searched clean and extracted nothing: still no_discovery (classification kept)', async () => {
  const r = await withEnv({ NEWS_SEARCH_ENABLED: '0' }, () => runFixture(base(FUNDING, { runBudget: JSON.stringify({ paid_fallback: false }), extraction: [] })))
  assert.equal(r.job.error, 'no_discovery', String(r.job.error))
})

const TRIAL_ENV = { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-test-fixture', DAZL_TRIAL_SCAN_RESERVE_USD: '1', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '5', DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_ENABLED: '1', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.01', DAZL_TRIAL_TINYFISH_FETCH_USD: '0', DAZL_FIRST_PLAY_PEOPLE_SEARCHES: '0', NEWS_SEARCH_ENABLED: '0' }
test('#1037 FREE TRIAL first play: the capped fallback is paid from the trial reserve and stays inside it; a reserve too small for one search sends none', async () => {
  const reserved = (r: Awaited<ReturnType<typeof runFixture>>) => (r.db.prepare('SELECT spend_reserved_usd AS s FROM scan_jobs').get() as { s: number | null }).s ?? 0
  const t = await withEnv(TRIAL_ENV, () => runFixture(base(FUNDING, { fundedBy: 'trial', model: 'claude-sonnet-4-5' })))
  assert.ok(t.calls.searches.length >= 1 && t.calls.searches.length <= 3, String(t.calls.searches.length))
  assert.ok(reserved(t) >= 0.01 * t.calls.searches.length - 1e-9 && reserved(t) <= 1, `each search reserved from the trial reserve: ${reserved(t)}`)
  const poor = await withEnv({ ...TRIAL_ENV, DAZL_TRIAL_TINYFISH_SEARCH_USD: '5' }, () => runFixture(base(FUNDING, { fundedBy: 'trial', model: 'claude-sonnet-4-5' })))
  assert.equal(poor.calls.searches.length, 0, 'a search the reserve cannot pay is never sent')
})

test('#1037 first play: news switched on but no runnable news query -> the report still carries news status and zero counts', async () => {
  let newsCalls = 0
  const newsHttp = async () => { newsCalls++; return { ok: true, status: 200, text: '{"articles":[]}' } }
  const r = await runFixture(base(FUNDING, { modelQueries: ['site:sifted.example seed round', 'site:techcrunch.com seed London'], deps: { newsHttp } }))
  assert.equal(newsCalls, 0, 'no news query was runnable')
  assert.equal(sourceStatus(r, 'search:news'), 'unavailable')
  assert.deepEqual(rep(r).news, { attempted: 0, failed: 0, limited: 0, malformed: 0, failure_classes: {}, http_statuses: {}, query_classes: {} })
})

test('#1037 FREE TRIAL first play: the fallback never plans into the last quarter of the trial reserve (kept for the checks after the scan)', async () => {
  // Reserve 1: 75% is 0.75; at 0.3 per search two searches (0.6) fit and a third (0.9) would eat into the kept quarter.
  const t = await withEnv({ ...TRIAL_ENV, DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.3' }, () => runFixture(base(FUNDING, { fundedBy: 'trial', model: 'claude-sonnet-4-5', hits: [] })))
  assert.ok(t.calls.searches.length >= 1 && t.calls.searches.length <= 2, `searches inside the 75% line: ${t.calls.searches.length}`)
})
