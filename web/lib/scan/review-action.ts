// The confirm action on a "Needs your review" card, worded for what confirming actually does for THIS lead (the
// server rules in lib/scan/review-confirm.ts and lib/outreach/currentness.ts): confirming records that the user checked
// the source and makes the lead draft-eligible as "confirmed by you" - except that a time-window hold survives it.
// Under a window only a valid, non-future event date inside it is actionable (windowStatus, lib/scan/window.ts), so:
//   - no valid date (missing, invalid or in the future): research only, and no window ever changes that;
//   - a valid date older than the window: research only for THIS lead; only a NEW scan with a wider window can find it
//     as current (window-notice.ts: "a new scan uses your usual scan budget");
//   - held but the date facts are not known here: safe common wording, no claimed cure.
// Pure and client-safe.
import { windowStatus } from './window.ts'

const DATE = new Set(['event_timing_unconfirmed', 'event_date_bad_date', 'event_date_stale', 'event_date_future_date'])

export interface ReviewAction { label: string; hint: string }
export interface ReviewLead { review_reason?: string | null; window_held?: boolean; event_date?: string | null }

type Held = 'no_date' | 'older' | 'unknown'
function heldKind(l: ReviewLead, now: Date): Held | null {
  const r = l.review_reason ?? ''
  if (r === 'outside_window_undated') return 'no_date'
  const held = !!l.window_held || r === 'outside_window'
  if (!held) return null
  if (l.event_date === undefined) return r === 'outside_window' ? 'older' : 'unknown' // date not supplied: trust the reason only
  // The same date test the window gate uses: missing, invalid or future is never inside any window.
  const s = windowStatus(l.event_date, 365, now)
  return s === 'undated' || s === 'invalid' || s === 'future' ? 'no_date' : 'older'
}

const RESEARCH = 'Moves it to your list as confirmed by you, as research only'

export function reviewAction(l: ReviewLead, now: Date = new Date()): ReviewAction {
  const kind = heldKind(l, now)
  if (kind === 'no_date') return { label: 'Keep as research', hint: `${RESEARCH}: it has no valid event date (missing, invalid or in the future), so it stays out of drafting. A wider time window does not change that.` }
  if (kind === 'older') return { label: 'Keep as research', hint: `${RESEARCH}: its event date is older than the time window you asked for, so it stays out of drafting. Confirming does not change that for this lead; only a new scan with a wider window can find it as current (it uses your usual scan budget).` }
  if (kind === 'unknown') return { label: 'Keep as research', hint: `${RESEARCH}: it is outside the time window you asked for, so it stays out of drafting.` }
  if (DATE.has(l.review_reason ?? '')) return {
    label: 'I checked the date - use it',
    hint: 'Moves it to your list as confirmed by you, and it can be drafted. dazl has not verified the date or current need; you are vouching for it.',
  }
  return {
    label: 'I checked the source - use it',
    hint: 'Moves it to your list as confirmed by you (never shown as source-checked), and it can be drafted. The other draft checks still apply.',
  }
}
