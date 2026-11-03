// #377: the leads GET route surfaces stored intent ONLY with recognized event_date_proof, and labels
// timing explicitly. DRAFT pre-implementation. The route delegates the decision to the pure
// surfaceStoredIntent (lib/scan/scoreboard.ts, B-owned); this test pins that function's contract.
// A route-runtime loader test (same harness as estimate-route.test.ts) is added at implementation time.
import test from 'node:test'
import assert from 'node:assert/strict'
import { surfaceStoredIntent } from '../lib/scan/scoreboard.ts'

const NOW = new Date('2026-10-20T12:00:00Z')
const dated = { event_date: '2026-10-12' } // 8 days before NOW

test('stored intent surfaces only with a recognized proof on a valid, non-future day; legacy and unrecognized states stay held', () => {
  assert.deepEqual(surfaceStoredIntent({ intent: 4, ...dated, event_date_proof: 'page_bound' }, { now: NOW }), { intent: 4, timing: 'proof_backed' })
  assert.deepEqual(surfaceStoredIntent({ intent: 4, ...dated, event_date_proof: null }, { now: NOW }), { intent: 0, timing: 'unconfirmed' })
  assert.deepEqual(surfaceStoredIntent({ intent: 4, ...dated, event_date_proof: 'structured_same_event' }, { now: NOW }), { intent: 0, timing: 'unconfirmed' }, 'retired vocabulary fails closed')
  assert.deepEqual(surfaceStoredIntent({ intent: null, ...dated, event_date_proof: 'page_bound' }, { now: NOW }), { intent: 0, timing: 'unconfirmed' }, 'no stored grade means nothing to surface')
  assert.deepEqual(surfaceStoredIntent({ intent: 4, event_date_proof: 'page_bound' }, { now: NOW }), { intent: 0, timing: 'unconfirmed' }, 'proof without a stored day is not proof')
  assert.deepEqual(surfaceStoredIntent({ intent: 4, event_date: '2026-13-01', event_date_proof: 'page_bound' }, { now: NOW }), { intent: 0, timing: 'unconfirmed' }, 'a non-calendar day fails closed')
  assert.deepEqual(surfaceStoredIntent({ intent: 4, event_date: '2026-10-21', event_date_proof: 'page_bound' }, { now: NOW }), { intent: 0, timing: 'unconfirmed' }, 'a future day fails closed')
})

test('the request window gates surfacing; recency wording without a numeric window is an unresolved bound', () => {
  assert.deepEqual(surfaceStoredIntent({ intent: 4, ...dated, event_date_proof: 'page_bound' }, { now: NOW, windowDays: 7 }), { intent: 0, timing: 'unconfirmed' }, 'outside the requested window')
  assert.deepEqual(surfaceStoredIntent({ intent: 4, ...dated, event_date_proof: 'page_bound' }, { now: NOW, windowDays: 30 }), { intent: 4, timing: 'proof_backed' }, 'inside the requested window')
  assert.deepEqual(surfaceStoredIntent({ intent: 4, ...dated, event_date_proof: 'page_bound' }, { now: NOW, timingRequired: true }), { intent: 0, timing: 'unconfirmed' }, 'recency requested, no numeric window: unresolved, not proof-backed')
  assert.deepEqual(surfaceStoredIntent({ intent: 4, ...dated, event_date_proof: 'page_bound' }, { now: NOW }), { intent: 4, timing: 'proof_backed' }, 'no timing requirement, no window: no gate invented')
})

test('ats_structured surfaces intent only for a hiring trigger', () => {
  assert.deepEqual(surfaceStoredIntent({ intent: 3, ...dated, event_date_proof: 'ats_structured', signal_kind: 'hiring' }, { now: NOW }), { intent: 3, timing: 'proof_backed' })
  assert.deepEqual(surfaceStoredIntent({ intent: 3, ...dated, event_date_proof: 'ats_structured', signal_kind: 'funding' }, { now: NOW }), { intent: 0, timing: 'unconfirmed' })
})
