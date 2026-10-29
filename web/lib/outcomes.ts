// The outcomes view for one play (= one campaign): qualified opportunities, drafts waiting for the owner, conversations
// that need the owner, and exceptions. Pure and read-only; it only sorts what the existing reads return:
//   leads    - GET /api/leads?job_id=<play> (opportunity vs held is lib/journey.ts previewSplit, the same gates as Home)
//   messages - GET /api/campaigns/<play> (this play's emails only; never the account-wide Outreach list)
//   replies  - GET /api/outreach/inbox?job_id=<play>&status=needs_owner: this play's conversations that need the owner, one
//              row per thread, filtered and paginated on the server (lib/outreach/inbox.ts), with the exact total
// Anything that did not load is null and shown as unknown, never as zero.
import { previewSplit, type PreviewLead, type PreviewSplit } from './journey.ts'

export interface OutcomeMsg { id: string; lead_id: string; to_email: string; subject: string; status: string; created_at: number; sent_at: number | null }
export interface OutcomeReply { gmail_id: string; thread_id: string; lead_id: string | null; from_email: string; excerpt: string; classification: string; received_at: number; company: string | null; lead_name: string | null; stopped: string | null }
export interface Outcomes {
  split: PreviewSplit | null
  drafts: OutcomeMsg[] | null           // waiting for the owner's approval in Outreach
  approved: OutcomeMsg[] | null         // approved, not sent yet (no further approval needed)
  sent: OutcomeMsg[] | null
  // Replies a person wrote that are not a no / opt-out. total is the server's count for the whole play; rows is the first
  // page (complete when it is all of them).
  conversations: { rows: OutcomeReply[]; total: number; complete: boolean } | null
  exceptions: { kind: 'scan' | 'send' | 'held'; text: string; href: string }[] | null
}

// Replies that need the owner: an interested answer, a human answer the rules could not sort, or a reply flagged for
// review ('uncertain', which stops the thread as 'review'). A "no", an opt-out (already honoured by the send rails) and
// auto-replies are not counted as needing the owner, and neither is a thread stopped for any other reason.
const NEEDS_OWNER = new Set(['positive', 'other', 'uncertain'])
const FAILED_SEND = new Set(['failed', 'uncertain'])

export interface RepliesPage { threads: OutcomeReply[]; complete: boolean; needsOwner: number }
export function outcomes(i: { jobId: string; scanFailed: string | null; leads: PreviewLead[] | null; messages: OutcomeMsg[] | null; replies: RepliesPage | null }): Outcomes {
  const split = i.leads ? previewSplit(i.leads) : null
  const ids = i.leads ? new Set(i.leads.map(l => l.id)) : null
  const mine = i.messages && ids ? i.messages.filter(m => ids.has(m.lead_id)) : i.messages
  const by = (st: string) => mine ? mine.filter(m => m.status === st) : null
  // The server already gives one row per thread (its deciding reply), this play only, needing the owner. The same rules
  // are re-applied here so a row that does not meet them can never be shown or counted.
  const newest = new Map<string, OutcomeReply>()
  for (const r of i.replies?.threads ?? []) { const cur = newest.get(r.thread_id); if (!cur || r.received_at > cur.received_at) newest.set(r.thread_id, r) }
  const rows = [...newest.values()].filter(r => r.lead_id && ids?.has(r.lead_id) && NEEDS_OWNER.has(r.classification) && (!r.stopped || r.stopped === 'review')).sort((a, b) => b.received_at - a.received_at)
  const conversations = i.replies && ids
    ? { rows, total: i.replies.complete ? rows.length : Math.max(i.replies.needsOwner, rows.length), complete: i.replies.complete }
    : null
  let exceptions: Outcomes['exceptions'] = []
  if (i.scanFailed) exceptions.push({ kind: 'scan', text: i.scanFailed, href: `/app/leads?job_id=${i.jobId}` })
  if (mine) for (const m of mine.filter(m => FAILED_SEND.has(m.status))) exceptions.push({ kind: 'send', text: `Email to ${m.to_email} ${m.status === 'uncertain' ? 'may not have sent - check before resending' : 'failed to send'}`, href: `/app/outreach?job_id=${i.jobId}` })
  else exceptions = null
  if (exceptions && split) for (const h of split.held) exceptions.push({ kind: 'held', text: `${h.lead.company}: ${h.reason}`, href: `/app/leads?job_id=${i.jobId}` })
  else if (!split) exceptions = null
  return { split, drafts: by('draft'), approved: by('approved'), sent: by('sent'), conversations, exceptions }
}
