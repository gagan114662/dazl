// The test-account fixture controls (app/app/leads/verification-fixture.tsx), #411 review findings 5 and 6: a successful
// first-touch create opens the fixture's play so its lead is on screen, and a refused or failed action says why.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fixtureFailureMessage, fixtureNextUrl } from '../lib/scan/fixture-action-result.ts'

const JOB = 'a1b2c3d4e5f6a7b8c9d0e1f2'

test('after a successful first-touch create the control opens /app/leads?job_id=<jobId>; nothing else navigates', () => {
  assert.equal(fixtureNextUrl('POST', 'first_touch', true, { jobId: JOB, leadId: 'x', created: true }), `/app/leads?job_id=${JOB}`)
  assert.equal(fixtureNextUrl('POST', 'first_touch', true, { jobId: JOB, leadId: 'x', created: false }), `/app/leads?job_id=${JOB}`, 'already there: open it too')
  assert.equal(fixtureNextUrl('POST', 'first_touch', false, { jobId: JOB }), null)
  assert.equal(fixtureNextUrl('DELETE', 'first_touch', true, { deleted: true }), null)
  assert.equal(fixtureNextUrl('POST', undefined, true, { jobId: JOB }), null)
  assert.equal(fixtureNextUrl('POST', 'review_draft', true, { jobId: JOB }), null)
  for (const body of [null, 'x', { jobId: 42 }, { jobId: '../evil' }, { jobId: JOB + '0' }, { jobId: JOB.toUpperCase() }]) assert.equal(fixtureNextUrl('POST', 'first_touch', true, body), null, JSON.stringify(body))
})

test('a refused cleanup shows a status line: explicit for send_in_flight and recent_send, generic otherwise', () => {
  // also what a plain "remove the verification fixture" gets: it names the first-touch fixture and says nothing was removed
  for (const code of ['send_in_flight', 'recent_send']) {
    const m = fixtureFailureMessage(403, { error: code })
    assert.match(m, /^Nothing was removed/, code); assert.match(m, /first-touch fixture/, code)
  }
  assert.match(fixtureFailureMessage(403, { error: 'send_in_flight' }), /still sending or its outcome is uncertain/)
  assert.match(fixtureFailureMessage(403, { error: 'recent_send' }), /7 days for a first touch/)
  for (const [status, body] of [[403, { error: 'test_tenant_only' }], [400, { error: 'unknown_action' }], [500, null], [403, { error: 'Bad origin' }]] as const) {
    const m = fixtureFailureMessage(status, body)
    assert.match(m, new RegExp(`error ${status}`)); assert.doesNotMatch(m, /uncertain|24 hours|first-touch/)
  }
  assert.match(fixtureFailureMessage(429, { error: 'Too many requests' }), /Too many requests/)
  assert.match(fixtureFailureMessage(null, null), /no response/)
})

test('the control uses both: it navigates after a successful action and renders the failure line', () => {
  const src = readFileSync(new URL('../app/app/leads/verification-fixture.tsx', import.meta.url), 'utf8')
  assert.match(src, /fixtureNextUrl\(method, action, true, body\)/)
  assert.match(src, /window\.location\.assign\(next\)/)
  assert.match(src, /setNote\(fixtureFailureMessage\(/)
  assert.match(src, /role="status"[^>]*>\{note\}/)
})
