// A candidate whose OWN page blocks us (Clera, scan 7) is looked up on sources that do not need the blocked page: other press (same extraction + verifier) and the public ATS boards by company
// name. Stubbed pages, news, boards and model through the real runJob; invented companies. No network, no key, no credits; no gate is relaxed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import { fallbackTargets, mergeFallback, MAX_FALLBACK } from '../lib/scan/blocked-fallback.ts'
import { sourceRuns } from '../lib/scan/source-runs.ts'
import { runReportFor } from '../lib/scan/run-report.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const ms = (n: number) => Date.now() - n * 86_400_000
const REQUEST = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days and are hiring sales staff.'
const ICP = { summary: 'London seed B2B SaaS', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding', 'hiring sales staff'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const filler = ' More about the company, its product and its people.'.repeat(10)
const BLOG = 'https://clera.example/blog/seed-round', PRESS = 'https://sifted.example/clera-raises-seed', JOB = 'https://boards.greenhouse.io/clera/jobs/1'
const FUND = 'Clera, a London B2B SaaS startup, raised a 3m GBP seed round this month'
const HIRE = 'Clera is hiring a Sales Account Executive in London to sell to UK fintechs. Join the sales team'
const seedCand: Cand = { company: 'Clera', signal: 'raised a seed round', source_url: BLOG, excerpt: FUND, event_date: daysAgo(10) }
const pressCand: Cand = { company: 'Clera', signal: 'raised a seed round', source_url: PRESS, excerpt: FUND, event_date: daysAgo(10) }
const jobCand: Cand = { company: 'Clera', signal: 'hiring a sales account executive', source_url: JOB, excerpt: HIRE, event_date: daysAgo(9) }
const gdelt = (urls: string[]) => JSON.stringify({ articles: urls.map(u => ({ url: u, title: 'Clera raises seed round', seendate: '20261016T100000Z' })) })
const board: Record<string, unknown> = {
  'https://boards-api.greenhouse.io/v1/boards/clera/jobs': { jobs: [{ id: 1, title: 'Sales Account Executive', location: { name: 'London, UK' } }] },
  'https://boards-api.greenhouse.io/v1/boards/clera/jobs/1': { id: 1, title: 'Sales Account Executive', first_published: new Date(ms(9)).toISOString(), absolute_url: JOB, location: { name: 'London, UK' }, content: `&lt;p&gt;${HIRE}.&lt;/p&gt;` },
}
interface Opt { press?: boolean; board?: boolean; otherCompany?: boolean; paid?: boolean; place?: string; fundDays?: number }
function scenario(o: Opt) {
  const newsCalls: string[] = []
  const press = o.press !== false
  const newsHttp: SafeGet = async url => { newsCalls.push(url); return { status: 200, body: gdelt(press ? [PRESS] : []) } }
  const sourceHttp: SafeGet = async url => (new URL(url).hostname !== 'hn.algolia.com' && o.board && board[url] !== undefined ? { status: 200, body: JSON.stringify(board[url]) } : { status: 404, body: '' })
  const fundDays = o.fundDays ?? 10
  const pressText = o.otherCompany ? 'Orbitly, a London B2B SaaS startup, raised a 2m GBP seed round this month' : o.place ? FUND.replace('London', o.place) : FUND
  const f: Fixture = { request: REQUEST, modelIcp: ICP, modelQueries: ['london saas startup seed round'], hits: [{ url: BLOG, title: 'Clera raises seed', snippet: FUND, date: daysAgo(10) }], tfPages: {},
    own: { [BLOG]: 'blocked', [PRESS]: { title: 'Clera raises seed round', text: `On ${daysAgo(fundDays)}, ${pressText}.${filler}` }, [JOB]: { title: 'Sales Account Executive at Clera', text: `On ${daysAgo(9)}, ${HIRE}.${filler}` } },
    extraction: [seedCand, o.otherCompany ? { ...pressCand, company: 'Orbitly', excerpt: pressText } : { ...pressCand, excerpt: pressText, event_date: daysAgo(fundDays) }, jobCand], deps: { sourceHttp, newsHttp, ...(o.paid === false ? { paidFallback: false } : {}) } }
  return { f, newsCalls }
}
async function run(o: Opt) {
  const { f, newsCalls } = scenario(o); const x = await runFixture(f)
  const jobId = (x.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
  const lead = x.db.prepare("SELECT id, review_reason, confidence, source_url FROM leads WHERE company = 'Clera'").get() as { id: string; review_reason: string | null; confidence: number | null; source_url: string } | undefined
  const rows = sourceRuns(x.db, 'A', jobId) as { collector: string; status: string }[]
  const fb = lead ? x.db.prepare("SELECT value, source_url FROM lead_enrichments WHERE lead_id = ? AND connector = 'scan:fallback'").get(lead.id) as { value: string; source_url: string } | undefined : undefined
  const res = (runReportFor(x.db, 'A', jobId) as { resolution?: { leads: { company: string; reasons: string[]; fallbacks: string[] }[] } }[]).findLast(r => r.resolution)?.resolution?.leads.find(l => l.company === 'Clera')
  return { x, lead, rows, fb, res, newsCalls }
}
const state = (l?: { review_reason: string | null }) => (!l ? 'none' : l.review_reason === null ? 'verifier-passed' : `held:${l.review_reason}`)

test('BEFORE (nothing elsewhere): Clera\'s own site blocks fetches and no other source has it -> held with the specific reason blocked_by_site', async () => {
  const r = await run({ press: false, board: false })
  assert.equal(state(r.lead), 'held:blocked_by_site', JSON.stringify(r.lead))
  assert.equal(r.rows.find(x => x.collector === 'fallback:news')?.status, 'empty', JSON.stringify(r.rows)); assert.equal(r.fb, undefined)
})
test('AFTER (other press + ATS board by name): the funding quote verifies on other press and the sales posting on its public board -> Clera is VERIFIER-PASSED (not scoreboard-qualified: no contact or fit grade); the record says which fallback was used', async () => {
  const r = await run({ board: true })
  assert.equal(state(r.lead), 'verifier-passed', JSON.stringify([r.lead, r.rows])); assert.notEqual(r.lead!.confidence, null)
  assert.notEqual(r.lead!.source_url, BLOG, 'the surviving lead no longer cites the blocked page')
  assert.match(r.fb!.value, /^Own site blocked \(blocked_by_site\): verified from other sources instead \(/); assert.notEqual(r.fb!.source_url, BLOG)
  assert.ok(r.rows.find(x => x.collector === 'ats:greenhouse')); assert.ok(r.rows.find(x => x.collector === 'corroborate:news' && x.status === 'ok'), JSON.stringify(r.rows))
  assert.ok(r.res!.fallbacks.length === 1 && /other sources/.test(r.res!.fallbacks[0]), JSON.stringify(r.res))
})
test('AFTER, no public board: the date and quote now verify on other press, so the lead is held for a DIFFERENT specific reason - no sales-hiring evidence - not for the blocked page', async () => {
  const r = await run({ board: false })
  assert.equal(state(r.lead), 'held:no_sales_hiring_evidence', JSON.stringify(r.lead)); assert.equal(r.lead!.source_url, PRESS)
  assert.match(r.fb!.value, /verified from other sources instead \(sifted\.example\)/); assert.equal(r.rows.find(x => x.collector === 'fallback:news')?.status, 'ok')
})
test('IDENTITY: other press about a DIFFERENT company never rescues Clera (the held row stays, blocked_by_site) and adds no other company\'s lead', async () => {
  const r = await run({ otherCompany: true, board: false })
  assert.equal(state(r.lead), 'held:blocked_by_site', JSON.stringify(r.lead)); assert.equal(r.fb, undefined)
  assert.equal((r.x.db.prepare("SELECT count(*) AS n FROM leads WHERE company = 'Orbitly'").get() as { n: number }).n, 0)
})
test('a run that disabled the paid fallback makes no fallback search or extraction call', async () => {
  const r = await run({ board: false, paid: false })
  assert.equal(r.rows.find(x => x.collector === 'fallback:news'), undefined); assert.equal(state(r.lead), 'held:blocked_by_site')
})
test('fallbackTargets: only recoverable review rows (blocked, JavaScript-only, quote not on the page), one per company, at most 3; mergeFallback replaces only the blocked company\'s held row and keeps every gate decision', () => {
  const held = (company: string, reason: string) => ({ company, signal: 'raised a seed round', source_url: `https://${company.toLowerCase()}.example/x`, review_reason: reason })
  const t = fallbackTargets([held('Clera', 'blocked_by_site'), held('Clera Ltd', 'blocked_by_site'), held('Omni', 'needs_javascript'), held('Past', 'event_date_stale'), held('Quote', 'quote_unconfirmed'), held('A1', 'blocked_by_site'), held('B2', 'blocked_by_site'), held('C3', 'blocked_by_site')], ['London, UK'])
  assert.equal(MAX_FALLBACK, 3); assert.deepEqual(t.map(x => x.company), ['Clera', 'Omni', 'Quote']); assert.match(t[0].query, /^"Clera" raised a seed round London$/)
  const outcome = { leads: [] as { company: string; source_url: string }[], review: [{ company: 'Clera', source_url: 'https://clera.example/x' }, { company: 'Omni', source_url: 'https://omni.example/x' }], dropped: {} as Record<string, number>, quotes: new Map() }
  const notes = mergeFallback(outcome, { leads: [{ company: 'Clera', source_url: 'https://press.example/clera' }, { company: 'Stranger', source_url: 'https://press.example/s' }], dropped: { stale: 1 } }, t)
  assert.deepEqual(notes.map(n => n.company), ['Clera']); assert.deepEqual(outcome.leads.map(l => l.company), ['Clera']); assert.deepEqual(outcome.review.map(r => r.company), ['Omni']); assert.equal(outcome.dropped.stale, 1)
})

// ---- #327 review (head c3f12b6): BOTH evidence halves present. The funding event itself must agree on the requested place and sit inside the window; a current London job never rescues it. ----
test('JOINED EVIDENCE, wrong place: fallback funding press says Manchester, the sales posting is a London job -> HELD (no_event_evidence), never verifier-passed', async () => {
  const r = await run({ board: true, place: 'Manchester' })
  assert.equal(state(r.lead), 'held:no_event_evidence', JSON.stringify([r.lead, r.rows]))
  const sansJob = await run({ board: false, place: 'Manchester' }); assert.notEqual(state(sansJob.lead), 'verifier-passed')
})
test('JOINED EVIDENCE, stale funding: the funding is dated 200 days ago (window 90), the sales posting is recent -> HELD, a recent job does not supply the funding date', async () => {
  const r = await run({ board: true, fundDays: 200 })
  assert.notEqual(state(r.lead), 'verifier-passed', JSON.stringify([r.lead, r.rows])); assert.match(state(r.lead), /^held:/)
})
test('JOINED EVIDENCE, positive control: London funding 10 days ago + a London sales job -> verifier-passed (not scoreboard-qualified); inside the window at 80 days too, out at 100', async () => {
  assert.equal(state((await run({ board: true })).lead), 'verifier-passed')
  assert.equal(state((await run({ board: true, fundDays: 80 })).lead), 'verifier-passed')
  assert.match(state((await run({ board: true, fundDays: 100 })).lead), /^held:/)
})
test('JOINED EVIDENCE, controls: a country-level conflict (Canada) and an absent event stay held', async () => {
  assert.match(state((await run({ board: true, place: 'Toronto, Canada' })).lead), /^held:/)
  assert.match(state((await run({ board: true, press: false })).lead), /^held:/)
})

// ---- #327 review (head fc380a2): the place comparison is case- and whitespace-insensitive ----
test('CASE: lowercase / uppercase / oddly spaced "manchester" funding + a London job must NOT pass (mismatched cities fail regardless of casing)', async () => {
  for (const place of ['manchester', 'MANCHESTER', 'Manchester', 'greater  manchester']) {
    const r = await run({ board: true, place })
    assert.equal(state(r.lead), 'held:no_event_evidence', `${place}: ${JSON.stringify([r.lead, r.rows])}`)
  }
})
test('CASE: the SAME city in a different case still passes - "london" / "LONDON" funding + a London job -> verifier-passed (not scoreboard-qualified)', async () => {
  for (const place of ['london', 'LONDON']) assert.equal(state((await run({ board: true, place })).lead), 'verifier-passed', place)
})
test('namesOtherUkCity: case and spacing are normalized; ordinary English words never name a city', async () => {
  const { namesOtherUkCity, eventPlaceOk } = await import('../lib/scan/place-agreement.ts')
  for (const t of ['a manchester startup', 'A MANCHESTER startup', 'based in  Milton   Keynes', 'a leeds fintech']) assert.ok(namesOtherUkCity(t), t)
  for (const t of ['reading the report', 'a bath of ice', 'New York startup', 'the hull of the ship', 'a derby winner', 'a London startup']) assert.equal(namesOtherUkCity(t), null, t)
  assert.equal(eventPlaceOk('Clera, a manchester startup, raised a seed round', ['London, UK']), false)
  assert.equal(eventPlaceOk('Clera, a LONDON startup, raised a seed round', ['London, UK']), true)
  assert.equal(eventPlaceOk('Clera, a manchester startup in london, raised a seed round', ['London, UK']), true, 'a quote that names London itself is not held for also naming another city')
})
