// #381 / #685 (prod matrix 02dd2e55, 14 Nov: 9 of 30 saved leads held blocked_by_site; Facebook, LinkedIn-style job boards, a directory, a
// paywalled news site). The one recovery pass that looks for the SAME company and event on another source ran only through the free news
// search, which staging and prod switch off (NEWS_SEARCH_ENABLED=0), so every blocked lead was held with "Recovery pass did not run (news search
// is off)". With news off the pass now asks TinyFish the same targeted query; the pages go through the same extraction and the same verifier.
// Real runJob with stubbed search / fetch / model (npm test sets NEWS_SEARCH_ENABLED=0); invented companies and URLs; no network, no key.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture, type Cand, type Hit } from './helpers/acceptance-harness.ts'

const REQUEST = 'Find restaurants in Vancouver, British Columbia that opened a new location in the last 90 days.'
const ICP = { summary: 'Vancouver restaurants', who: ['Owner'], industries: ['Restaurants'], sizes: [], where: ['Vancouver, British Columbia'], signals: ['opened a new location'], exclude: [], country: 'CA', language: 'en', window_days: 90 }
const filler = ' The menu, the room and the team are all new, and the owners say the neighbourhood has welcomed them.'.repeat(8)
const SOCIAL = 'https://social.example/posts/nova-kitchen-opened'        // the cited page: blocked
const PRESS = 'https://citynews.example/food/nova-kitchen-bar-opens'     // the same event on a readable local news page
const OTHER = 'https://citynews.example/food/harbour-grill-opens'        // a second, readable lead, so the scan is not empty (the adaptive round does not run)
const NOVA = `NOVA Kitchen & Bar opened its new location in Vancouver, British Columbia on ${daysAgo(12)}`
const GRILL = `Harbour Grill opened a new location in Vancouver, British Columbia on ${daysAgo(9)}`
const hit = (url: string, title: string, snippet: string): Hit => ({ url, title, snippet, date: daysAgo(10) })

interface Opt { pressSays?: string; recoveryHits?: Hit[]; paid?: boolean; runBudget?: string; roundOne?: Hit[]; beforeRun?: Fixture['beforeRun']; signals?: string[] }
async function run(o: Opt = {}) {
  const pressText = o.pressSays ?? NOVA
  const f: Fixture = {
    request: REQUEST, modelIcp: o.signals ? { ...ICP, signals: o.signals } : ICP, modelQueries: ['vancouver restaurant opens new location'],
    hits: [],
    // round one finds the blocked social post and the readable second lead; every later search (the recovery pass) finds the news page
    // the recovery search also returns the blocked post again: the pass must not read it twice
    hitsFor: n => n === 0 ? (o.roundOne ?? [hit(SOCIAL, 'NOVA Kitchen & Bar opened', NOVA), hit(OTHER, 'Harbour Grill opens', GRILL)]) : (o.recoveryHits ?? [hit(SOCIAL, 'NOVA Kitchen & Bar opened', NOVA), hit(PRESS, 'NOVA Kitchen & Bar opens in Vancouver', pressText)]),
    tfPages: {
      // the social post is readable to nobody: TinyFish gets no text for it either (the search snippet is all there is)
      [OTHER]: { title: 'Harbour Grill opens', text: `${GRILL}.${filler}` },
      [PRESS]: { title: 'NOVA Kitchen & Bar opens in Vancouver', text: `${pressText}.${filler}` },
    },
    own: {
      [SOCIAL]: 'blocked',
      [OTHER]: { title: 'Harbour Grill opens', text: `${GRILL}.${filler}` },
      [PRESS]: { title: 'NOVA Kitchen & Bar opens in Vancouver', text: `${pressText}.${filler}` },
    },
    extraction: [],
    // the extraction reply depends on the pages it was given: round one sees the social post and the second lead, the recovery pass the news page
    extractionFn: p => {
      const out: Cand[] = []
      if (p.includes(SOCIAL)) out.push({ company: 'NOVA Kitchen & Bar', signal: 'opened a new location', source_url: SOCIAL, excerpt: NOVA, event_date: daysAgo(12) })
      if (p.includes(OTHER)) out.push({ company: 'Harbour Grill', signal: 'opened a new location', source_url: OTHER, excerpt: GRILL, event_date: daysAgo(9) })
      if (p.includes(PRESS)) out.push({ company: o.pressSays && !o.pressSays.includes('NOVA') ? 'Zenith Diner' : 'NOVA Kitchen & Bar', signal: 'opened a new location', source_url: PRESS, excerpt: pressText, event_date: daysAgo(12) })
      return out
    },
    deps: { ...(o.paid === false ? { paidFallback: false } : {}) },
    ...(o.runBudget ? { runBudget: o.runBudget } : {}),
    ...(o.beforeRun ? { beforeRun: o.beforeRun } : {}),
  }
  const x = await runFixture(f)
  const nova = x.db.prepare("SELECT id, review_reason, source_url, event_date FROM leads WHERE company = 'NOVA Kitchen & Bar'").get() as { id: string; review_reason: string | null; source_url: string; event_date: string | null } | undefined
  const notes = nova ? (x.db.prepare("SELECT connector, value FROM lead_enrichments WHERE lead_id = ? AND connector IN ('scan:fallback', 'scan:recovery')").all(nova.id) as { connector: string; value: string }[]) : []
  return { x, nova, notes }
}

