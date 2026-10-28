// Ties Outreach emails to one scan, for the "N approved -> Review drafts" bar on Leads and the matching filter on
// Outreach. Pure and client-safe: it reads the existing GET /api/outreach and GET /api/leads responses and decides nothing
// the server enforces (drafting, approval and sending keep every server-side check).

export interface ScanMsg { lead_id: string; status: string }

// Waiting on the user: drafts, and emails approved but not yet sent. Sent, stopped or failed ones are not "to review".
const WAITING = new Set(['draft', 'approved'])

export function forScan<T extends ScanMsg>(msgs: T[], leadIds: Iterable<string>): T[] {
  const ids = new Set(leadIds)
  return msgs.filter(m => ids.has(m.lead_id))
}

export function waitingCount(msgs: ScanMsg[], leadIds: Iterable<string>): number {
  return forScan(msgs, leadIds).filter(m => WAITING.has(m.status)).length
}

export const isJobId = (v: string | null): v is string => !!v && /^[a-f0-9]{24}$/.test(v)
