// #385: capturing the reasoned rejection when the user rejects a lead, and undoing it when they release it. Canonical keys come from feedback.ts (account by domain else name; event by company+date+source);
// the feedback row is tenant-scoped and linked to the lead by its note, so releasing the lead reverts exactly the rows its rejection wrote. A reason is required and must be one of REASONS - a bare
// reject (no reason) still quarantines the lead as before but teaches nothing. Hard rules (exclusions, identity, date gates) are not touched here.
import type { Db } from '../db/client.ts'
import { REASONS, accountKey, eventKey, personKey, recordFeedback, revertFeedback, type EntityKind, type FeedbackRow, type Reason } from './feedback.ts'

export const isReason = (v: unknown): v is Reason => typeof v === 'string' && (REASONS as readonly string[]).includes(v)
const marker = (leadId: string) => `lead:${leadId}`

// wrong_person -> the person (when the lead names one) else the account; wrong_timing -> the event; everything else -> the account.
export async function recordLeadRejection(db: Db, tenantId: string, leadId: string, reason: Reason, person: string | null = null, now = Math.floor(Date.now() / 1000)): Promise<FeedbackRow | null> {
  const l = await db.get<{ company: string; company_domain: string | null; event_date: string | null; source_url: string; query: string | null }>(
    'SELECT l.company, l.company_domain, l.event_date, l.source_url, j.query FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?', [leadId, tenantId])
  if (!l) return null
  const lead = { company: l.company, company_domain: l.company_domain }
  const ev = { date: l.event_date, source_url: l.source_url }
  const kind: EntityKind = reason === 'wrong_timing' ? 'event' : reason === 'wrong_person' && person ? 'person' : 'account'
  const entity_key = kind === 'event' ? eventKey(lead, ev) : kind === 'person' ? personKey(lead, person!) : accountKey(lead)
  let host: string | null = null; try { host = new URL(l.source_url).hostname.replace(/^www\./, '') } catch { /* keep null */ }
  return recordFeedback(db, tenantId, { entity_kind: kind, entity_key, account_key: accountKey(lead), polarity: 'reject', reason, origin: 'explicit', source: host, query_key: l.query ? l.query.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80) : null, event_key: eventKey(lead, ev), note: marker(leadId) }, now)
}

// Releasing a lead reverts the explicit rejections it wrote (the rows stay as history, stop counting). Only this tenant's rows.
export async function revertLeadRejection(db: Db, tenantId: string, leadId: string, now = Math.floor(Date.now() / 1000)): Promise<number> {
  const rows = await db.all<{ id: string }>("SELECT id FROM lead_feedback WHERE tenant_id = ? AND note = ? AND polarity = 'reject' AND origin = 'explicit' AND reverted_at IS NULL", [tenantId, marker(leadId)])
  let n = 0; for (const r of rows) if (await revertFeedback(db, tenantId, r.id, now)) n++
  return n
}
