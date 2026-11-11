// Which held leads a person's check can still change, and which are research only. Pure and read-only; it never
// loosens a gate. A lead is "review" exactly when confirming it after a look at the source makes it draftable as
// "confirmed by you" - the same action the Leads view offers for it (lib/scan/review-action.ts) and the same verdict the
// draft gate reaches (currentnessHeld, lib/outreach/currentness.ts). Everything the user cannot change by checking - a
// time-window hold (undated or older than the window), someone else's customer, a different place, a closed opening, a
// required check that could not run - is "research": kept for reading, never counted as reviewable, and never offered a
// "widen the window" fix unless a dated lead was only too old. Unknown reasons fail closed to research.
import { heldReason, type PreviewLead } from './journey.ts'

export type HeldState = 'review' | 'research' | 'rejected'
export type ResearchCause = 'undated' | 'older' | 'customer' | 'place' | 'closed' | 'unsupported'

// A person's check of the source can turn these into a usable lead (#352: Home, the Leads view and the draft gate agree):
//   - dazl could not read or check the page: quote_unconfirmed, blocked_by_site, needs_javascript, login_required, location_unconfirmed;
//   - the evidence a person can affirm by reading the source: no_event_evidence, no_sales_hiring_evidence, source_review_required, self_description,
//     trial_budget_reached (found before a free scan's checks ran out), legacy_currentness_review;
//   - a date a person can vouch for ("I checked the date - use it"): event_timing_unconfirmed, event_date_bad_date, event_date_future_date, event_date_stale.
// Under a time window none of them is reviewable: the window hold survives confirmation (researchCause gives undated / older).
export const REVIEWABLE: ReadonlySet<string> = new Set(['quote_unconfirmed', 'blocked_by_site', 'needs_javascript', 'login_required', 'location_unconfirmed',
  'no_event_evidence', 'no_sales_hiring_evidence', 'source_review_required', 'self_description', 'trial_budget_reached', 'legacy_currentness_review',
  'event_timing_unconfirmed', 'event_date_bad_date', 'event_date_future_date', 'event_date_stale',
  'first_party_signal']) // #390: the tenant's own signed, consented event; the owner reviews it like any held lead (other gates still apply)
// A REQUIRED check that could not run (lib/scan/held-state.ts requiredGateHeld): no confirmation clears it, only the check running again and passing.
export const REQUIRED_GATE_REASONS: ReadonlySet<string> = new Set(['sales_hiring_check_failed'])
const CAUSE: Record<string, ResearchCause> = {
  outside_window_undated: 'undated', event_timing_unconfirmed: 'undated', event_date_bad_date: 'undated', event_date_future_date: 'undated',
  outside_window: 'older', event_date_stale: 'older',
  counterparty_signal: 'customer', location_mismatch: 'place', job_closed: 'closed', sales_hiring_check_failed: 'unsupported',
}
// Every hold reason a review lead can carry, as one of: reviewable (above), a hold no check can change, or a time-window hold. A new reason must be
// added to exactly one of them (test/lead-state.test.ts pins this against the Leads view's reason labels), or it fails closed to research on Home.
export const RESEARCH_REASONS: ReadonlySet<string> = new Set(['outside_window', 'outside_window_undated', 'counterparty_signal', 'location_mismatch', 'job_closed', ...REQUIRED_GATE_REASONS])

// Held for a fact about the evidence itself - someone else's customer, a different place, a closed opening. A person's check of the source cannot change it, so a lead
// confirmed out of one of these stays research: never offered as draftable (lib/scan/review-action.ts) and never draftable (currentnessHeld, lib/outreach/currentness.ts).
const UNCHECKABLE = new Set(['counterparty_signal', 'location_mismatch', 'job_closed'])
export function uncheckableCause(reason: string | null | undefined): ResearchCause | null {
  return reason && UNCHECKABLE.has(reason) ? CAUSE[reason] : null
}

export function researchCause(l: PreviewLead & { review_reason?: string | null }): ResearchCause {
  const r = l.review_reason ?? ''
  const date = l.event_date ?? ''
  // A date problem outranks any other reason: a blocked page with no usable date is still undated research.
  if (r === 'outside_window_undated' || (l.window_held && !date)) return 'undated'
  if (Object.hasOwn(CAUSE, r)) return CAUSE[r]   // own keys only: a reason like 'constructor' is unknown, not Object's constructor
  if (l.window_held) return 'older'
  if (l.currentness_held || !date || l.date_status !== 'verified') return 'undated'
  return 'unsupported'
}

// A lead in the review list (it carries a review_reason): can a person's check of the source still make it usable? The ONE verdict Home's
// journey (heldState), the Campaigns funnel, a campaign's page and the Home checklist all count by (#683), so no page calls a research-only
// lead a review item. A time-window hold survives confirmation; an unknown, empty or non-string reason fails closed to research.
export function reviewIsActionable(l: { review_reason?: unknown; window_held?: unknown }): boolean {
  const r = l.review_reason
  return typeof r === 'string' && REVIEWABLE.has(r) && !l.window_held
}

export function heldState(l: PreviewLead & { review_reason?: string | null }): { state: HeldState; cause: ResearchCause | null } | null {
  const why = heldReason(l)
  if (!why) return null
  if (why === 'rejected') return { state: 'rejected', cause: null }
  const r = l.review_reason ?? ''
  const cause = researchCause(l)
  // A hold a look at the source can resolve is reviewable unless a time window holds the lead: confirming lifts the first, never the second.
  if (reviewIsActionable(l)) return { state: 'review', cause: null }
  if (!r && why === 'company website not confirmed') return { state: 'review', cause: null }
  return { state: 'research', cause }
}

// What the scan's bounded automatic recovery pass (lib/scan/blocked-fallback.ts) already did for a held lead, read from the `scan:recovery` record it writes on every
// target it could not rescue. `ran`: other press was searched for the same company and nothing verified; otherwise the pass did not run, and why. No record: the lead was
// not a recovery target (or predates the pass). Display only: it changes no state and never makes a lead ready.
export const CAUSE_TEXT: Record<ResearchCause, string> = {
  undated: 'no usable event date', older: 'event older than your time window', customer: "only another company's page names it, as their customer",
  place: 'evidence names a different place', closed: 'the opening is closed', unsupported: 'evidence not verified',
}
const LOOKED_FOR: Record<string, string> = { undated: 'a dated source', quote_unconfirmed: 'a page that carries the quote', counterparty_signal: 'a source about the company itself', blocked_by_site: 'a readable source', needs_javascript: 'a readable source' }
const NOT_RUN: Record<string, string> = { 'the run disabled the paid fallback': 'this run allowed no extra search', 'news search is off': 'news search is off', 'no model for this run': 'no model was available for this run' }
export interface RecoveryNote { ran: boolean; text: string }
export function recoveryNote(l: { enrichments?: { connector: string; label: string | null; value: string }[] | null }): RecoveryNote | null {
  const r = (l.enrichments ?? []).find(e => e.connector === 'scan:recovery')
  if (!r) return null
  const reason = (r.label ?? '').replace(/^recovery:/, '')
  if (/^Recovery pass ran\b/.test(r.value)) return { ran: true, text: `dazl already searched other press for ${Object.hasOwn(LOOKED_FOR, reason) ? LOOKED_FOR[reason] : 'another source'}; none verified.` }
  const why = /^Recovery pass did not run \((.*)\)/.exec(r.value)?.[1] ?? ''
  return { ran: false, text: `dazl did not search other sources for it: ${Object.hasOwn(NOT_RUN, why) ? NOT_RUN[why] : 'the search was not available for this run'}.` }
}
