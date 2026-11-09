import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'

// Migrated from the removed test-only lib/scan/empty-message.ts (Refs #897): a finished scan with
// nothing to list always says which case it was, through the one authoritative outcome the UI renders.
const done = (o: object) => scanOutcome({ id: 'j1', status: 'done', error: null, ...o })

test('a zero-lead scan explains which case it was, never a silent zero', () => {
  const unrecorded = done({})
  assert.equal(unrecorded.kind, 'unrecorded')
  assert.match(unrecorded.label, /no leads/)

  const none = done({ candidates: 0, verified: 0, needs_review: 0, dropped: 0 })
  assert.equal(none.kind, 'none_extracted')
  assert.match(none.label, /No candidates/)

  const review = done({ candidates: 5, verified: 0, needs_review: 2, dropped: 3 })
  assert.equal(review.kind, 'review_only')
  assert.match(review.label, /2 need your review/)

  const dropped = done({ candidates: 5, verified: 0, needs_review: 0, dropped: 5 })
  assert.equal(dropped.kind, 'all_dropped')
  assert.match(dropped.label, /5 found, all dropped/)

  for (const o of [unrecorded, none, review, dropped]) assert.ok(o.next, `${o.kind} offers one next step`)
})
