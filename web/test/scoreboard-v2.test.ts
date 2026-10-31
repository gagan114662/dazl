// #378: rubric v2. DRAFT prepared pre-implementation. Counters are reported separately and reconcile
// with the live actionable gates; 'actionable' matches A's YieldSummary.actionable on the same job and
// is labelled "timing not yet proven"; 'proof_backed_actionable' adds proven current event inside the
// requested window; headline 'qualified' requires proof-backed timing whenever the request mandates it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { scoreLeadV2, scoreSearchV2, scoreboardMarkdownV2, RUBRIC_VERSION } from '../lib/scan/scoreboard.ts'

const NOW = new Date('2026-10-26T12:00:00Z')
const OPTS = { who: 'founder', windowDays: 90, timingRequired: true, now: NOW }
const good = {
  name: 'Pat Lee', contact: null, review_reason: null, confidence: 0.9, quarantined: false, excluded: false, held: false,
  fit: 5, company_domain_confirmed: true, person_title: 'Pat Lee, Founder',
  routes: [{ kind: 'email' as const, value: 'pat@acme.com', role_ok: true }],
  event_date: '2026-10-20', event_date_proof: 'page_bound' as const, signal: 'Opening a second Toronto clinic', signal_kind: 'expansion', contacts: [] as string[],
}

test('a fully proven lead is actionable, proof-backed and qualified', () => {
  const c = scoreLeadV2(good, OPTS)
  assert.equal(c.source_checked, true); assert.equal(c.fit, true); assert.equal(c.current_event, true)
  assert.equal(c.right_person, true); assert.equal(c.reachable_email, true); assert.equal(c.actionable, true)
  assert.equal(c.proof_backed_actionable, true); assert.equal(c.qualified, true)
})

test('acceptance fixtures cannot inflate qualified yield', () => {
  // wrong-company contact: route belongs to someone else / no role-appropriate person
  assert.equal(scoreLeadV2({ ...good, person_title: 'Pat Lee, Dentist', routes: [{ kind: 'email', value: 'info@other.com', role_ok: false }] }, OPTS).qualified, false)
  // unverified claimed date: date present but no recognized proof
  const undated = scoreLeadV2({ ...good, event_date_proof: null }, OPTS)
  assert.equal(undated.current_event, false); assert.equal(undated.actionable, true); assert.equal(undated.proof_backed_actionable, false); assert.equal(undated.qualified, false)
  // quarantined lead
  assert.equal(scoreLeadV2({ ...good, quarantined: true }, OPTS).actionable, false)
  // generic hiring inbox is not an email route; phone readiness is reported separately
  const inbox = scoreLeadV2({ ...good, routes: [{ kind: 'email', value: 'careers@acme.com', role_ok: false }] }, OPTS)
  assert.equal(inbox.reachable_email, false); assert.equal(inbox.reachable_phone, false); assert.equal(inbox.actionable, false)
  const phoneOnly = scoreLeadV2({ ...good, routes: [{ kind: 'phone', value: '+1 614 555 0199', role_ok: true }] }, OPTS)
  assert.equal(phoneOnly.reachable_phone, true); assert.equal(phoneOnly.reachable_email, false); assert.equal(phoneOnly.actionable, true)
  // missing person
  assert.equal(scoreLeadV2({ ...good, person_title: null }, OPTS).right_person, false)
})

test('the request window, not a fixed 90 days, decides current_event (30d vs 180d fixture)', () => {
  const old = { ...good, event_date: '2026-07-18' } // 100 days before NOW
  assert.equal(scoreLeadV2(old, { ...OPTS, windowDays: 30 }).current_event, false)
  assert.equal(scoreLeadV2(old, { ...OPTS, windowDays: 180 }).current_event, true)
})

test('ats_structured proves a posting date only: hiring trigger qualifies, funding trigger does not', () => {
  const ats = { ...good, event_date_proof: 'ats_structured' as const }
  assert.equal(scoreLeadV2({ ...ats, signal_kind: 'hiring' }, OPTS).current_event, true)
  assert.equal(scoreLeadV2({ ...ats, signal_kind: 'funding' }, OPTS).current_event, false)
})

test('mandatory timing: qualified requires proof; without a timing requirement qualified equals actionable', () => {
  const noProof = { ...good, event_date_proof: null }
  assert.equal(scoreLeadV2(noProof, { ...OPTS, timingRequired: true }).qualified, false)
  assert.equal(scoreLeadV2(noProof, { ...OPTS, timingRequired: false }).qualified, true)
})

test('v2 totals and markdown carry the rubric version and the distinct labelled counters', () => {
  const s = scoreSearchV2([good, { ...good, event_date_proof: null }, { ...good, quarantined: true }], OPTS)
  assert.equal(RUBRIC_VERSION, 'v2')
  assert.equal(s.leads, 3); assert.equal(s.actionable, 2); assert.equal(s.proof_backed_actionable, 1); assert.equal(s.qualified, 1)
  const md = scoreboardMarkdownV2([{ search: 'Toronto | dental', status: 'done', error: null, score: s }], { commit: 'abc', date: '2026-10-26', rubric: RUBRIC_VERSION })
  assert.ok(md.includes('rubric v2'))
  assert.ok(md.includes('timing not yet proven'), 'the timing-free actionable count is labelled, never rebranded as ready')
})
