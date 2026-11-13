import type Database from 'better-sqlite3'

// Reply rate per signal kind and source, per tenant. Read-only: no table, column or write is added.
// Denominator = real (non-test) messages with status 'sent'. A message's signal and source come from
// the snapshot taken at approval (outreach_signal_context); a sent message without one is counted in
// an explicit unknown bucket (NULL, NULL), never guessed from the lead's current tags.
//   replied    = a sent message with at least one inbound reply that is not auto, bounce or soft_bounce
//   interested = a sent message with at least one reply the rules classified 'positive' (rule-classified, not human-confirmed)
// Booking outcomes (#367) use Cal.com bookings matched to this message's lead (calcom_bookings.lead_id, matched by a unique email)
// and first received by dazl at or after the message's sent_at (created_at is dazl's receipt time of the booking's first event, not the
// Cal.com booking or meeting time). Each counts leads, not bookings, and none is causal credit:
//   booked     = the lead has a booking that still stands (scheduled, ended, held or no_show): a cancelled booking, or one
//                rescheduled away, no longer counts - its row (history) is kept; a reschedule's new booking counts instead
//   held       = a standing booking reconciled as held by a person (the only completion signal: MEETING_ENDED fires at the
//                scheduled end whether or not anyone joined, so 'ended' is not held)
//   no_show    = a standing booking Cal.com or a person marked no-show
//   cancelled  = the lead has a cancelled booking and no standing one
// A lead with several standing bookings can count in held and no_show both. Needs the calcom_bookings table and a sent_at; otherwise 0.
// One message per lead (UNIQUE tenant, lead), so a lead is never counted twice in one bucket.
// A lead with several stored signals is counted once, under its primary signal_kind from the approval snapshot.
// Association is by the reply's explicit outreach_message_id; replies without one are not attributed.
export interface ConversionRow {
  signal_kind: string | null
  source_kind: string | null
  sent: number
  replied: number
  interested: number
  booked: number
  held: number
  no_show: number
  cancelled: number
  reply_rate: number // replied / sent; sent is always > 0 for a returned row
}

const STANDING = "('scheduled', 'ended', 'held', 'no_show')"
// A booking of message m's lead, first received at or after m was sent, whose status satisfies `cond`.
const booking = (cond: string) => `EXISTS (SELECT 1 FROM calcom_bookings b WHERE b.tenant_id = m.tenant_id AND b.lead_id = m.lead_id AND ${cond}
  AND EXISTS (SELECT 1 FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = m.lead_id AND j.user_id = m.tenant_id) AND m.sent_at IS NOT NULL AND b.created_at >= m.sent_at)`

export function conversionBySignal(db: Database.Database, tenantId: string): ConversionRow[] {
  const hasBookings = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'calcom_bookings'").get()
  const rows = db.prepare(`
    SELECT c.signal_kind AS signal_kind, c.source_kind AS source_kind,
           COUNT(*) AS sent,
           SUM(EXISTS (SELECT 1 FROM inbound_messages r WHERE r.tenant_id = m.tenant_id AND r.outreach_message_id = m.id
                       AND r.classification NOT IN ('auto','bounce','soft_bounce'))) AS replied,
           SUM(EXISTS (SELECT 1 FROM inbound_messages r WHERE r.tenant_id = m.tenant_id AND r.outreach_message_id = m.id
                       AND r.classification = 'positive')) AS interested,
           ${hasBookings ? `SUM(${booking(`b.status IN ${STANDING}`)})` : '0'} AS booked,
           ${hasBookings ? `SUM(${booking("b.status = 'held'")})` : '0'} AS held,
           ${hasBookings ? `SUM(${booking("b.status = 'no_show'")})` : '0'} AS no_show,
           ${hasBookings ? `SUM(${booking("b.status = 'cancelled'")} AND NOT ${booking(`b.status IN ${STANDING}`)})` : '0'} AS cancelled
    FROM outreach_messages m
    LEFT JOIN outreach_signal_context c ON c.message_id = m.id AND c.tenant_id = m.tenant_id
    WHERE m.tenant_id = ? AND m.status = 'sent' AND m.test = 0
    GROUP BY c.signal_kind, c.source_kind`).all(tenantId) as Omit<ConversionRow, 'reply_rate'>[]
  return rows
    .map(r => ({ ...r, replied: r.replied ?? 0, interested: r.interested ?? 0, booked: r.booked ?? 0, held: r.held ?? 0, no_show: r.no_show ?? 0, cancelled: r.cancelled ?? 0, reply_rate: (r.replied ?? 0) / r.sent }))
    .sort((a, b) => Number(a.signal_kind === null) - Number(b.signal_kind === null) || b.reply_rate - a.reply_rate || b.sent - a.sent)
}

// Coverage-aware report. Reply data exists only while Gmail reply reading is on. When it is off, an
// absent reply is unobserved, not zero: replied, interested and the rate are null (unknown), the counts
// seen while reading was on stay visible as observed_*, and rows rank by sent only.
export interface ConversionReportRow {
  signal_kind: string | null
  source_kind: string | null
  sent: number
  booked: number
  held: number
  no_show: number
  cancelled: number
  replied: number | null
  interested: number | null
  reply_rate: number | null
  observed_replied: number
  observed_interested: number
}
export interface ConversionReport { reply_reading: boolean; rows: ConversionReportRow[] }

export function conversionReport(db: Database.Database, tenantId: string, replyReading: boolean): ConversionReport {
  const rows = conversionBySignal(db, tenantId)
  if (replyReading) return { reply_reading: true, rows: rows.map(r => ({ ...r, observed_replied: r.replied, observed_interested: r.interested })) }
  return {
    reply_reading: false,
    rows: rows
      .map(r => ({ signal_kind: r.signal_kind, source_kind: r.source_kind, sent: r.sent, booked: r.booked, held: r.held, no_show: r.no_show, cancelled: r.cancelled, replied: null, interested: null, reply_rate: null, observed_replied: r.replied, observed_interested: r.interested }))
      .sort((a, b) => Number(a.signal_kind === null) - Number(b.signal_kind === null) || b.sent - a.sent),
  }
}
