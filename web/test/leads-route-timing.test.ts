// #377: the leads GET route surfaces stored intent ONLY with recognized event_date_proof, and labels
// timing explicitly. DRAFT pre-implementation. The route delegates the decision to the pure
// surfaceStoredIntent (lib/scan/scoreboard.ts, B-owned); this test pins that function's contract.
// A route-runtime loader test (same harness as estimate-route.test.ts) is added at implementation time.
import test from 'node:test'
import assert from 'node:assert/strict'
import { surfaceStoredIntent } from '../lib/scan/scoreboard.ts'

test('stored intent surfaces only with a recognized proof; legacy and unrecognized states stay held', () => {
  assert.deepEqual(surfaceStoredIntent({ intent: 4, event_date_proof: 'page_bound' }), { intent: 4, timing: 'proof_backed' })
  assert.deepEqual(surfaceStoredIntent({ intent: 4, event_date_proof: null }), { intent: 0, timing: 'unconfirmed' })
  assert.deepEqual(surfaceStoredIntent({ intent: 4, event_date_proof: 'structured_same_event' }), { intent: 0, timing: 'unconfirmed' }, 'retired vocabulary fails closed')
  assert.deepEqual(surfaceStoredIntent({ intent: null, event_date_proof: 'page_bound' }), { intent: 0, timing: 'unconfirmed' }, 'no stored grade means nothing to surface')
})

test('ats_structured surfaces intent only for a hiring trigger', () => {
  assert.deepEqual(surfaceStoredIntent({ intent: 3, event_date_proof: 'ats_structured', signal_kind: 'hiring' }), { intent: 3, timing: 'proof_backed' })
  assert.deepEqual(surfaceStoredIntent({ intent: 3, event_date_proof: 'ats_structured', signal_kind: 'funding' }), { intent: 0, timing: 'unconfirmed' })
})
