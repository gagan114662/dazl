// Which held leads a person's check can still change, and which are research only. Pure and read-only; it never
// loosens a gate. A lead is "review" exactly when confirming it after a look at the source makes it draftable as
// "confirmed by you" - the same action the Leads view offers for it (lib/scan/review-action.ts) and the same verdict the
// draft gate reaches (currentnessHeld, lib/outreach/currentness.ts). Everything the user cannot change by checking - a
// time-window hold (undated or older than the window), someone else's customer, a different place, a closed opening, a
// required check that could not run - is "research": kept for reading, never counted as reviewable, and never offered a
// "widen the window" fix unless a dated lead was only too old. Unknown reasons fail closed to research.
import { heldReason, NO_OWN_BUYER, type PreviewLead } from './journey.ts'
import { reviewCanNameBuyer } from './people/buyer-reach.ts'
import { discoverReady, discoverState, isDiscoverLead } from './discover/card.ts'

export function isUnconfirmedTimingResearch(lead: {
  timing?: string | null
  review_reason?: string | null
  quarantined_at?: unknown
  human_confirmed_at?: number | null
}): boolean {
  return lead.timing === 'unconfirmed' && !lead.review_reason && !lead.quarantined_at && lead.human_confirmed_at == null
}

export type HeldState = 'review' | 'research' | 'rejected'
// unfit, contact: discovery leads only (lib/discover/card.ts discoverState 'research' not for its date, and 'no_contact')
export type ResearchCause = 'undated' | 'older' | 'customer' | 'place' | 'closed' | 'unsupported' | 'need' | 'unfit' | 'contact'

// A person's check of the source can turn these into a usable lead (#352: Home, the Leads view and the draft gate agree):
//   - dazl could not read or check the page: quote_unconfirmed, blocked_by_site, needs_javascript, login_required, location_unconfirmed;
//   - the evidence a person can affirm by reading the source: no_event_evidence, no_sales_hiring_evidence, source_review_required, self_description,
//     trial_budget_reached (found before a free scan's checks ran out), legacy_currentness_review;
//   - a date a person can vouch for ("I checked the date - use it"): event_timing_unconfirmed, event_date_bad_date, event_date_future_date, event_date_stale;
//   - research_unverified (written by the research engine, deleted in #1393; kept so rows it wrote still read right): the event's quote is literally on the cited page and the
//     second model supported it, and the place and category passed the gate; what is not proven is the day on that page or a named decision-maker,
//     both of which a person reads off the same source. Confirming it is the same act as for event_timing_unconfirmed.
// Under a time window none of them is reviewable: the window hold survives confirmation (researchCause gives undated / older).
export const REVIEWABLE: ReadonlySet<string> = new Set(['quote_unconfirmed', 'blocked_by_site', 'needs_javascript', 'login_required', 'location_unconfirmed',
  'no_event_evidence', 'no_sales_hiring_evidence', 'source_review_required', 'self_description', 'trial_budget_reached', 'legacy_currentness_review',
  'event_timing_unconfirmed', 'event_date_bad_date', 'event_date_future_date', 'event_date_stale', 'research_unverified',
  'first_party_signal']) // #390: the tenant's own signed, consented event; the owner reviews it like any held lead (other gates still apply)
// A REQUIRED check that could not run (lib/scan/held-state.ts requiredGateHeld): no confirmation clears it, only the check running again and passing.
export const REQUIRED_GATE_REASONS: ReadonlySet<string> = new Set(['sales_hiring_check_failed'])
const CAUSE: Record<string, ResearchCause> = {
  outside_window_undated: 'undated', event_timing_unconfirmed: 'undated', event_date_bad_date: 'undated', event_date_future_date: 'undated',
  outside_window: 'older', event_date_stale: 'older',
  public_sector_non_buyer: 'unfit', counterparty_signal: 'customer', location_mismatch: 'place', job_closed: 'closed', sales_hiring_check_failed: 'unsupported', posting_not_specific: 'unsupported', job_role_mismatch: 'unsupported',
}
// Every hold reason a review lead can carry, as one of: reviewable (above), a hold no check can change, or a time-window hold. A new reason must be
// added to exactly one of them (test/lead-state.test.ts pins this against the Leads view's reason labels), or it fails closed to research on Home.
export const RESEARCH_REASONS: ReadonlySet<string> = new Set(['outside_window', 'outside_window_undated', 'public_sector_non_buyer', 'counterparty_signal', 'location_mismatch', 'job_closed', 'posting_not_specific', 'job_role_mismatch', ...REQUIRED_GATE_REASONS])

