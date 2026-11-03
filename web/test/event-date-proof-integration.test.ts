// Combined A+B integration gates for the locked #377/#378 event-date-proof contract.
// A's write side (runner 3 write points, store columns, runJob fixtures) feeds B's consumer side
// (proofBackedTiming / surfaceStoredIntent / scoreSearchV2). These fixtures deliberately do NOT
// duplicate A's seven event-date-proof-persist fixtures; they assert the seams BETWEEN the sides:
//   1. a persisted page_bound row backs qualified only when a requested window is satisfied
//      (and with no requested window a recognized non-future proof is enough - no invented gate);
//   2. an ats_structured stamp on a NON-hiring trigger is refused by the consumer (the write-side
//      HIRING_SIGNAL text regex is broad - "opening"/"position"/"role"; the consumer gate is strict,
//      so the combined system fails closed);
//   3. route seam GATE: GET /api/leads surfaces a stored intent only once the read layer selects
//      event_date_proof / signal_kind (red until A's listLeads columns land);
//   4. script seam GATE: scripts/scoreboard.mts selects the proof columns and scores with the
//      requested window (red until A's remaining script fields land).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import type { SafeGet } from '../lib/sources/types.ts'
import { proofBackedTiming, surfaceStoredIntent, scoreLeadV2, isHiringTrigger, type ScoredLeadInputV2 } from '../lib/scan/scoreboard.ts'

const FUND_REQUEST = 'Find logistics companies in Chicago that raised seed funding in the past 90 days.'
const FUND_ICP = { summary: 'Chicago logistics companies with seed funding', who: ['Founder'], industries: ['logistics'], sizes: [], where: ['Chicago'], signals: ['raised seed funding'], exclude: [], country: 'US', language: 'en' }
const QUOTE = 'Acme Logistics raised $3M in seed funding to expand its Chicago depot network'

function newsFixture(pageText: string, claim: string | null): Fixture {
  return {
    request: FUND_REQUEST, modelIcp: FUND_ICP, modelQueries: ['Chicago logistics seed funding'],
    hits: [{ url: 'https://news.example/acme-seed', title: 'Acme Logistics seed round', snippet: QUOTE, date: claim }],
    tfPages: {}, own: { 'https://news.example/acme-seed': { title: 'Acme Logistics', text: pageText } },
    extraction: [{ company: 'Acme Logistics', signal: 'raised seed funding', source_url: 'https://news.example/acme-seed', excerpt: QUOTE, event_date: claim }],
  }
}

const proofRows = (db: import('better-sqlite3').Database) =>
  db.prepare('SELECT company, signal, signal_kind, event_date, event_date_proof, review_reason FROM leads').all() as
    { company: string; signal: string | null; signal_kind: string | null; event_date: string | null; event_date_proof: string | null; review_reason: string | null }[]

const NOW = new Date()
const scoredFrom = (r: { event_date: string | null; event_date_proof: string | null; signal: string | null; signal_kind: string | null; review_reason: string | null }): ScoredLeadInputV2 => ({
  name: 'Pat', review_reason: r.review_reason, confidence: 80, quarantined: false, excluded: false, held: false,
  fit: 90, company_domain_confirmed: true, person_title: 'Pat, Founder',
  routes: [{ kind: 'email', value: 'pat@acme.test', role_ok: true }],
  event_date: r.event_date, event_date_proof: r.event_date_proof, signal: r.signal, signal_kind: r.signal_kind, eligible: true,
})

test('seam: a persisted page_bound row backs qualified only with a satisfied requested window', async () => {
  const claim = daysAgo(5)
  const x = await runFixture(newsFixture(`${QUOTE} on ${claim}. The team plans to hire through the year.`, claim))
  const rows = proofRows(x.db)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event_date_proof, 'page_bound', `row: ${JSON.stringify(rows[0])}`)
  const lead = scoredFrom(rows[0])
  // window requested and satisfied: proof-backed timing counts toward qualified
  assert.equal(proofBackedTiming(lead, 90, NOW), true)
  assert.equal(scoreLeadV2(lead, { who: 'Founder', windowDays: 90, timingRequired: true, now: NOW }).qualified, true)
  // window requested and NOT satisfied: the same proof does not count
  assert.equal(proofBackedTiming(lead, 1, NOW), false)
  assert.equal(scoreLeadV2(lead, { who: 'Founder', windowDays: 1, timingRequired: true, now: NOW }).qualified, false)
  // no window requested and no timing requirement: a recognized non-future proof is enough - no invented gate
  assert.equal(proofBackedTiming(lead, null, NOW), true)
  assert.equal(scoreLeadV2(lead, { who: 'Founder', windowDays: null, timingRequired: false, now: NOW }).qualified, true)
  // a recency requirement with no numeric window is an UNRESOLVED bound: not qualified on an unbounded age check
  assert.equal(scoreLeadV2(lead, { who: 'Founder', windowDays: null, timingRequired: true, now: NOW }).qualified, false)
})

test('seam: an unproven (NULL proof) row never backs qualified when timing is required', async () => {
  const x = await runFixture(newsFixture(`${QUOTE}. The company has operated for years and serves the region.`, daysAgo(5)))
  const rows = proofRows(x.db)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event_date_proof, null, `row: ${JSON.stringify(rows[0])}`)
  const lead = scoredFrom(rows[0])
  assert.equal(proofBackedTiming(lead, 90, NOW), false)
  assert.equal(proofBackedTiming(lead, null, NOW), false)
  assert.equal(scoreLeadV2(lead, { who: 'Founder', windowDays: 90, timingRequired: true, now: NOW }).qualified, false)
})

