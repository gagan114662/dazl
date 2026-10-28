import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'

const done = (o: object) => scanOutcome({ id: 'j1', status: 'done', error: null, ...o })
const failed = (error: string | null, o: object = {}) => scanOutcome({ id: 'j1', status: 'failed', error, ...o })

test('failed, zero-match and all-rejected scans are distinct outcomes, each with one next step', () => {
  const zero = failed('no_candidates', { candidates: 0 })
  assert.equal(zero.kind, 'zero_match')
  assert.deepEqual(zero.next, { text: 'Rephrase or broaden the search', href: '/app/leads' })

  const dropped = done({ candidates: 7, verified: 0, needs_review: 0, dropped: 7 })
  assert.equal(dropped.kind, 'all_dropped')
  assert.equal(dropped.label, '7 found, all dropped by the checks')
  assert.deepEqual(dropped.next, { text: 'See why they were dropped', href: '/app/leads?job_id=j1' })

  const fail = failed('provider said no')
  assert.equal(fail.kind, 'failed')
  assert.deepEqual(fail.next, { text: 'Try again', href: '/app/leads' })
  assert.notEqual(zero.label, fail.label)
  assert.notEqual(dropped.label, zero.label)
})

test('a stop is never reported as an empty search', () => {
  for (const e of ['budget_stopped', 'scan_timeout', 'cancelled']) {
    const o = failed(e, { candidates: 0 })
    assert.equal(o.kind, 'stopped', e)
    assert.doesNotMatch(o.label, /no match|nothing found/i, e)
    assert.ok(o.next, e)
  }
  assert.match(failed('budget_stopped').label, /not an empty search/)
})

test('key problems point at Settings or a retry; free-text errors stay a plain failure', () => {
  assert.equal(failed('key_unreadable').next?.href, '/app/settings')
  assert.equal(failed('no_api_key').next?.href, '/app/settings')
  assert.equal(failed('trial_key_invalid').next?.text, 'Try again later')
  assert.equal(failed('key_rejected').next?.text, 'Try again later')
  assert.equal(failed(null).label, 'Failed')
})

test('review-only and leads outcomes keep the counts; only review-only needs a step', () => {
  const r = done({ candidates: 5, verified: 0, needs_review: 5, dropped: 0 })
  assert.equal(r.kind, 'review_only')
  assert.equal(r.next?.text, 'Review them')
  assert.equal(done({ candidates: 2, verified: 0, needs_review: 1, dropped: 1 }).next?.text, 'Review it')
  const l = done({ candidates: 9, verified: 3, needs_review: 2, dropped: 4 })
  assert.equal(l.kind, 'leads')
  assert.equal(l.label, '9 found: 3 source-checked, 2 need your review, 4 dropped')
  assert.equal(l.next, null)
})

test('older records without counts say they cannot tell zero-match from all-dropped, and never show a lead total', () => {
  const none = done({ candidates: null, verified: null, needs_review: null, lead_count: 0 })
  assert.equal(none.kind, 'unrecorded')
  assert.match(none.label, /did not record whether nothing matched or everything was dropped/)
  const some = done({ verified: null, needs_review: null, lead_count: 4 })
  assert.equal(some.kind, 'unrecorded')
  assert.doesNotMatch(some.label, /4/)
  assert.equal(some.next?.href, '/app/leads?job_id=j1')
})

test('pending and running scans have no outcome yet', () => {
  assert.equal(scanOutcome({ id: 'j', status: 'running', error: null }).kind, 'running')
  assert.equal(scanOutcome({ id: 'j', status: 'pending', error: 'retrying' }).next, null)
})