// Held for a fact about the evidence itself - someone else's customer, a different place, a closed opening, or a failed
// REQUIRED check (sales_hiring_check_failed, #683 round 2). A person's check of the source cannot change any of these, so
// a lead confirmed out of one stays research: never offered as draftable (lib/scan/review-action.ts) and never draftable
// (currentnessHeld, lib/outreach/currentness.ts).
const UNCHECKABLE = new Set(['public_sector_non_buyer', 'counterparty_signal', 'location_mismatch', 'job_closed', 'posting_not_specific', 'job_role_mismatch', ...REQUIRED_GATE_REASONS])
export function uncheckableCause(reason: string | null | undefined): ResearchCause | null {
  return reason && UNCHECKABLE.has(reason) ? CAUSE[reason] : null
}

export function researchCause(l: PreviewLead & { review_reason?: string | null }): ResearchCause {
  const r = l.review_reason ?? ''
  const date = l.event_date ?? ''
  // A date problem outranks any other reason: a blocked page with no usable date is still undated research.
  if (r === 'outside_window_undated' || (l.window_held && !date)) return 'undated'
  if (Object.hasOwn(CAUSE, r)) return CAUSE[r]   // own keys only: a reason like 'constructor' is unknown, not Object's constructor
  if (l.gate_held) return CAUSE.sales_hiring_check_failed   // #1062: a required check that has not passed, whatever reviewable reason the row carries
  if (l.window_held) return 'older'
  if (!date || l.day_verified !== true) return 'undated'   // #1176: the card's proof (day_verified), not the retired date_status 'verified'; no flag fails closed
  // #1176 reader 2 (prod 2121e61c: "Zayed Law: no usable event date." beside a card that says "verified on the cited source"): the day IS proven.
  // What still holds the lead is the timing gate (currentnessHeld -> timingProofGap: domain, named person, route or record not all confirmed by the
  // machine, and no confirmation by the user). It stays research, as the Leads card says ("Quote-backed research only"); only its words change.
  if (l.currentness_held) return 'need'
  // #1037: dated, sourced and otherwise ready; only the buyer the company's own site must name is missing - the rest of the lead is not confirmed yet
  if (heldReason(l) === NO_OWN_BUYER) return 'need'
  return 'unsupported'
}

// A lead in the review list (it carries a review_reason): can a person's check of the source still make it usable? The ONE verdict Home's
// journey (heldState), the Campaigns funnel, a campaign's page and the Home checklist all count by (#683), so no page calls a research-only
// lead a review item. A time-window hold survives confirmation; an unknown, empty or non-string reason fails closed to research.
// A REQUIRED check that has not passed (gate_held: lib/scan/held-state.ts requiredGateHeld, the draft guard's own verdict) survives it too (#1062).
// buyer_unreachable (#1037): no review can give the lead its buyer (lib/people/buyer-reach.ts) - confirming the source does not make it ready.
export function reviewIsActionable(l: { review_reason?: unknown; window_held?: unknown; gate_held?: unknown; buyer_unreachable?: unknown }): boolean {
  const r = l.review_reason
  return typeof r === 'string' && REVIEWABLE.has(r) && !l.window_held && !l.gate_held && !l.buyer_unreachable
}