test('counter: an ats_structured stamp on a NON-hiring trigger is refused by the consumer', async () => {
  const gh = 'https://boards.greenhouse.io/multi/jobs/1'
  const published = daysAgo(9)
  const http: SafeGet = async url => {
    if (new URL(url).hostname === 'hn.algolia.com') return null
    const j = (o: unknown) => ({ status: 200, body: JSON.stringify(o) })
    if (url === 'https://boards-api.greenhouse.io/v1/boards/multi/jobs') return j({ jobs: [{ id: 1, title: 'Front Desk Receptionist', updated_at: daysAgo(1), location: { name: 'Brooklyn, NY' }, absolute_url: gh }] })
    if (/\/jobs\/1$/.test(url)) return j({ id: 1, title: 'Front Desk Receptionist', first_published: published, content: '&lt;p&gt;Brooklyn Smiles Dental is hiring a front desk receptionist for its Brooklyn office.&lt;/p&gt;', location: { name: 'Brooklyn, NY' }, absolute_url: gh })
    return null
  }
  // The (stubbed) model cites the job posting as evidence of an EXPANSION ("opening a second clinic"):
  // the write-side HIRING_SIGNAL text regex matches "opening", so this exercises the divergence the
  // consumer gate must catch - ats_structured proves the POSTING's day, never a general company event.
  const quote = 'Brooklyn Smiles Dental is opening a second clinic and is hiring a front desk receptionist'
  const x = await runFixture({
    request: 'Find dental practices in New York City that opened a new clinic in the past 90 days.',
    modelIcp: { summary: 'NYC dental practices expanding', who: ['Owner'], industries: ['dental'], sizes: [], where: ['New York City'], signals: ['opened a new clinic'], exclude: [], country: 'US', language: 'en' },
    modelQueries: ['dental practice new clinic New York'],
    hits: [{ url: gh, title: 'Front Desk Receptionist', snippet: quote, date: published }],
    tfPages: {}, own: { [gh]: { title: 'Front Desk Receptionist', text: `${quote}. The practice welcomes patients every week.` } },
    extraction: [{ company: 'Brooklyn Smiles Dental', signal: 'Opening a second clinic', source_url: gh, excerpt: quote, event_date: published }],
    deps: { sourceHttp: http },
  })
  const rows = proofRows(x.db)
  assert.ok(rows.length >= 1, 'the candidate row exists')
  for (const r of rows) {
    // Whatever the write side recorded (ats_structured admitted by the broad text regex, or NULL), the
    // consumer must never honour an ats_structured stamp for a non-hiring trigger.
    assert.equal(isHiringTrigger(r.signal, r.signal_kind), false, `trigger misclassified as hiring: ${JSON.stringify(r)}`)
    assert.equal(proofBackedTiming(r, 90, NOW), false, `non-hiring trigger honoured an ats_structured stamp: ${JSON.stringify(r)}`)
    assert.equal(surfaceStoredIntent({ intent: 4, event_date_proof: r.event_date_proof, signal: r.signal, signal_kind: r.signal_kind }).timing, 'unconfirmed')
    assert.equal(scoreLeadV2(scoredFrom(r), { who: 'Owner', windowDays: 90, timingRequired: true, now: NOW }).qualified, false)
  }
  // The seam invariant, directly: even where the write-side guard's broad text regex ("opening" matches
  // an expansion signal) admits an ats_structured stamp for a non-hiring trigger, the consumer refuses
  // it - the stamp proves the POSTING's day, never a general company event (#460 contract).
  const misproofed: ScoredLeadInputV2 = scoredFrom({
    event_date: published, event_date_proof: 'ats_structured', signal: 'Opening a second clinic', signal_kind: 'expansion', review_reason: null,
  })
  assert.equal(isHiringTrigger(misproofed.signal, misproofed.signal_kind), false)
  assert.equal(proofBackedTiming(misproofed, 90, NOW), false, 'ats_structured honoured for a non-hiring trigger')
  assert.equal(surfaceStoredIntent({ ...misproofed, intent: 4 }).timing, 'unconfirmed')
  assert.equal(scoreLeadV2(misproofed, { who: 'Owner', windowDays: 90, timingRequired: true, now: NOW }).qualified, false)
  // ...while the SAME stamp on a genuine hiring trigger is honoured inside a requested window.
  const hiringProof: ScoredLeadInputV2 = scoredFrom({
    event_date: published, event_date_proof: 'ats_structured', signal: 'Front desk receptionist job', signal_kind: 'hiring', review_reason: null,
  })
  assert.equal(proofBackedTiming(hiringProof, 90, NOW), true)
})

test('route seam (gate): GET /api/leads proof surfacing (real handler, stubbed session, no network)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/scan-route-loader.mjs',
    '--test', './test/helpers/leads-route-proof-runtime.mts',
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 90000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /# pass 1/); assert.match(result.stdout, /# fail 0/)
})

test('script seam (gate): scripts/scoreboard.mts selects proof columns and scores with the requested window', () => {
  const src = readFileSync(path.resolve(import.meta.dirname, '..', 'scripts', 'scoreboard.mts'), 'utf8')
  const select = src.match(/SELECT[\s\S]*?FROM leads/)?.[0] ?? ''
  assert.match(select, /event_date_proof/, 'the scoreboard read carries the proof column')
  assert.match(select, /signal_kind/, 'the scoreboard read carries signal_kind (trigger compatibility)')
  assert.match(src, /scoreSearchV2|scoreLeadV2/, 'the scoreboard scores with the v2 rubric')
  assert.match(src, /windowDays/, 'the scoreboard passes the requested window to the scorer')
})
