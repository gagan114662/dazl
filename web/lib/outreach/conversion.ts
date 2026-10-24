import type Database from 'better-sqlite3'

// Reply rate per signal kind and source, per tenant. Read-only: no table, column or write is added.
// Denominator = real (non-test) messages with status 'sent'. A message's signal and source come from
// the snapshot taken at approval (outreach_signal_context); a sent message without one is counted in
// an explicit unknown bucket (NULL, NULL), never guessed from the lead's current tags.
//   replied    = a sent message with at least one inbound reply that is not auto, bounce or soft_bounce
//   interested = a sent message with at least one reply the rules classified 'positive' (rule-classified, not human-confirmed)
//   booked     = a Cal.com booking matched to this message's lead (calcom_bookings.lead_id, matched by a unique contact email)
//                and recorded at or after the message's sent_at. It is a booking, not a held meeting, and not causal credit.
//                Needs the calcom_bookings table and a sent_at; otherwise 0. One message per lead (UNIQUE tenant, lead), so a lead is never counted twice.
// A lead with several stored signals is counted once, under its primary signal_kind from the approval snapshot.
// Association is by the reply's explicit outreach_message_id; replies without one are not attributed.
export interface ConversionRow {
  signal_kind: string | null
  source_kind: string | null
  sent: number
  replied: number
  interested: number
  booked: number
  reply_rate: number // replied / sent; sent is always > 0 for a returned row
}

export function conversionBySignal(db: Database.Database, tenantId: string): ConversionRow[] {
  const hasBookings = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'calcom_bookings'").get()
  const rows = db.prepare(`
    SELECT c.signal_kind AS signal_kind, c.source_kind AS source_kind,
           COUNT(*) AS sent,
           SUM(EXISTS (SELECT 1 FROM inbound_messages r WHERE r.tenant_id = m.tenant_id AND r.outreach_message_id = m.id
                       AND r.classification NOT IN ('auto','bounce','soft_bounce'))) AS replied,
           SUM(EXISTS (SELECT 1 FROM inbound_messages r WHERE r.tenant_id = m.tenant_id AND r.outreach_message_id = m.id
                       AND r.classification = 'positive')) AS interested,
           ${hasBookings ? `SUM(EXISTS (SELECT 1 FROM calcom_bookings b WHERE b.tenant_id = m.tenant_id AND b.lead_id = m.lead_id AND EXISTS (SELECT 1 FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = m.lead_id AND j.user_id = m.tenant_id) AND m.sent_at IS NOT NULL AND b.created_at >= m.sent_at))` : '0'} AS booked
    FROM outreach_messages m
    LEFT JOIN outreach_signal_context c ON c.message_id = m.id AND c.tenant_id = m.tenant_id
    WHERE m.tenant_id = ? AND m.status = 'sent' AND m.test = 0
    GROUP BY c.signal_kind, c.source_kind`).all(tenantId) as Omit<ConversionRow, 'reply_rate'>[]
  return rows
    .map(r => ({ ...r, replied: r.replied ?? 0, interested: r.interested ?? 0, booked: r.booked ?? 0, reply_rate: (r.replied ?? 0) / r.sent }))
    .sort((a, b) => Number(a.signal_kind === null) - Number(b.signal_kind === null) || b.reply_rate - a.reply_rate || b.sent - a.sent)
}
