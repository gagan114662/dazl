// The one-campaign page (/app/campaigns/<scan>): where each of the scan's leads stands, from review to send. Pure and
// client-safe: it reads the existing GET /api/leads (all=1) and GET /api/outreach responses and decides nothing a
// server gate enforces. Statuses are what is stored now; "Sent" is not "delivered".
import { evidenceStateOf } from './evidence-state.ts'
import { listQual } from '../run-status.ts'
import { reviewIsActionable, uncheckableCause } from '../lead-state.ts'
import { DISCOVER_STATE_LABEL, discoverCountParts, type DiscoverCounts, type DiscoverState } from '../discover/card.ts'

export interface ViewLead { id: string; company?: string | null; name?: string | null; evidence_excerpt: string | null; confidence: number | null; human_confirmed_at: number | null; review_reason?: string | null; quarantined_at?: number | null; quarantine_reason?: string | null; window_held?: boolean; buyer_unreachable?: boolean; gate_held?: boolean; human_confirmed_from?: string | null; discover_state?: DiscoverState | null }
export interface ViewMsg { id: string; lead_id: string; to_email: string; subject: string; status: string; sent_at: number | null }
export type Stage = 'rejected' | 'review' | 'research' | 'unverified' | 'no_contact' | 'qualified' | 'draft' | 'approved' | 'sending' | 'sent' | 'other'
export interface LeadStatus { stage: Stage; text: string }

const MSG: Record<string, [Stage, string]> = {
  draft: ['draft', 'Draft waiting for your review'],
  approved: ['approved', 'Approved, not sent yet'],
  sending: ['sending', 'Sending'],
  uncertain: ['sending', 'Send outcome unknown - check Outreach'],
  sent: ['sent', 'Sent'],
}

// A lead's latest email decides once one exists; before that, its rejection, review or evidence state does.
export function leadStatus(l: ViewLead, msgs: ViewMsg[]): LeadStatus {
  if (l.quarantined_at) { const why = (l.quarantine_reason ?? '').replace(/^Rejected(: )?/, '').trim(); return { stage: 'rejected', text: why ? `Rejected: ${why}` : 'Rejected' } }
  const m = msgs.find(x => x.lead_id === l.id)
  if (m) { const [stage, text] = MSG[m.status] ?? ['other', `Email ${m.status}`]; return { stage, text } }
  // A lead from the new engine: its ONE state and that state's words (lib/discover/card.ts), the same as on Home, Leads and Campaigns (#1238).
  if (l.discover_state) { const s = l.discover_state; return { stage: s === 'ready_email' || s === 'ready_linkedin' ? 'qualified' : s, text: DISCOVER_STATE_LABEL[s] } }
  // A review-list lead no check can make usable is research, never a review item (#683; the same verdict as Home, lib/lead-state.ts).
  if (l.review_reason) return reviewIsActionable(l) ? { stage: 'review', text: 'Needs your review' } : { stage: 'research', text: 'Research only - checking the source cannot make it ready' }
  // A required check that has not passed holds it whatever its evidence state: checking the source cannot release it (#1062).
  if (l.gate_held) return { stage: 'research', text: 'Research only - checking the source cannot make it ready' }
  const ev = evidenceStateOf(l)
  if (ev === 'unverified') return { stage: 'unverified', text: 'Not verified - check the source' }
  // A source-checked or confirmed lead can still be held by the time window, or be confirmed OUT of a hold a check cannot
  // resolve (human_confirmed_from): confirming it does not lift either, so it stays research, never "not drafted" (#683).
  if (l.window_held || uncheckableCause(l.human_confirmed_from)) return { stage: 'research', text: 'Research only - checking the source cannot make it ready' }
  return { stage: 'qualified', text: ev === 'machine' ? 'Source-checked, not drafted' : 'Confirmed by you, not drafted' }
}

// Messages newest first come from the API; keep that order, and only this scan's.
// A sent receipt is history, not proof that the recipient is eligible today.
export function hasSentHistory(msg: ViewMsg): boolean {
  return msg.status === 'sent' || (typeof msg.sent_at === 'number' && msg.sent_at > 0)
}

export function scanMessages(msgs: ViewMsg[], leads: { id: string }[], includeSentHistory = false): ViewMsg[] {
  const ids = new Set(leads.map(l => l.id))
  return msgs.filter(m => ids.has(m.lead_id) || (includeSentHistory && hasSentHistory(m)))
}

// The Campaigns list's Qualification stage: [value, detail], counted the way the campaign page counts (lib/run-status.ts currentQual). A held lead
// no check can release (heldResearch: the time window, an uncheckable hold, a required check that has not passed - #1062) is research only, never
// also "source-checked" or "confirmed by you": heldResearchSourceChecked is the source-checked slice of it, the rest was confirmed by you.
export interface QualCounts { sourceChecked: number; confirmedByYou: number; needsReview: number; research?: number; unverified: number; held: number; heldResearch?: number; heldResearchSourceChecked?: number; rejected: number; noContact?: number; discover?: DiscoverCounts }
export function qualificationLines(q: QualCounts, leads: number): [string, string] {
  // a search made only of new-engine leads: their own counts in their own words (lib/discover/card.ts), as the Leads header says them (#1238)
  if (q.discover && q.discover.found === leads) { const [ready, ...rest] = discoverCountParts(q.discover); return [ready, rest.join(', ')] }
  const l = listQual(q), heldResearch = Math.max(0, q.heldResearch ?? 0)   // the same split as the run pill (lib/run-status.ts listQual)
  // The detail line is always shown, also under "None passed" (as on main before #683/#1062)
  const detail = `${Math.max(0, q.held - heldResearch)} timing not confirmed, ${l.research} research only, ${q.unverified} unverified, ${q.rejected} rejected`
  if (leads > 0 && q.rejected >= leads) return [`None passed: ${q.rejected} rejected`, detail]
  return [`${l.sourceChecked} source-checked, ${l.confirmedByYou} confirmed by you, ${q.needsReview} to review`, detail]
}
