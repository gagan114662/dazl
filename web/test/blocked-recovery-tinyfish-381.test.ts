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

interface Opt { pressSays?: string; recoveryHits?: Hit[]; paid?: boolean; runBudget?: string }
async function run(o: Opt = {}) {
  const pressText = o.pressSays ?? NOVA
  const f: Fixture = {
    request: REQUEST, modelIcp: ICP, modelQueries: ['vancouver restaurant opens new location'],
    hits: [],
    // round one finds the blocked social post and the readable second lead; every later search (the recovery pass) finds the news page
    hitsFor: n => n === 0 ? [hit(SOCIAL, 'NOVA Kitchen & Bar opened', NOVA), hit(OTHER, 'Harbour Grill opens', GRILL)] : (o.recoveryHits ?? [hit(PRESS, 'NOVA Kitchen & Bar opens in Vancouver', pressText)]),
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
  assert.ok(!x.calls.tfFetchBatches.slice(1).flat().includes(SOCIAL), 'the blocked page is skipped')
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
