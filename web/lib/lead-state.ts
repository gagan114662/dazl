// Which held leads a person's check can still change, and which are research only. Pure and read-only; it never
// loosens a gate. A lead is "review" only when looking at its source can resolve the hold (the quote or page could not
// be checked by dazl, or the company website needs confirming). Everything the user cannot change by checking - no
// usable event date, older than the window, someone else's customer, a different place, a closed opening - is
// "research": kept for reading, never counted as reviewable, and never offered a "widen the window" fix unless a dated
// lead was only too old. Unknown reasons fail closed to research.
import { heldReason, type PreviewLead } from './journey.ts'

export type HeldState = 'review' | 'research' | 'rejected'
export type ResearchCause = 'undated' | 'older' | 'customer' | 'place' | 'closed' | 'unsupported'

// A person's check of the source can turn these into a usable lead.
const REVIEWABLE = new Set(['quote_unconfirmed', 'blocked_by_site', 'needs_javascript', 'login_required', 'location_unconfirmed'])
const CAUSE: Record<string, ResearchCause> = {
  outside_window_undated: 'undated', event_timing_unconfirmed: 'undated', event_date_bad_date: 'undated', event_date_future_date: 'undated',
  outside_window: 'older', event_date_stale: 'older',
  counterparty_signal: 'customer', location_mismatch: 'place', job_closed: 'closed',
}

export function researchCause(l: PreviewLead & { review_reason?: string | null }): ResearchCause {
  const r = l.review_reason ?? ''
  const date = l.event_date ?? ''
  // A date problem outranks any other reason: a blocked page with no usable date is still undated research.
  if (r === 'outside_window_undated' || (l.window_held && !date)) return 'undated'
  if (CAUSE[r]) return CAUSE[r]
  if (l.window_held) return 'older'
  if (l.currentness_held || !date || l.date_status !== 'verified') return 'undated'
  return 'unsupported'
}

export function heldState(l: PreviewLead & { review_reason?: string | null }): { state: HeldState; cause: ResearchCause | null } | null {
  const why = heldReason(l)
  if (!why) return null
  if (why === 'rejected') return { state: 'rejected', cause: null }
  const r = l.review_reason ?? ''
  const cause = researchCause(l)
  // Only a hold that a look at the source can resolve, on a lead whose date facts already stand, is reviewable.
  if (REVIEWABLE.has(r) && cause === 'unsupported') return { state: 'review', cause: null }
  if (!r && why === 'company website not confirmed') return { state: 'review', cause: null }
  return { state: 'research', cause }
}
