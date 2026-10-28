import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviewAction } from '../lib/scan/review-action.ts'

const NOW = new Date('2026-10-28T12:00:00Z')
const act = (o: object) => reviewAction(o as never, NOW)
const NO_WIDEN = /wider|widen/i

// Instinct #271: "Widen the window to draft it" was false for undated, invalid and future dates, which no window
// ever admits, and misleading for older dates, where only a NEW scan can find the company as current.
test('no valid event date (missing, invalid, future): research only, and widening is never offered as a cure', () => {
  const cases = [
    { review_reason: 'outside_window_undated', window_held: true, event_date: null },
    { review_reason: 'outside_window_undated' }, // date facts not supplied: the reason alone says undated
    { review_reason: 'event_date_bad_date', window_held: true, event_date: '2026-02-30' },
    { review_reason: 'event_date_future_date', window_held: true, event_date: '2027-01-15' },
    { review_reason: 'quote_unconfirmed', window_held: true, event_date: '' },
  ]
  for (const c of cases) {
    const a = act(c)
    assert.equal(a.label, 'Keep as research', JSON.stringify(c))
    assert.match(a.hint, /no valid event date \(missing, invalid or in the future\), so it stays out of drafting\. A wider time window does not change that\./)
    assert.doesNotMatch(a.hint.replace('A wider time window does not change that.', ''), NO_WIDEN, 'no widening advice')
  }
})

test('a valid date older than the window: research only for this lead; only a NEW scan with a wider window, at the usual budget', () => {
  for (const c of [{ review_reason: 'outside_window', window_held: true, event_date: '2025-01-10' }, { review_reason: 'outside_window' }, { review_reason: 'quote_unconfirmed', window_held: true, event_date: '2025-06-01' }]) {
    const a = act(c)
    assert.equal(a.label, 'Keep as research')
    assert.match(a.hint, /older than the time window you asked for, so it stays out of drafting\. Confirming does not change that for this lead; only a new scan with a wider window can find it as current \(it uses your usual scan budget\)\./)
    assert.doesNotMatch(a.hint, /Widen the window to draft it/)
  }
})

test('held but the date is not known here: safe common wording, no claimed cure', () => {
  const a = act({ review_reason: 'quote_unconfirmed', window_held: true })
  assert.equal(a.label, 'Keep as research')
  assert.equal(a.hint, 'Moves it to your list as confirmed by you, as research only: it is outside the time window you asked for, so it stays out of drafting.')
})

test('not held: date problems vouch for the date; others are confirmed by you, never source-checked', () => {
  for (const r of ['event_timing_unconfirmed', 'event_date_bad_date', 'event_date_stale', 'event_date_future_date']) {
    const a = act({ review_reason: r, window_held: false, event_date: '2026-10-01' })
    assert.equal(a.label, 'I checked the date - use it')
    assert.match(a.hint, /can be drafted\. dazl has not verified the date or current need; you are vouching for it\./)
  }
  for (const r of ['quote_unconfirmed', 'source_review_required', 'location_unconfirmed', null]) {
    const a = act({ review_reason: r, window_held: false })
    assert.equal(a.label, 'I checked the source - use it')
    assert.match(a.hint, /confirmed by you \(never shown as source-checked\), and it can be drafted\. The other draft checks still apply\./)
  }
})
