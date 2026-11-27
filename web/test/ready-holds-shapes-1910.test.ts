// #1910 offline slice, holds half. When a lead is not ready, lib/lead-state.ts decides whether a person's check of the
// source can make it ready ("review") or whether no check can ("research"). Getting that split wrong costs Ready leads
// both ways: a research-only hold offered as confirmable, or a confirmable one counted as unreachable. The reasons here
// are the ones the three prod shapes actually produced.
import test from 'node:test'
import assert from 'node:assert/strict'
import { REVIEWABLE, RESEARCH_REASONS, reviewIsActionable } from '../lib/lead-state.ts'

// What the three shapes hit in production: a page that would not load, a quote nobody could line up, a clinic in the
// wrong place, a posting that is already closed, a required check that could not run, an old dated opening.
const shapes: { query: string; held: string[] }[] = [
  { query: 'Dentists in Mississauga', held: ['quote_unconfirmed', 'blocked_by_site', 'location_mismatch', 'outside_window_undated'] },
  { query: 'Commercial cleaning in Toronto', held: ['no_sales_hiring_evidence', 'sales_hiring_check_failed', 'counterparty_signal', 'job_closed'] },
  { query: 'Marketing agencies in Austin', held: ['event_date_future_date', 'event_date_stale', 'job_role_mismatch', 'needs_javascript'] },
]

for (const shape of shapes) {
  test(`#1910 ${shape.query}: every hold is either confirmable by a person or research only, never both, never neither`, () => {
    for (const reason of shape.held) {
      const review = REVIEWABLE.has(reason)
      const research = RESEARCH_REASONS.has(reason)
      assert.equal(review || research, true, `${reason} is classified`)
      assert.equal(review && research, false, `${reason} is not in both sets`)
      assert.equal(reviewIsActionable({ review_reason: reason }), review, `${reason} is offered a check exactly when a check can clear it`)
    }
  })
}

test('#1910 a confirmable hold stops being actionable when the window, a required check or the buyer survives confirmation', () => {
  for (const reason of [...REVIEWABLE])
    for (const block of ['window_held', 'gate_held', 'buyer_unreachable'])
      assert.equal(reviewIsActionable({ review_reason: reason, [block]: true }), false, `${reason} with ${block} is not confirmable`)
})

test('#1910 a research hold is never actionable, whatever else is set on the lead', () => {
  for (const reason of [...RESEARCH_REASONS])
    for (const lead of [{ review_reason: reason }, { review_reason: reason, buyer_unreachable: true }, { review_reason: reason, gate_held: 1 }])
      assert.equal(reviewIsActionable(lead), false, `${reason} never becomes actionable`)
})

test('#1910 an unknown or missing reason fails closed to research', () => {
  for (const reason of [null, undefined, '', 'a_reason_from_the_future'])
    assert.equal(reviewIsActionable({ review_reason: reason }), false)
})

test('#1910 the required sales-hiring check is research, not something a person can confirm away', () => {
  for (const reason of ['sales_hiring_check_failed'])
    assert.equal(REVIEWABLE.has(reason), false, `${reason} cannot be cleared by reading the source`)
})
