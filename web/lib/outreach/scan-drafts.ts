// Ties Outreach emails to one scan, for the "N approved -> Review drafts" bar on Leads and the matching filter on
// Outreach. Pure and client-safe: it reads the existing GET /api/outreach and GET /api/leads responses and decides nothing
// the server enforces (drafting, approval and sending keep every server-side check).

export interface ScanMsg { lead_id: string; status: string }

export function forScan<T extends ScanMsg>(msgs: T[], leadIds: Iterable<string>): T[] {
  const ids = new Set(leadIds)
  return msgs.filter(m => ids.has(m.lead_id))
}

// This scan's emails that are not sent yet, by state: a draft still needs the user's approval in Outreach; an approved
// email already has it and waits only for its send. Sent, sending, uncertain or stopped ones are not counted.
export function scanCounts(msgs: ScanMsg[], leadIds: Iterable<string>): { drafts: number; approved: number } {
  const mine = forScan(msgs, leadIds)
  return { drafts: mine.filter(m => m.status === 'draft').length, approved: mine.filter(m => m.status === 'approved').length }
}

// The Leads bar. Never calls a draft "approved", and never says an approved email needs another approval.
export function barCopy(c: { drafts: number; approved: number }): string | null {
  const parts: string[] = []
  if (c.drafts > 0) parts.push(`${c.drafts} draft${c.drafts === 1 ? '' : 's'} from this scan ${c.drafts === 1 ? 'is' : 'are'} waiting for your review in Outreach. Nothing is sent until you approve ${c.drafts === 1 ? 'it' : 'each one'} there.`)
  if (c.approved > 0) parts.push(`${c.approved} email${c.approved === 1 ? '' : 's'} from this scan ${c.approved === 1 ? 'is' : 'are'} approved and not sent yet.`)
  return parts.length ? parts.join(' ') : null
}

export const isJobId = (v: string | null): v is string => !!v && /^[a-f0-9]{24}$/.test(v)
