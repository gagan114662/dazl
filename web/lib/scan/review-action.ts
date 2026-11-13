// The confirm action on a "Needs your review" card, worded for what confirming actually does for THIS lead (the
// server rules in lib/scan/review-confirm.ts and lib/outreach/currentness.ts): confirming records that the user checked
// the source and makes the lead draft-eligible as "confirmed by you" - except that a time-window hold survives it.
// Under a window only a valid, non-future event date inside it is actionable (windowStatus, lib/scan/window.ts), so:
//   - no valid date (missing, invalid or in the future): research only, and no window ever changes that;
//   - a valid date older than the window: research only for THIS lead; only a NEW scan with a wider window can find it
//     as current (window-notice.ts: "a new scan uses your usual scan budget");
//   - held but the date facts are not known here: safe common wording, no claimed cure.
// A hold no check can change (someone else's customer, a different place, a closed opening - uncheckableCause in lib/lead-state.ts) is research only too, the same
// classification the home journey shows (#352): confirming keeps it for reading and the draft gate keeps it out of drafting. So is a REQUIRED check that could
// not run (sales_hiring_check_failed): requiredGateHeld (lib/scan/held-state.ts) holds it whatever the user confirms, until the check runs again and passes.
// Pure and client-safe.
import { windowStatus } from './window.ts'
import { uncheckableCause, CAUSE_TEXT, REQUIRED_GATE_REASONS } from '../lead-state.ts'

const DATE = new Set(['event_timing_unconfirmed', 'event_date_bad_date', 'event_date_stale', 'event_date_future_date'])

export interface ReviewAction { label: string; hint: string }
export interface ReviewLead { review_reason?: string | null; window_held?: boolean; gate_held?: boolean; event_date?: string | null }

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
  // A REQUIRED check that has not passed is named first, whatever else holds the lead (#1062, Hermes-PC review): a wider-window
  // scan alone cannot release it, so the window is only ever mentioned alongside it, never as the way out.
  const failedRun = REQUIRED_GATE_REASONS.has(l.review_reason ?? '')   // the check could not run (its stored reason)
  if (failedRun || l.gate_held) {
    const gate = failedRun ? 'the required sales-hiring check could not run' : 'a required check (the sales-hiring proof) has not passed'
    const window = kind === 'no_date' ? ' It also has no valid event date, which a wider time window does not change.'
      : kind === 'older' ? ' Its event date is also older than the time window you asked for.'
      : kind === 'unknown' ? ' It is also outside the time window you asked for.' : ''
    return { label: 'Keep as research', hint: `${RESEARCH}: ${gate}, which checking the source cannot change, so it stays out of drafting.${window} Only running the scan again, with the check passing${kind === 'older' || kind === 'unknown' ? ' and the event inside your window' : ''}, can make it usable.` }
  }
  if (kind === 'no_date') return { label: 'Keep as research', hint: `${RESEARCH}: it has no valid event date (missing, invalid or in the future), so it stays out of drafting. A wider time window does not change that.` }
  if (kind === 'older') return { label: 'Keep as research', hint: `${RESEARCH}: its event date is older than the time window you asked for, so it stays out of drafting. Confirming does not change that for this lead; only a new scan with a wider window can find it as current (it uses your usual scan budget).` }
  if (kind === 'unknown') return { label: 'Keep as research', hint: `${RESEARCH}: it is outside the time window you asked for, so it stays out of drafting.` }
  const cause = uncheckableCause(l.review_reason)
  if (cause) return { label: 'Keep as research', hint: `${RESEARCH}: ${CAUSE_TEXT[cause]}, which checking the source cannot change, so it stays out of drafting.` }
  // #390: a first-party signal has no third-party source to check (it is the tenant's own signed, consented event) and
  // no stored contact (the submitter's email is never kept). Confirming keeps it in the list; it does not identify a
  // person and promises no draft.
  if (l.review_reason === 'first_party_signal') return {
    label: 'Keep this signal',
    hint: 'Keeps it in your list as confirmed by you. It came from your own site or form (signed, consent recorded); an account-level visit does not identify a person, and no contact is stored with it, so this signal alone cannot be drafted.',
  }
  if (DATE.has(l.review_reason ?? '')) return {
    label: 'I checked the date - use it',
    hint: 'Moves it to your list as confirmed by you, and it can be drafted. dazl has not verified the date or current need; you are vouching for it.',
  }
  return {
    label: 'I checked the source - use it',
    hint: 'Moves it to your list as confirmed by you (never shown as source-checked), and it can be drafted. The other draft checks still apply.',
  }
}
