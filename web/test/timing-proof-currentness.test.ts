// #377: fit rationale kept apart from timing, and a durable, versioned machine timing proof that can lift the currentness
// hold for a machine-verified lead with human_confirmed_at NULL - only when the event day is proven inside the window, the
// company domain is confirmed and a named person plus a published route are recorded. Synthetic data, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors, addEnrichment } from '../lib/connectors/store.ts'
import { migrateMemory } from '../lib/memory.ts'
import { currentnessHeld } from '../lib/outreach/currentness.ts'
import { draftBlockReason } from '../lib/outreach/service.ts'
import { recordTimingProof, timingProofGap, TIMING_PROOF_CONNECTOR } from '../lib/scan/timing-proof.ts'
import { fitRationale, TIMING_UNCONFIRMED_NOTE } from '../lib/scan/score.ts'
import { leadCardSummary } from '../lib/scan/lead-card.ts'

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
const WHY = 'Strong fit: a multi-location dental group in Austin, the exact buyer profile.'
const ROUTE = 'Dana Lee, Owner - email: hello@acme-dental.test'

type LeadOpts = Partial<{ event_date: string | null; event_date_proof: string | null; signal: string; signal_kind: string | null; company_domain: string | null; published_at: string | null; review_reason: string | null; quarantined_at: number | null; actionable: string | null; route: string }>
function setup(o: LeadOpts = {}, job: { query?: string; icp?: string | null } = {}) {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateMemory(db)
  const id = createJob(db, 'A', { business_name: 'Seller', industry: 'dental', location: 'Austin' })
  db.prepare("UPDATE scan_jobs SET status = 'running', query = ?, icp = ? WHERE id = ?").run(job.query ?? 'dental groups in Austin that opened a new clinic in the last 30 days', job.icp === undefined ? JSON.stringify({ window_days: 30 }) : job.icp, id)
  db.prepare(`INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, evidence_excerpt, confidence, score, fit, intent, action, why, signal_kind, event_date, event_date_proof, company_domain, published_at, review_reason, quarantined_at)
    VALUES ('L1', ?, 'Acme Dental', 'Dana Lee', 'hello@acme-dental.test', ?, 'https://news.example.test/acme', 'Acme Dental opened its second clinic. Contact hello@acme-dental.test', 80, 70, 4, 4, 3, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, o.signal ?? 'Opened a second clinic', WHY, o.signal_kind === undefined ? 'expansion' : o.signal_kind, o.event_date === undefined ? day(5) : o.event_date, o.event_date_proof === undefined ? 'page_bound' : o.event_date_proof,
      o.company_domain === undefined ? 'acme-dental.test' : o.company_domain, o.published_at ?? null, o.review_reason ?? null, o.quarantined_at ?? null)
  const act = o.actionable === undefined ? 'Actionable: domain, person and published contact confirmed' : o.actionable
  if (act) addEnrichment(db, 'A', 'L1', { connector: 'scan:actionable', kind: 'actionability', value: act, label: o.route ?? ROUTE, confidence: null, source_url: 'https://invalid.example/', source_date: day(0), retrieved_at: Math.floor(Date.now() / 1000) })
  return { db, job: { id, user_id: 'A' } }
}

test('a proven current event + confirmed domain + named person and published route is draftable with human_confirmed_at NULL', () => {
  const { db, job } = setup()
  assert.deepEqual(recordTimingProof(db, job), { proven: 1, held: 0 })
  assert.equal(timingProofGap(db, 'A', 'L1'), null)
  assert.equal(currentnessHeld(db, 'A', 'L1'), false)
  assert.equal(draftBlockReason(db, 'A', 'L1'), null, 'the draft gate agrees with the currentness gate')
  const row = db.prepare('SELECT human_confirmed_at, intent, why FROM leads WHERE id = ?').get('L1') as { human_confirmed_at: number | null; intent: number; why: string }
  assert.equal(row.human_confirmed_at, null, 'no shortcut through human confirmation')
  assert.equal(row.why, WHY, 'the stored rationale is never rewritten')
  assert.equal(timingProofGap(db, 'B', 'L1'), 'no_lead', 'another tenant never sees the proof')
})

test('unsupported timing stays held: model date, publication date, wrong proof kind, stale or future day', () => {
  const cases: [string, LeadOpts, string][] = [
    ['model date only (no proof)', { event_date_proof: null }, 'timing_unproven'],
    ['publication date only', { event_date: null, event_date_proof: null, published_at: day(1) }, 'timing_unproven'],
    ['ats_structured on a non-hiring trigger', { event_date_proof: 'ats_structured' }, 'timing_unproven'],
    ['outside the requested window', { event_date: day(45) }, 'timing_unproven'],
    ['future day', { event_date: day(-3) }, 'timing_unproven'],
  ]
  for (const [name, o, gap] of cases) {
    const { db, job } = setup(o)
    recordTimingProof(db, job)
    assert.equal(timingProofGap(db, 'A', 'L1'), gap, name)
    assert.equal(currentnessHeld(db, 'A', 'L1'), true, name)
    assert.equal(draftBlockReason(db, 'A', 'L1'), 'lead_currentness_unconfirmed', name)
  }
})

test('identity, person and route gaps hold even with proven timing; an unresolved recency bound holds', () => {
  const cases: [string, LeadOpts, { query?: string; icp?: string | null }, string][] = [
    ['no confirmed company domain', { company_domain: null }, {}, 'no_domain'],
    ['no named person / published route', { actionable: 'Not actionable yet: no contact person' }, {}, 'not_actionable'],
    ['no actionability verdict at all', { actionable: null }, {}, 'not_actionable'],
    ['sent to review', { review_reason: 'identity_unconfirmed' }, {}, 'needs_review'],
    ['quarantined', { quarantined_at: 1 }, {}, 'quarantined'],
    ['recency asked without a numeric window', {}, { query: 'dental groups that recently opened a clinic', icp: null }, 'unresolved_recency_bound'],
  ]
  for (const [name, o, job, gap] of cases) {
    const s = setup(o, job)
    recordTimingProof(s.db, s.job)
    assert.equal(timingProofGap(s.db, 'A', 'L1'), gap, name)
    assert.equal(currentnessHeld(s.db, 'A', 'L1'), true, name)
  }
})

test('the proof state is durable and versioned: no record, another version or a changed binding holds', () => {
  const none = setup()
  assert.equal(timingProofGap(none.db, 'A', 'L1'), 'no_record', 'proof is never inferred at read time without the scan-time record')
  assert.equal(currentnessHeld(none.db, 'A', 'L1'), true)

  const old = setup(); recordTimingProof(old.db, old.job)
  old.db.prepare('UPDATE lead_enrichments SET label = ? WHERE connector = ?').run('timing-proof:v0', TIMING_PROOF_CONNECTOR)
  assert.equal(timingProofGap(old.db, 'A', 'L1'), 'version_mismatch')

  const moved = setup(); recordTimingProof(moved.db, moved.job)
  moved.db.prepare("UPDATE leads SET event_date = ? WHERE id = 'L1'").run(day(3))
  assert.equal(timingProofGap(moved.db, 'A', 'L1'), 'binding_changed', 'a different event day is not the proven one')

  const route = setup(); recordTimingProof(route.db, route.job)
  route.db.prepare("UPDATE lead_enrichments SET label = 'Someone Else, CEO - email: ceo@acme-dental.test' WHERE connector = 'scan:actionable'").run()
  assert.equal(timingProofGap(route.db, 'A', 'L1'), 'binding_changed', 'a different person/route is not the proven one')

  // a record forged as proven never stands on its own: every condition is re-checked against the lead now
  const forged = setup({ event_date_proof: null }); recordTimingProof(forged.db, forged.job)
  forged.db.prepare('UPDATE lead_enrichments SET value = ? WHERE connector = ?').run(JSON.stringify({ state: 'proven', v: 1, proof: 'page_bound', date: day(5), domain: 'acme-dental.test', route: 'x' }), TIMING_PROOF_CONNECTOR)
  assert.equal(timingProofGap(forged.db, 'A', 'L1'), 'timing_unproven')
  assert.equal(currentnessHeld(forged.db, 'A', 'L1'), true)
})

test('a user review still lifts the hold for an unproven lead (unchanged)', () => {
  const { db } = setup({ event_date_proof: null })
  assert.equal(currentnessHeld(db, 'A', 'L1'), true)
  db.prepare("UPDATE leads SET human_confirmed_at = 1800000000, human_confirmed_from = 'legacy_currentness_review' WHERE id = 'L1'").run()
  assert.equal(currentnessHeld(db, 'A', 'L1'), false)
})

test('fit rationale is kept apart from timing; an unsupported NOW never returns as a fit reason', () => {
  assert.equal(fitRationale(`${WHY} ${TIMING_UNCONFIRMED_NOTE}`, 'unconfirmed'), WHY)
  assert.equal(fitRationale(WHY, 'proof_backed'), WHY)
  assert.equal(fitRationale(`${TIMING_UNCONFIRMED_NOTE} Model rationale, unverified: They need this NOW.`, 'unconfirmed'), null)
  assert.equal(fitRationale(TIMING_UNCONFIRMED_NOTE, 'unconfirmed'), null, 'legacy rows whose why was replaced by the warning')
  assert.equal(fitRationale('Urgent: they are expanding right now and fit the ICP.', 'unconfirmed'), null)
  assert.equal(fitRationale('Urgent: they are expanding right now and fit the ICP.', 'proof_backed'), 'Urgent: they are expanding right now and fit the ICP.')
  assert.equal(fitRationale(null, 'proof_backed'), null)
  // the card leads with the fit rationale and keeps the timing status on its own line
  const card = leadCardSummary({ id: 'L1', company: 'Acme Dental', contact: null, signal: 'Opened a clinic', source_url: 'https://news.example.test/a', evidence_excerpt: null, event_date: null, why: 'Event timing and current need are unconfirmed. Saved grades are historical, not a currentness verdict.', fit_rationale: WHY } as never)
  assert.equal(card.why, WHY)
  assert.equal(card.timing, 'Event timing and current need are unconfirmed.')
  const legacy = leadCardSummary({ id: 'L1', company: 'Acme Dental', contact: null, signal: 'Opened a clinic', source_url: 'https://news.example.test/a', evidence_excerpt: null, event_date: null, why: 'Saved line.' } as never)
  assert.equal(legacy.why, 'Saved line.'); assert.equal(legacy.timing, null)
})

test('route seam: two equal-fit companies rank apart only when proof supports it, and both keep their fit rationale', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/scan-route-loader.mjs',
    '--test', './test/helpers/leads-route-fit-timing-runtime.mts',
  ], { cwd: path.resolve(fileURLToPath(new URL('../', import.meta.url))), env, encoding: 'utf8', timeout: 90000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /# pass 3/); assert.match(result.stdout, /# fail 0/)
})
