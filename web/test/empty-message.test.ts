import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyMessage } from '../lib/scan/empty-message.ts'

test('a zero-lead scan explains which case it was', () => {
  assert.match(emptyMessage(null), /no leads/)
  assert.match(emptyMessage({ candidates: 0, needs_review: 0 }), /no candidates/)
  assert.match(emptyMessage({ candidates: 5, needs_review: 2 }), /2 need your review/)
  assert.match(emptyMessage({ candidates: 5, needs_review: 0 }), /5 candidates were found but none passed/)
})