test('news off: a lead whose own page is blocked is recovered from the same event on a readable page found by TinyFish', async () => {
  const { x, nova, notes } = await run()
  assert.ok(nova, 'the lead exists')
  assert.equal(nova!.review_reason, null, `verified, not held: ${JSON.stringify(nova)}`)
  assert.equal(nova!.source_url, PRESS, 'it now cites the readable page')
  assert.ok(notes.some(n => n.connector === 'scan:fallback' && /Own site blocked \(blocked_by_site\): verified from other sources instead \(citynews\.example\)/.test(n.value)), JSON.stringify(notes))
  // the recovery query is the targeted one ("<company>" <signal> <place>), and the blocked page is not fetched again by TinyFish
  assert.ok(x.calls.searches.some(q => q.includes('"NOVA Kitchen & Bar"')), JSON.stringify(x.calls.searches))
  assert.ok(!x.calls.tfFetchBatches.slice(1).flat().includes(SOCIAL), 'the blocked page is skipped, though the recovery search returned it')
  assert.equal((x.db.prepare("SELECT count(*) AS n FROM leads WHERE company = 'Harbour Grill' AND review_reason IS NULL").get() as { n: number }).n, 1, 'the other lead is untouched')
})

test('the replacement must verify for the SAME company: another company on the page, or nothing found, leaves the lead held and says the pass ran', async () => {
  const other = await run({ pressSays: `Zenith Diner opened a new location in Vancouver, British Columbia on ${daysAgo(12)}` })
  assert.equal(other.nova?.review_reason, 'blocked_by_site')
  assert.ok(!other.x.calls.ownFetch.includes(PRESS), 'a candidate for another company is not verified at all (no page read is spent on it)')
  assert.ok(other.notes.some(n => n.connector === 'scan:recovery' && /^Recovery pass ran before this was held \(blocked_by_site\)/.test(n.value)), JSON.stringify(other.notes))
  const none = await run({ recoveryHits: [] })
  assert.equal(none.nova?.review_reason, 'blocked_by_site')
  assert.ok(none.notes.some(n => n.connector === 'scan:recovery' && /^Recovery pass ran before this was held/.test(n.value)))
})

test('never on a run with paid steps off (a free trial): the lead stays held and says why the pass did not run', async () => {
  const { x, nova, notes } = await run({ paid: false })
  assert.equal(nova?.review_reason, 'blocked_by_site')
  assert.ok(!x.calls.searches.some(q => q.includes('"NOVA Kitchen & Bar"')), 'no recovery search')
  assert.ok(notes.some(n => n.connector === 'scan:recovery' && /^Recovery pass did not run/.test(n.value)), JSON.stringify(notes))
})

async function withEnv<T>(e: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const had = Object.fromEntries(Object.keys(e).map(k => [k, process.env[k]]))
  Object.assign(process.env, e)
  try { return await fn() } finally { for (const [k, v] of Object.entries(had)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const recoverySearches = (x: Awaited<ReturnType<typeof run>>['x']) => x.calls.searches.filter(q => q.includes('"NOVA Kitchen & Bar"'))

test('never on a scheduled play run (a monitor\'s run): no recovery search, and the lead says why', async () => {
  // the job is a monitor's run, recorded the way lib/monitors.ts queues one (its monitor_runs row exists before the scan runs)
  const { migrateMonitors } = await import('../lib/monitors.ts')
  const { x, nova, notes } = await run({ beforeRun: db => {
    migrateMonitors(db)
    const job = (db.prepare('SELECT id, user_id FROM scan_jobs').get() as { id: string; user_id: string })
    db.prepare("INSERT INTO monitors (id, user_id, query, interval_hours) VALUES ('m1', ?, 'vancouver restaurants opening', 168)").run(job.user_id)
    db.prepare("INSERT INTO monitor_runs (id, monitor_id, job_id, ran_at, missed_runs) VALUES ('r1', 'm1', ?, 1, 0)").run(job.id)
  } })
  assert.equal(nova?.review_reason, 'blocked_by_site')
  assert.deepEqual(recoverySearches(x), [])
  assert.ok(notes.some(n => /^Recovery pass did not run \(a scheduled play run keeps the caps it was confirmed with\)/.test(n.value)), JSON.stringify(notes))
})

test('a recovery search the scan budget cannot fit is never sent, and the lead says the pass did not run - not "searched, nothing there"', async () => {
  // a search priced at USD 3.20 against the scan cap of USD 3.33: round one's search fits, the recovery search does not
  const { x, nova, notes } = await withEnv({ DAZL_SCAN_PRICE_TINYFISH_SEARCH_USD: '3.2' }, () => run())
  assert.equal(nova?.review_reason, 'blocked_by_site')
  assert.deepEqual(recoverySearches(x), [], 'nothing was sent')
  assert.ok(notes.some(n => /^Recovery pass did not run \(the scan's budget did not fit the search\)/.test(n.value)), JSON.stringify(notes))
  assert.ok(!notes.some(n => /searched other press/.test(n.value)))
})

test('when the adaptive round runs (round one verified no lead), the recovery pass does not: the price estimate counts one of them', async () => {
  // round one verifies NO lead (only the blocked post) and the profile has a signal round one never asked about: the adaptive round runs
  const { x, nova } = await run({ roundOne: [hit(SOCIAL, 'NOVA Kitchen & Bar opened', NOVA)], signals: ['opened a new location', 'expanded seating with a heated patio terrace'], recoveryHits: [] })
  const { ADAPTIVE_SEARCHES } = await import('../lib/scan/run-budget.ts')
  const adaptive = x.db.prepare("SELECT status FROM scan_source_runs WHERE collector = 'search:adaptive'").get() as { status: string } | undefined
  assert.ok(adaptive && x.calls.searches.length > 1, `the adaptive round searched: ${JSON.stringify([adaptive, x.calls.searches])}`)
  assert.deepEqual(recoverySearches(x), [], 'no recovery search on top of it')
  assert.ok(x.calls.searches.length - 1 <= ADAPTIVE_SEARCHES, JSON.stringify(x.calls.searches))
  assert.ok(nova, 'the held lead is still reported')
})
