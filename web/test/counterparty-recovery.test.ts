// #352: a lead held because its only source is ANOTHER company's page naming it as a customer (counterparty_signal, the London "customer-mention" case) gets the same bounded automatic
// recovery pass as a blocked or undated lead: one same-company search of other press, whose pages go through the SAME extraction, verifier (counterparty check included) and window gate.
// Stubbed pages / news / model through the real runJob; invented companies and URLs; no network, no key, no credits; no gate is relaxed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import { fallbackTargets } from '../lib/scan/blocked-fallback.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const REQUEST = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days.'
const ICP = { summary: 'London seed B2B SaaS', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const filler = ' More about the company, its product and its people.'.repeat(10)
const VENDOR = 'https://acmecrm.example/customers/orbitly', PRESS = 'https://sifted.example/orbitly-raises-seed'
const FUND = 'Orbitly, a London B2B SaaS startup, raised a 3m GBP seed round this month'
const gdelt = (urls: string[]) => JSON.stringify({ articles: urls.map(u => ({ url: u, title: 'Orbitly raises seed round', seendate: '20261016T100000Z' })) })
interface Opt { press?: boolean; otherCompany?: boolean; pressDays?: number; paid?: boolean }
async function run(o: Opt) {
  const newsCalls: string[] = []
  const newsHttp: SafeGet = async url => { newsCalls.push(url); return { status: 200, body: gdelt(o.press === false ? [] : [PRESS]) } }
  const pressText = o.otherCompany ? 'Zenix, a London B2B SaaS startup, raised a 2m GBP seed round this month' : FUND
  // The cited page is the vendor's customer story: it names Orbitly as AcmeCRM's customer. That is a fact about AcmeCRM, so the verifier holds it as counterparty_signal.
  const vendorCand: Cand = { company: 'Orbitly', signal: 'raised a seed round', source_url: VENDOR, excerpt: FUND, event_date: daysAgo(10) }
  const pressCand: Cand = o.otherCompany ? { company: 'Zenix', signal: 'raised a seed round', source_url: PRESS, excerpt: pressText, event_date: daysAgo(o.pressDays ?? 10) } : { company: 'Orbitly', signal: 'raised a seed round', source_url: PRESS, excerpt: FUND, event_date: daysAgo(o.pressDays ?? 10) }
  const f: Fixture = { request: REQUEST, modelIcp: ICP, modelQueries: ['london saas startup seed round'], hits: [{ url: VENDOR, title: 'Orbitly runs on AcmeCRM', snippet: FUND, date: null }], tfPages: {},
    own: {
      [VENDOR]: { title: 'Customer story: Orbitly runs on AcmeCRM', text: `On ${daysAgo(10)}, ${FUND}. Orbitly uses AcmeCRM to run its sales team.${filler}` },
      [PRESS]: { title: 'Orbitly raises seed round', text: `On ${daysAgo(o.pressDays ?? 10)}, ${pressText}.${filler}` },
    },
    extraction: [vendorCand, pressCand], deps: { newsHttp, ...(o.paid === false ? { paidFallback: false } : {}) } }
  const x = await runFixture(f)
  const lead = x.db.prepare("SELECT id, company, review_reason, event_date, source_url FROM leads WHERE company = 'Orbitly'").get() as { id: string; company: string; review_reason: string | null; event_date: string | null; source_url: string } | undefined
  const rec = lead ? x.db.prepare("SELECT value, label FROM lead_enrichments WHERE lead_id = ? AND connector = 'scan:recovery'").get(lead.id) as { value: string; label: string } | undefined : undefined
  return { x, lead, rec, newsCalls }
}
const state = (l?: { review_reason: string | null }) => (!l ? 'none' : l.review_reason === null ? 'verifier-passed' : `held:${l.review_reason}`)

test('customer mention, no other press: held counterparty_signal, and the hold records that the recovery pass searched for a source about the company itself', async () => {
  const r = await run({ press: false })
  assert.equal(state(r.lead), 'held:counterparty_signal', JSON.stringify(r.lead))
  assert.equal((r.x.db.prepare("SELECT count(*) AS n FROM scan_source_runs WHERE collector = 'fallback:news'").get() as { n: number }).n, 1, 'the recovery pass searched')
  assert.equal(r.rec?.label, 'recovery:counterparty_signal')
  assert.match(r.rec!.value, /^Recovery pass ran before this was held \(counterparty_signal\): searched other press for a source about the company itself for the same company; none verified\.$/)
})

test('RECOVERED: the company\'s own coverage on other press replaces the customer-mention hold -> verifier-passed (not scoreboard-qualified), citing the press', async () => {
  const r = await run({})
  assert.equal(state(r.lead), 'verifier-passed', JSON.stringify([r.lead, r.rec])); assert.equal(r.lead!.source_url, PRESS); assert.equal(r.lead!.event_date, daysAgo(10))
  assert.equal(r.rec, undefined, 'rescued: no "none verified" record')
})

test('GATES HOLD: press about a DIFFERENT company, or dated 200 days ago, never rescues; the customer-mention hold stays with its recovery record', async () => {
  const other = await run({ otherCompany: true })
  assert.equal(state(other.lead), 'held:counterparty_signal'); assert.match(other.rec!.value, /none verified/)
  assert.equal((other.x.db.prepare("SELECT count(*) AS n FROM leads WHERE company = 'Zenix'").get() as { n: number }).n, 0, 'another company found by the recovery search is never added, and never becomes Orbitly')
  const stale = await run({ pressDays: 200 }); assert.notEqual(state(stale.lead), 'verifier-passed', JSON.stringify(stale.lead))
})

test('a run that disabled the paid fallback makes no recovery search for a customer mention and says so on the hold', async () => {
  const r = await run({ paid: false })
  assert.equal(state(r.lead), 'held:counterparty_signal')
  assert.equal((r.x.db.prepare("SELECT count(*) AS n FROM scan_source_runs WHERE collector = 'fallback:news'").get() as { n: number }).n, 0, 'no recovery search recorded')
  assert.match(r.rec!.value, /^Recovery pass did not run \(the run disabled the paid fallback\)\./)
})

test('targets: a customer mention is a recovery target (bounded by the same cap of 3); stale, place and closed-job verdicts still get none', () => {
  const held = (company: string, reason: string) => ({ company, signal: 'raised a seed round', source_url: `https://${company.toLowerCase()}.example/x`, review_reason: reason })
  const t = fallbackTargets([held('C1', 'outside_window'), held('D2', 'location_mismatch'), held('E3', 'job_closed'), held('F4', 'counterparty_signal')], ['London, UK'])
  assert.deepEqual(t.map(x => [x.company, x.reason]), [['F4', 'counterparty_signal']]); assert.match(t[0].query, /^"F4" raised a seed round London$/)
  assert.equal(fallbackTargets(['A', 'B', 'C', 'D'].map(c => held(c, 'counterparty_signal')), ['London']).length, 3)
})
