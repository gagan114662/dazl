// The confirm action on a "Needs your review" card, worded for what confirming actually does for THIS lead (the
// server rules in lib/scan/review-confirm.ts and lib/outreach/currentness.ts): confirming records that the user checked
// the source and makes the lead draft-eligible as "confirmed by you" - except that a time-window hold survives it, so a
// lead outside (or undatable inside) the window the user asked for stays research only. Pure and client-safe.

const WINDOW = new Set(['outside_window', 'outside_window_undated'])
const DATE = new Set(['event_timing_unconfirmed', 'event_date_bad_date', 'event_date_stale', 'event_date_future_date'])

export interface ReviewAction { label: string; hint: string }

export function reviewAction(reason: string | null | undefined, windowHeld = false): ReviewAction {
  if (windowHeld || WINDOW.has(reason ?? '')) return {
    label: 'Keep as research',
    hint: 'Moves it to your list as confirmed by you, as research only: it stays out of drafting because its date is not inside the time window you asked for. Widen the window to draft it.',
  }
  if (DATE.has(reason ?? '')) return {
    label: 'I checked the date - use it',
    hint: 'Moves it to your list as confirmed by you, and it can be drafted. dazl has not verified the date or current need; you are vouching for it.',
  }
  return {
    label: 'I checked the source - use it',
    hint: 'Moves it to your list as confirmed by you (never shown as source-checked), and it can be drafted. The other draft checks still apply.',
  }
}
