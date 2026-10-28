import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviewAction } from '../lib/scan/review-action.ts'

test('a time-window hold survives confirming, so the action says "research only", never "use it"', () => {
  for (const r of ['outside_window', 'outside_window_undated']) {
    const a = reviewAction(r)
    assert.equal(a.label, 'Keep as research')
    assert.match(a.hint, /research only: it stays out of drafting/)
  }
  assert.equal(reviewAction('quote_unconfirmed', true).label, 'Keep as research', 'any reason with a window hold')
})

test('date problems: confirming vouches for the date and unlocks drafting; the hint says dazl has not verified it', () => {
  for (const r of ['event_timing_unconfirmed', 'event_date_bad_date', 'event_date_stale', 'event_date_future_date']) {
    const a = reviewAction(r)
    assert.equal(a.label, 'I checked the date - use it')
    assert.match(a.hint, /can be drafted\. dazl has not verified the date or current need; you are vouching for it\./)
  }
})

test('other reasons: confirmed by you, never source-checked; other draft checks still apply', () => {
  for (const r of ['quote_unconfirmed', 'source_review_required', 'location_unconfirmed', null, undefined]) {
    const a = reviewAction(r)
    assert.equal(a.label, 'I checked the source - use it')
    assert.match(a.hint, /confirmed by you \(never shown as source-checked\), and it can be drafted\. The other draft checks still apply\./)
  }
})