export function heldState(l: PreviewLead & { review_reason?: string | null; human_confirmed_from?: string | null }): { state: HeldState; cause: ResearchCause | null } | null {
  // A discovery lead has ONE state (lib/discover/card.ts discoverState); the rules below are the older engine's and are not read for it.
  // The cause only picks the words shown beside a held lead; it decides nothing.
  if (isDiscoverLead(l as { source_kind?: string | null })) {
    const s = discoverState(l as never)
    if (discoverReady(s)) return null
    if (s === 'rejected' || s === 'review') return { state: s, cause: null }
    if (s === 'no_contact') return { state: 'research', cause: 'contact' }
    const confirmedHold = uncheckableCause(l.human_confirmed_from)
    return { state: 'research', cause: confirmedHold ?? (!l.event_date ? 'undated' : l.gate_held ? 'unsupported' : 'unfit') }
  }
  const why = heldReason(l)
  if (!why) return null
  if (why === 'rejected') return { state: 'rejected', cause: null }
  const r = l.review_reason ?? ''
  const cause = researchCause(l)
  // A hold a look at the source can resolve is reviewable unless a time window holds the lead: confirming lifts the first, never the second.
  // #1037: and only when a review can still give the lead its buyer (lib/people/buyer-reach.ts); otherwise no check can make it ready
  const buyer_unreachable = !reviewCanNameBuyer({ id: l.id, contact: l.contact }, l.enrichments ?? [])
  if (reviewIsActionable({ ...l, buyer_unreachable })) return { state: 'review', cause: null }
  if (!r && why === 'company website not confirmed' && !buyer_unreachable) return { state: 'review', cause: null }
  return { state: 'research', cause }
}

// What the scan's bounded automatic recovery pass (lib/scan/blocked-fallback.ts) already did for a held lead, read from the `scan:recovery` record it writes on every
// target it could not rescue. `ran`: other press was searched for the same company and nothing verified; otherwise the pass did not run, and why. No record: the lead was
// not a recovery target (or predates the pass). Display only: it changes no state and never makes a lead ready.
export const CAUSE_TEXT: Record<ResearchCause, string> = {
  undated: 'no usable event date', older: 'event older than your time window', customer: "only another company's page names it, as their customer",
  place: 'evidence names a different place', closed: 'the opening is closed', unsupported: 'evidence not verified',
  need: 'event day verified on the cited source; the rest of the lead is not confirmed yet',
  unfit: 'graded as not a fit for your profile', contact: 'proof found, but no contact found yet',
}
// Home's one-line reason under "Nothing ready - the leads found are research only". It used to say for every such play that none has
// verified, dated evidence - false when a lead's day IS verified and only the rest of the lead is not (#1176 reader 2).
export function researchHint(causes: ResearchCause[]): string {
  const need = causes.filter(c => c === 'need').length
  if (causes.length > 0 && causes.every(c => c === 'unfit')) return 'They were graded as not a fit for your profile, so reviewing them cannot make them ready.'
  if (need === 0) return 'None has verified, dated evidence of its own event, so reviewing them cannot make them ready.'
  return `${need === causes.length ? (need === 1 ? 'Its event day is' : 'Their event days are') : `For ${need} of them the event day is`} verified on the cited source, but the rest of the lead is not confirmed yet. Each lead's reason is below.`
}
// Home's "N research only" chip explains the WHOLE group in its InfoTip. It used to give one fixed list of reasons ("No verified, dated event, outside your
// time window, or someone else's customer") for every lead in it - false for a lead whose day IS verified and that only the timing gate holds (#1176, the
// prod live check of 66449147: Zayed Law and Ogletree Deakins under that sentence). It now names the causes the group really has, in the per-lead lines' own words.
const CAUSE_ORDER: ResearchCause[] = ['need', 'undated', 'older', 'customer', 'place', 'closed', 'unsupported', 'unfit', 'contact']
export function researchTip(causes: ResearchCause[]): string {
  const n = new Map<ResearchCause, number>()
  for (const c of causes) n.set(c, (n.get(c) ?? 0) + 1)
  const parts = CAUSE_ORDER.filter(c => n.has(c)).sort((a, b) => n.get(b)! - n.get(a)! || CAUSE_ORDER.indexOf(a) - CAUSE_ORDER.indexOf(b))
    .map(c => { const t = CAUSE_TEXT[c]; return `${n.get(c)}: ${t.charAt(0).toUpperCase()}${t.slice(1)}.` })
  return `${parts.length ? `${parts.join(' ')} ` : ''}Reading them is fine; checking them does not make them ready, and they are never counted as opportunities.`
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
  // #685: the pass started but its search of other press failed, was stopped or came back partial: never "already searched".
  if (why.startsWith('the other-press search did not complete')) return { ran: false, text: 'The search of other press for it did not complete in this run.' }
  return { ran: false, text: `dazl did not search other sources for it: ${Object.hasOwn(NOT_RUN, why) ? NOT_RUN[why] : 'the search was not available for this run'}.` }
}
