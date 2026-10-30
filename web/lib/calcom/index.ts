import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from '../db/client.ts'

// Cal.com booking webhooks -> pipeline stage and meeting outcomes (#367). A booking is matched to a lead by its
// attendees' normalized emails against lead.contact: only when they point to exactly one lead; zero or several stay
// "unmatched" - a booking is never guessed onto a lead.
// Lifecycle, converging whatever order Cal.com delivers events in (and however often):
//   status   scheduled -> cancelled (final) | rescheduled (superseded by the booking that replaced it)
//   times    start/end/attendees from the newest created/rescheduled event (event_at), never an older one
//   outcome  held / no_show only from a completion signal (MEETING_ENDED, BOOKING_NO_SHOW_UPDATED) or a person marking
//            it by hand (audited); a meeting is never "held" because its end time passed. A manual outcome wins.
// Every event is appended to calcom_booking_events (history is kept; a replayed event is a duplicate, applied once).
// Only scheduled bookings are active: a cancelled or superseded one stays listed but is not counted as booked.
// Reads and writes run on the Db layer (SQLite or Postgres); migrateCalcom is the SQLite schema (PG: 0017).

export function migrateCalcom(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calcom_hooks (
      tenant_id  TEXT PRIMARY KEY,
      secret     TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
    CREATE TABLE IF NOT EXISTS calcom_bookings (
      tenant_id      TEXT NOT NULL,
      booking_uid    TEXT NOT NULL,
      attendee_email TEXT NOT NULL,
      attendee_name  TEXT,
      lead_id        TEXT,
      created_at     INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (tenant_id, booking_uid)
    );
    CREATE TABLE IF NOT EXISTS calcom_booking_events (
      tenant_id   TEXT NOT NULL,
      booking_uid TEXT NOT NULL,
      kind        TEXT NOT NULL,
      event_key   TEXT NOT NULL,
      event_at    INTEGER,
      actor       TEXT,
      detail      TEXT,
      received_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, booking_uid, kind, event_key)
    );
  `)
  for (const col of [
    "status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'rescheduled'))",
    'start_at INTEGER', 'end_at INTEGER', 'event_at INTEGER', 'rescheduled_from TEXT', 'attendees TEXT', 'cancelled_at INTEGER',
    "outcome TEXT CHECK (outcome IS NULL OR outcome IN ('held', 'no_show'))", "outcome_source TEXT CHECK (outcome_source IS NULL OR outcome_source IN ('calcom', 'manual'))",
    'outcome_by TEXT', 'outcome_at INTEGER',
  ]) { try { db.exec(`ALTER TABLE calcom_bookings ADD COLUMN ${col}`) } catch { /* exists */ } }
}

export async function getSecret(db: Db, tenantId: string): Promise<string | null> {
  return (await db.get<{ secret: string }>('SELECT secret FROM calcom_hooks WHERE tenant_id = ?', [tenantId]))?.secret ?? null
}

export async function rotateSecret(db: Db, tenantId: string, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const secret = crypto.randomBytes(24).toString('base64url')
  await db.run('INSERT INTO calcom_hooks (tenant_id, secret, created_at) VALUES (?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at', [tenantId, secret, nowS])
  return secret
}

// Cal.com signs the raw request body: X-Cal-Signature-256 = HMAC-SHA256(secret, body).
export function verifySignature(secret: string, rawBody: string, header: string | null): boolean {
  if (!header || !/^[a-f0-9]{64}$/i.test(header)) return false
  const want = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest()
  const got = Buffer.from(header, 'hex')
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}

export const normalizeEmail = (s: string) => s.trim().toLowerCase()

export type BookingEventKind = 'created' | 'rescheduled' | 'cancelled' | 'ended' | 'no_show'
export interface Attendee { email: string; name: string | null; noShow?: boolean }
export interface BookingEvent {
  kind: BookingEventKind
  uid: string
  // the booking this one replaced (rescheduled)
  fromUid: string | null
  attendees: Attendee[]
  startAt: number | null
  endAt: number | null
  // when Cal.com says the event happened (the webhook's createdAt), epoch seconds; null when it does not say
  eventAt: number | null
  // what makes a delivery the same event. Created, rescheduled, cancelled and ended happen once per booking, so any
  // second one for that booking is a duplicate (Cal.com retries, replays, a re-sent body). A no-show flag can change
  // back and forth: each distinct update counts (Cal.com's createdAt, else the body's digest).
  key: string
}
const TRIGGERS: Record<string, BookingEventKind> = { BOOKING_CREATED: 'created', BOOKING_RESCHEDULED: 'rescheduled', BOOKING_CANCELLED: 'cancelled', MEETING_ENDED: 'ended', BOOKING_NO_SHOW_UPDATED: 'no_show' }
const secs = (v: unknown): number | null => { if (typeof v !== 'string' && typeof v !== 'number') return null; const t = new Date(v).getTime(); return Number.isFinite(t) ? Math.floor(t / 1000) : null }
const str = (v: unknown, n: number) => typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null

// A Cal.com webhook body as one booking event, or null when it is not a booking event we track.
export function parseBookingEvent(rawBody: string): BookingEvent | null {
  let body: { triggerEvent?: unknown; createdAt?: unknown; payload?: Record<string, unknown> }
  try { body = JSON.parse(rawBody) } catch { return null }
  const kind = typeof body?.triggerEvent === 'string' ? TRIGGERS[body.triggerEvent] : undefined
  const p = body?.payload
  if (!kind || !p || typeof p !== 'object') return null
  const uid = str(p.uid, 120) ?? str(p.bookingUid, 120)
  if (!uid) return null
  const attendees: Attendee[] = []
  for (const a of Array.isArray(p.attendees) ? p.attendees.slice(0, 20) : []) {
    const o = a as { email?: unknown; name?: unknown; noShow?: unknown }
    const email = normalizeEmail(typeof o?.email === 'string' ? o.email : '')
    if (!email || attendees.some(x => x.email === email)) continue
    attendees.push({ email, name: str(o.name, 150), ...(typeof o.noShow === 'boolean' ? { noShow: o.noShow } : {}) })
  }
  const eventAt = secs(body.createdAt)
  return {
    kind, uid, fromUid: kind === 'rescheduled' ? str(p.rescheduleUid, 120) ?? str(p.fromReschedule, 120) : null,
    attendees, startAt: secs(p.startTime), endAt: secs(p.endTime), eventAt,
    key: kind !== 'no_show' ? kind : typeof body.createdAt === 'string' && eventAt !== null ? body.createdAt.slice(0, 40) : crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 32),
  }
}

// The created event only, in the shape the first version of this module used.
export function parseBooking(rawBody: string): { uid: string; email: string; name: string | null } | null {
  const e = parseBookingEvent(rawBody)
  if (!e || e.kind !== 'created' || !e.attendees.length) return null
  return { uid: e.uid, email: e.attendees[0].email, name: e.attendees[0].name }
}

export type EventOutcome = 'duplicate' | 'matched' | 'unmatched' | 'applied'
const nowSec = () => Math.floor(Date.now() / 1000)

// Applies one booking event in one transaction: the event row (a replay is a duplicate and changes nothing), the
// booking's state, its lead link and the lead's stage land together. Converges whatever order events arrive in.
export function recordBookingEvent(db: Db, tenantId: string, e: BookingEvent, now = nowSec()): Promise<EventOutcome> {
  return db.tx(function* (t: Tx): TxBody<EventOutcome> {
    const ev = yield* t.run('INSERT INTO calcom_booking_events (tenant_id, booking_uid, kind, event_key, event_at, detail, received_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, booking_uid, kind, event_key) DO NOTHING',
      [tenantId, e.uid, e.kind, e.key, e.eventAt, e.fromUid ? JSON.stringify({ from: e.fromUid }) : null, now])
    if (ev.changes === 0) return 'duplicate'
    const first = e.attendees[0]
    // the booking row exists from its first event, whichever that is (a cancellation can arrive before the creation)
    yield* t.run('INSERT INTO calcom_bookings (tenant_id, booking_uid, attendee_email, attendee_name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant_id, booking_uid) DO NOTHING',
      [tenantId, e.uid, first?.email ?? '', first?.name ?? null, e.eventAt ?? now])
    if (e.kind === 'created' || e.kind === 'rescheduled') {
      // details from the newest scheduling event only; an older one arriving late never overwrites them
      // (an undated event fills only a booking no dated event has described yet)
      if (e.attendees.length) yield* t.run(`UPDATE calcom_bookings SET attendee_email = ?, attendee_name = ?, attendees = ?, start_at = coalesce(?, start_at), end_at = coalesce(?, end_at), event_at = coalesce(?, event_at)
        WHERE tenant_id = ? AND booking_uid = ? AND (event_at IS NULL${e.eventAt === null ? '' : ' OR event_at <= ?'})`,
        [first.email, first.name, JSON.stringify(e.attendees.map(a => ({ email: a.email, name: a.name }))), e.startAt, e.endAt, e.eventAt, tenantId, e.uid, ...(e.eventAt === null ? [] : [e.eventAt])])
      if (e.kind === 'rescheduled' && e.fromUid && e.fromUid !== e.uid) {
        yield* t.run('UPDATE calcom_bookings SET rescheduled_from = ? WHERE tenant_id = ? AND booking_uid = ?', [e.fromUid, tenantId, e.uid])
        // the booking it replaced is superseded; it may not have arrived yet, so it is created now as superseded
        yield* t.run("INSERT INTO calcom_bookings (tenant_id, booking_uid, attendee_email, attendee_name, created_at, status) VALUES (?, ?, ?, ?, ?, 'rescheduled') ON CONFLICT (tenant_id, booking_uid) DO NOTHING",
          [tenantId, e.fromUid, first?.email ?? '', first?.name ?? null, e.eventAt ?? now])
        yield* t.run("UPDATE calcom_bookings SET status = 'rescheduled' WHERE tenant_id = ? AND booking_uid = ? AND status = 'scheduled'", [tenantId, e.fromUid])
      }
      // a booking that a later reschedule already replaced stays superseded when its own creation arrives late
      yield* t.run("UPDATE calcom_bookings SET status = 'rescheduled' WHERE tenant_id = ? AND booking_uid = ? AND status = 'scheduled' AND EXISTS (SELECT 1 FROM calcom_bookings n WHERE n.tenant_id = ? AND n.rescheduled_from = ?)",
        [tenantId, e.uid, tenantId, e.uid])
    } else if (e.kind === 'cancelled') {
      // final, whatever arrives after it
      yield* t.run("UPDATE calcom_bookings SET status = 'cancelled', cancelled_at = coalesce(cancelled_at, ?) WHERE tenant_id = ? AND booking_uid = ?", [e.eventAt ?? now, tenantId, e.uid])
    } else if (e.kind === 'ended') {
      yield* t.run("UPDATE calcom_bookings SET outcome = 'held', outcome_source = 'calcom', outcome_at = ? WHERE tenant_id = ? AND booking_uid = ? AND status <> 'cancelled' AND (outcome_source IS NULL OR outcome_source = 'calcom')", [e.eventAt ?? now, tenantId, e.uid])
    } else if (e.kind === 'no_show') {
      const flagged = e.attendees.filter(a => a.noShow !== undefined)
      const noShow = flagged.length > 0 && flagged.every(a => a.noShow)
      if (noShow) yield* t.run("UPDATE calcom_bookings SET outcome = 'no_show', outcome_source = 'calcom', outcome_at = ? WHERE tenant_id = ? AND booking_uid = ? AND status <> 'cancelled' AND (outcome_source IS NULL OR outcome_source = 'calcom')", [e.eventAt ?? now, tenantId, e.uid])
      else if (flagged.length) yield* t.run("UPDATE calcom_bookings SET outcome = NULL, outcome_source = NULL, outcome_at = NULL WHERE tenant_id = ? AND booking_uid = ? AND outcome = 'no_show' AND outcome_source = 'calcom'", [tenantId, e.uid])
    }
    if (e.kind !== 'created' && e.kind !== 'rescheduled') return 'applied'
    // Match: the attendees' emails must point to exactly one of the tenant's leads. An active booking stages it.
    const emails = e.attendees.map(a => a.email)
    if (!emails.length) return 'unmatched'
    const rows = yield* t.all<{ id: string }>(`SELECT DISTINCT l.id FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? AND l.contact IS NOT NULL AND lower(l.contact) IN (${emails.map(() => '?').join(', ')})`, [tenantId, ...emails])
    if (rows.length !== 1) return 'unmatched'
    yield* t.run('UPDATE calcom_bookings SET lead_id = ? WHERE tenant_id = ? AND booking_uid = ?', [rows[0].id, tenantId, e.uid])
    const st = yield* t.get<{ status: string }>('SELECT status FROM calcom_bookings WHERE tenant_id = ? AND booking_uid = ?', [tenantId, e.uid])
    if (st?.status === 'scheduled') yield* t.run("UPDATE leads SET stage = 'booked_call' WHERE id = ?", [rows[0].id])
    return 'matched'
  })
}

// The created event in the shape the first version of this module used: 'duplicate' | 'matched' | 'unmatched'.
export async function recordBooking(db: Db, tenantId: string, b: { uid: string; email: string; name: string | null }): Promise<'duplicate' | 'matched' | 'unmatched'> {
  const r = await recordBookingEvent(db, tenantId, { kind: 'created', uid: b.uid, fromUid: null, attendees: [{ email: normalizeEmail(b.email), name: b.name }], startAt: null, endAt: null, eventAt: null, key: 'created' })
  return r === 'applied' ? 'matched' : r
}

// A person marks what happened (or clears it): held, no_show, or null. Audited as an event with who did it. A
// cancelled or superseded booking has no meeting to mark. Returns false when there is no such active booking.
export function setMeetingOutcome(db: Db, tenantId: string, uid: string, outcome: 'held' | 'no_show' | null, actor: string, now = nowSec()): Promise<boolean> {
  return db.tx(function* (t: Tx): TxBody<boolean> {
    const r = outcome
      ? yield* t.run("UPDATE calcom_bookings SET outcome = ?, outcome_source = 'manual', outcome_by = ?, outcome_at = ? WHERE tenant_id = ? AND booking_uid = ? AND status = 'scheduled'", [outcome, actor, now, tenantId, uid])
      : yield* t.run("UPDATE calcom_bookings SET outcome = NULL, outcome_source = NULL, outcome_by = ?, outcome_at = ? WHERE tenant_id = ? AND booking_uid = ? AND status = 'scheduled'", [actor, now, tenantId, uid])
    if (r.changes !== 1) return false
    yield* t.run('INSERT INTO calcom_booking_events (tenant_id, booking_uid, kind, event_key, event_at, actor, detail, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [tenantId, uid, 'manual_outcome', `${now}:${crypto.randomBytes(6).toString('hex')}`, now, actor, JSON.stringify({ outcome }), now])
    return true
  })
}

// Counts by state, kept apart: scheduled (active), held and no_show (of the active ones, from a completion signal or a
// person), cancelled, and rescheduled (superseded; the booking that replaced it is counted on its own).
export async function bookingCounts(db: Db, tenantId: string): Promise<{ scheduled: number; held: number; no_show: number; cancelled: number; rescheduled: number }> {
  const r = await db.get<Record<string, number | null>>(`SELECT
      SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled,
      SUM(CASE WHEN status = 'scheduled' AND outcome = 'held' THEN 1 ELSE 0 END) AS held,
      SUM(CASE WHEN status = 'scheduled' AND outcome = 'no_show' THEN 1 ELSE 0 END) AS no_show,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN status = 'rescheduled' THEN 1 ELSE 0 END) AS rescheduled
    FROM calcom_bookings WHERE tenant_id = ?`, [tenantId])
  const n = (k: string) => Number(r?.[k] ?? 0)
  return { scheduled: n('scheduled'), held: n('held'), no_show: n('no_show'), cancelled: n('cancelled'), rescheduled: n('rescheduled') }
}

// Newest first; same-second bookings by booking uid, the order SQLite's primary-key index gave.
export function listBookings(db: Db, tenantId: string, limit = 50) {
  return db.all(`
    SELECT b.booking_uid, b.attendee_email, b.attendee_name, b.created_at, b.lead_id, b.status, b.start_at, b.end_at, b.rescheduled_from,
           b.cancelled_at, b.outcome, b.outcome_source, l.company, l.name AS lead_name
    FROM calcom_bookings b LEFT JOIN leads l ON l.id = b.lead_id
    WHERE b.tenant_id = ? ORDER BY b.created_at DESC, b.booking_uid LIMIT ?`, [tenantId, limit])
}
