// #1910 offline slice, the seam between the two gates. lib/lead-state.ts decides whether a held lead is offered to a
// person's check; lib/outreach/currentness.ts decides whether dazl may draft it. currentnessHeld's review branch is
// exactly uncheckableCause(review_reason) || uncheckableCause(human_confirmed_from), and its window branch is
// windowHeld, so those two pure functions are where the gates must agree. If they disagree, dazl either offers a check
// that cannot unlock a draft, or drafts a lead its own page called research only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { REVIEWABLE, RESEARCH_REASONS, reviewIsActionable, uncheckableCause } from '../lib/lead-state.ts'
import { windowHeld } from '../lib/outreach/currentness.ts'

test('#1910 a hold the page offers to confirm is never a research hold for the draft gate, before or after confirming', () => {
  for (const reason of [...REVIEWABLE]) {
    assert.equal(reviewIsActionable({ review_reason: reason }), true, `${reason} is offered to the user`)
    assert.equal(uncheckableCause(reason), null, `${reason} is not research-only on the page`)
    // Confirming writes the same reason into human_confirmed_from, which the draft gate reads too.
    assert.equal(uncheckableCause(reason), null, `${reason} stays confirmable once it is the confirmation's source`)
  }
})

// A window hold is research for the other reason: currentnessHeld holds it through windowHeld, not through
// uncheckableCause. The draft gate's two branches are exactly those, so a research reason must trip one of them.
const NOW = new Date('2026-11-26T12:00:00Z')
const WINDOW = JSON.stringify({ window_days: 30 })
const dateFor = (reason: string): string | null =>
  reason.includes('undated') ? null : reason.includes('future') ? '2027-03-01' : reason.includes('stale') || reason.includes('outside_window') ? '2026-06-01' : '2026-11-20'
const heldByWindow = (reason: string) => windowHeld({ event_date: dateFor(reason), icp: WINDOW, query: null }, NOW)
const heldForDraft = (reason: string) => uncheckableCause(reason) !== null || heldByWindow(reason)

test('#1910 a research hold is one the draft gate holds, so confirming it can never make it draftable', () => {
  for (const reason of [...RESEARCH_REASONS]) {
    assert.equal(heldForDraft(reason), true, `${reason} holds the draft even after confirmation`)
    assert.equal(reviewIsActionable({ review_reason: reason }), false, `${reason} is not offered as confirmable`)
  }
})

test('#1910 the user window beats any confirmation: stale, undated and future rows are held', () => {
  const now = new Date('2026-11-26T12:00:00Z')
  const row = (event_date: string | null) => ({ event_date, icp: WINDOW, query: null })
  assert.equal(windowHeld(row('2026-11-20'), now), false, 'five days old is inside a 30-day window')
  assert.equal(windowHeld(row('2026-06-01'), now), true, 'stale is held whatever a person confirmed')
  assert.equal(windowHeld(row(null), now), true, 'undated is held')
  assert.equal(windowHeld(row('2027-03-01'), now), true, 'future is held')
  assert.equal(windowHeld(row('not a date'), now), true, 'unreadable is held')
})

test('#1910 a broken saved window fails closed instead of opening the draft gate', () => {
  const now = new Date('2026-11-26T12:00:00Z')
  assert.equal(windowHeld({ event_date: '2026-11-20', icp: '{not json', query: null }, now), true)
  assert.equal(windowHeld({ event_date: '2026-11-20', icp: JSON.stringify({ window_days: 0 }), query: null }, now), true)
})

const shapes: { query: string; held: string[] }[] = [
  { query: 'Dentists in Mississauga', held: ['quote_unconfirmed', 'blocked_by_site', 'location_mismatch', 'outside_window_undated'] },
  { query: 'Commercial cleaning in Toronto', held: ['no_sales_hiring_evidence', 'sales_hiring_check_failed', 'counterparty_signal', 'job_closed'] },
  { query: 'Marketing agencies in Austin', held: ['event_date_future_date', 'event_date_stale', 'job_role_mismatch', 'needs_javascript'] },
]

for (const shape of shapes) {
  test(`#1910 ${shape.query}: the page's verdict and the draft gate's verdict are the same verdict`, () => {
    for (const reason of shape.held) {
      // The page knows the window verdict too (window_held), so the exact agreement is: the page offers a check for this
      // lead exactly when the draft gate will not hold it - no unchangeable fact and no surviving window.
      const confirmable = reviewIsActionable({ review_reason: reason, window_held: heldByWindow(reason) })
      assert.equal(confirmable, !heldForDraft(reason), `${reason}: offered to confirm exactly when a draft can follow`)
    }
  })
}
