// The one-campaign page (/app/campaigns/<scan>): where each of the scan's leads stands, from review to send. Pure and
// client-safe: it reads the existing GET /api/leads (all=1) and GET /api/outreach responses and decides nothing a
// server gate enforces. Statuses are what is stored now; "Sent" is not "delivered".
import { evidenceStateOf } from './evidence-state.ts'

export interface ViewLead { id: string; company?: string | null; name?: string | null; evidence_excerpt: string | null; confidence: number | null; human_confirmed_at: number | null; review_reason?: string | null; quarantined_at?: number | null; quarantine_reason?: string | null }
export interface ViewMsg { id: string; lead_id: string; to_email: string; subject: string; status: string; sent_at: number | null }
export type Stage = 'rejected' | 'review' | 'unverified' | 'qualified' | 'draft' | 'approved' | 'sending' | 'sent' | 'other'
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
  if (l.review_reason) return { stage: 'review', text: 'Needs your review' }
  const ev = evidenceStateOf(l)
  if (ev === 'unverified') return { stage: 'unverified', text: 'Not verified - check the source' }
  return { stage: 'qualified', text: ev === 'machine' ? 'Source-checked, not drafted' : 'Confirmed by you, not drafted' }
}

// Messages newest first come from the API; keep that order, and only this scan's.
export function scanMessages(msgs: ViewMsg[], leads: { id: string }[]): ViewMsg[] {
  const ids = new Set(leads.map(l => l.id))
  return msgs.filter(m => ids.has(m.lead_id))
}
