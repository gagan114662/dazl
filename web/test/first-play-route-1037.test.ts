// #1037 item 1 (Hermes decision 2026-11-13): two staging first plays stopped with unbounded_fallback_hold before any search ran
// (report.news null, search.attempted 0, queries []). Root cause reproduced here: a first play (first5) has ONE lead source, the free
// news search; with it switched off (NEWS_SEARCH_ENABLED=0) or not run, nothing searched and the stop was mislabelled as a held
// fallback. Now: the news stage is always recorded (status + counts), a first play falls back to the existing TinyFish lead search
// HARD-capped per run, and a run where no source could run says so (no_lead_source).
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { firstPlayLeadCaps } from '../lib/people/first-play-cap.ts'

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
})
