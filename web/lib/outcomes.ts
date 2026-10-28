// The outcomes view for one play (= one campaign): qualified opportunities, drafts waiting for the owner, conversations
// that need the owner, and exceptions. Pure and read-only; it only sorts what the existing reads return:
//   leads    - GET /api/leads?job_id=<play> (opportunity vs held is lib/journey.ts previewSplit, the same gates as Home)
//   messages - GET /api/campaigns/<play> (this play's emails only; never the account-wide Outreach list)
//   replies  - GET /api/outreach/inbox (the newest INBOX_CAP replies account-wide, kept only when their lead is in this play)
// Anything that did not load is null and shown as unknown, never as zero.
import { previewSplit, type PreviewLead, type PreviewSplit } from './journey.ts'

export const INBOX_CAP = 100   // lib/outreach/replies.ts inboxRows default limit
export interface OutcomeMsg { id: string; lead_id: string; to_email: string; subject: string; status: string; created_at: number; sent_at: number | null }
export interface OutcomeReply { gmail_id: string; thread_id: string; lead_id: string | null; from_email: string; excerpt: string; classification: string; received_at: number; company: string | null; lead_name: string | null; stopped: string | null }
export interface Outcomes {
  split: PreviewSplit | null
  drafts: OutcomeMsg[] | null           // waiting for the owner's approval in Outreach
  approved: OutcomeMsg[] | null         // approved, not sent yet (no further approval needed)
  sent: OutcomeMsg[] | null
  conversations: { rows: OutcomeReply[]; complete: boolean } | null   // replies a person wrote that are not a no / opt-out
  exceptions: { kind: 'scan' | 'send' | 'held'; text: string; href: string }[] | null
}

// Replies that need the owner: an interested answer, or a human answer the rules could not sort. A "no", an opt-out
// (already honoured by the send rails) and auto-replies are not counted as needing the owner, and neither is a thread
// that is already stopped.
const NEEDS_OWNER = new Set(['positive', 'other'])
const FAILED_SEND = new Set(['failed', 'uncertain'])

export function outcomes(i: { jobId: string; scanFailed: string | null; leads: PreviewLead[] | null; messages: OutcomeMsg[] | null; replies: OutcomeReply[] | null }): Outcomes {
  const split = i.leads ? previewSplit(i.leads) : null
  const ids = i.leads ? new Set(i.leads.map(l => l.id)) : null
  const mine = i.messages && ids ? i.messages.filter(m => ids.has(m.lead_id)) : i.messages
  const by = (st: string) => mine ? mine.filter(m => m.status === st) : null
  const conversations = i.replies && ids
    ? { rows: i.replies.filter(r => r.lead_id && ids.has(r.lead_id) && NEEDS_OWNER.has(r.classification) && !r.stopped), complete: i.replies.length < INBOX_CAP }
    : null
  let exceptions: Outcomes['exceptions'] = []
  if (i.scanFailed) exceptions.push({ kind: 'scan', text: i.scanFailed, href: `/app/leads?job_id=${i.jobId}` })
  if (mine) for (const m of mine.filter(m => FAILED_SEND.has(m.status))) exceptions.push({ kind: 'send', text: `Email to ${m.to_email} ${m.status === 'uncertain' ? 'may not have sent - check before resending' : 'failed to send'}`, href: `/app/outreach?job_id=${i.jobId}` })
  else exceptions = null
  if (exceptions && split) for (const h of split.held) exceptions.push({ kind: 'held', text: `${h.lead.company}: ${h.reason}`, href: `/app/leads?job_id=${i.jobId}` })
  else if (!split) exceptions = null
  return { split, drafts: by('draft'), approved: by('approved'), sent: by('sent'), conversations, exceptions }
}
