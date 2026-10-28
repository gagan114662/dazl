// One automatic recovery pass before a candidate is marked held: an undated verified lead, or one whose page lacks the quote, gets the same company's coverage from other press (free news search), through
// the SAME extraction, verifier and window gate. Stubbed pages / news / model through the real runJob; invented company; no network, no key, no credits; no gate is relaxed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import { fallbackTargets, mergeFallback, recordRecovery } from '../lib/scan/blocked-fallback.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const REQUEST = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days.'
const ICP = { summary: 'London seed B2B SaaS', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const filler = ' More about the company, its product and its people.'.repeat(10)
const BLOG = 'https://orbitly.example/blog/seed', PRESS = 'https://sifted.example/orbitly-raises-seed'
const FUND = 'Orbitly, a London B2B SaaS startup, raised a 3m GBP seed round this month'
const gdelt = (urls: string[]) => JSON.stringify({ articles: urls.map(u => ({ url: u, title: 'Orbitly raises seed round', seendate: '20261016T100000Z' })) })
interface Opt { press?: boolean; otherCompany?: boolean; pressDays?: number; paid?: boolean; blogText?: string; blogDate?: string | null }
async function run(o: Opt) {
  const newsCalls: string[] = []
  const newsHttp: SafeGet = async url => { newsCalls.push(url); return { status: 200, body: gdelt(o.press === false ? [] : [PRESS]) } }
  const pressText = o.otherCompany ? 'Zenix, a London B2B SaaS startup, raised a 2m GBP seed round this month' : FUND
  const blogCand: Cand = { company: 'Orbitly', signal: 'raised a seed round', source_url: BLOG, excerpt: FUND, event_date: o.blogDate ?? null as never }
  const pressCand: Cand = o.otherCompany ? { company: 'Zenix', signal: 'raised a seed round', source_url: PRESS, excerpt: pressText, event_date: daysAgo(o.pressDays ?? 10) } : { company: 'Orbitly', signal: 'raised a seed round', source_url: PRESS, excerpt: FUND, event_date: daysAgo(o.pressDays ?? 10) }
  const f: Fixture = { request: REQUEST, modelIcp: ICP, modelQueries: ['london saas startup seed round'], hits: [{ url: BLOG, title: 'Orbitly raises seed', snippet: FUND, date: null }], tfPages: {},
    own: { [BLOG]: { title: 'Orbitly seed', text: o.blogText ?? `${FUND}.${filler}` }, [PRESS]: { title: 'Orbitly raises seed round', text: `Published ${daysAgo(o.pressDays ?? 10)}. ${pressText}.${filler}` } },
    extraction: [blogCand, pressCand], deps: { newsHttp, ...(o.paid === false ? { paidFallback: false } : {}) } }
  const x = await runFixture(f)
  const lead = x.db.prepare("SELECT id, company, review_reason, event_date, source_url FROM leads WHERE company = 'Orbitly'").get() as { id: string; company: string; review_reason: string | null; event_date: string | null; source_url: string } | undefined
  const rec = lead ? x.db.prepare("SELECT value, label FROM lead_enrichments WHERE lead_id = ? AND connector = 'scan:recovery'").get(lead.id) as { value: string; label: string } | undefined : undefined
  return { x, lead, rec, newsCalls }
}
const state = (l?: { review_reason: string | null }) => (!l ? 'none' : l.review_reason === null ? 'verifier-passed' : `held:${l.review_reason}`)

test('BEFORE: an undated verified lead with no other source is held outside_window_undated - AFTER the recovery pass the hold carries a record that the pass ran', async () => {
  const r = await run({ press: false })
  assert.equal(state(r.lead), 'held:outside_window_undated', JSON.stringify(r.lead)); assert.match(r.rec!.value, /^Recovery pass ran before this was held \(undated\): searched other press for a dated source for the same company; none verified\.$/); assert.equal(r.rec!.label, 'recovery:undated')
})
test('RECOVERED (date): the same company\'s dated coverage on other press replaces the undated lead -> verifier-passed (not scoreboard-qualified), dated, citing the press', async () => {
  const r = await run({})
  assert.equal(state(r.lead), 'verifier-passed', JSON.stringify([r.lead, r.rec])); assert.equal(r.lead!.source_url, PRESS); assert.equal(r.lead!.event_date, daysAgo(10)); assert.equal(r.rec, undefined, 'rescued: no "none verified" record')
})
test('RECOVERED (source): the cited page does not carry the quote; other press does -> verifier-passed from the press', async () => {
  const r = await run({ blogText: `Orbitly is a London software company.${filler}`, blogDate: daysAgo(10) })
  assert.equal(state(r.lead), 'verifier-passed', JSON.stringify(r.lead)); assert.equal(r.lead!.source_url, PRESS)
})
test('GATES HOLD: other press about a DIFFERENT company, or dated 200 days ago, never rescues; the hold stays with its recovery record', async () => {
  const other = await run({ otherCompany: true }); assert.equal(state(other.lead), 'held:outside_window_undated'); assert.match(other.rec!.value, /none verified/)
  assert.equal((other.x.db.prepare("SELECT count(*) AS n FROM leads WHERE company = 'Zenix'").get() as { n: number }).n, 0)
  const stale = await run({ pressDays: 200 }); assert.notEqual(state(stale.lead), 'verifier-passed', JSON.stringify(stale.lead))
})
test('a run that disabled the paid fallback makes no recovery search and says so on the hold', async () => {
  const r = await run({ paid: false })
  assert.equal(state(r.lead), 'held:outside_window_undated'); assert.equal(r.newsCalls.length, 0); assert.match(r.rec!.value, /^Recovery pass did not run \(the run disabled the paid fallback\)\./)
})
test('targets: only undated verified leads and reasons another source can fix (blocked / JavaScript / quote not on the page); stale, place, closed-job and counterparty verdicts get none; at most 3', () => {
  const held = (company: string, reason: string) => ({ company, signal: 'raised a seed round', source_url: `https://${company.toLowerCase()}.example/x`, review_reason: reason })
  const t = fallbackTargets([held('A1', 'quote_unconfirmed'), held('B2', 'blocked_by_site'), held('C3', 'outside_window'), held('D4', 'location_mismatch'), held('E5', 'job_closed'), held('F6', 'counterparty_signal'), held('G7', 'needs_javascript')], ['London, UK'], [{ company: 'U1', signal: 's', source_url: 'https://u1.example/x' }])
  assert.deepEqual(t.map(x => x.company), ['A1', 'B2', 'G7']); assert.equal(fallbackTargets([], ['London'], [{ company: 'U1', signal: 's', source_url: 'https://u1.example/x' }])[0].reason, 'undated')
  const outcome = { leads: [{ company: 'U1', source_url: 'https://u1.example/x', event_date: null as string | null }], review: [], dropped: {} as Record<string, number> }
  const n1 = mergeFallback(outcome as never, { leads: [{ company: 'U1', source_url: 'https://press.example/u1', event_date: null }], dropped: {} } as never, fallbackTargets([], ['London'], [{ company: 'U1', signal: 's', source_url: 'https://u1.example/x' }])); assert.equal(n1.length, 0, 'an undated replacement changes nothing')
  void recordRecovery
})
