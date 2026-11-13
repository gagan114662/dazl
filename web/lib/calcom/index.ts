import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from '../db/client.ts'
import { recordTx } from '../audit.ts'
import { meetingOver, type BookingStatus } from './outcome-rules.ts'

// Cal.com booking webhooks -> booking outcomes and the pipeline stage. A booking is matched to a lead by the attendee's
// normalized email against the addresses that plausibly own it: leads we actually MAILED at that address (outreach
// recipients with a sent/sending/uncertain row - an unsent draft or skipped row proves no contact ever happened and must
// not associate a booking) plus leads storing it as their contact. Exactly one candidate lead across both -> linked;
// zero or several stay "unmatched" - a booking is never guessed onto a lead. Reads and writes run on the Db layer
// (SQLite or Postgres); migrateCalcom is the SQLite schema (PG: 0001 baseline + 0065_booking_outcomes.sql).
//
// Outcomes (#367). One row per Cal.com booking uid keeps the booking's history: no event deletes it. Each webhook is
// merged into the row field by field with order-independent rules, so any delivery order, retry or replay of the same
// events converges to the same row:
//   - meeting time and attendees: the version with the highest (iCalSequence, event createdAt) wins
//   - cancelled: set by any BOOKING_CANCELLED, never unset by a webhook (earliest cancel time kept)
//   - rescheduled: BOOKING_RESCHEDULED supersedes the old uid (rescheduled_to) and creates/updates the new uid
//     (rescheduled_from); Cal.com makes a reschedule a new booking, so the new uid carries the meeting from then on
//   - ended: MEETING_ENDED, which Cal.com fires at the scheduled end time whether or not anyone joined - it proves the
//     slot passed, NOT that the meeting was held
//   - no-show: BOOKING_NO_SHOW_UPDATED marks per attendee, the latest event per attendee wins
//   - lead link: recomputed from the winning attendee email whenever that email changes (an early no-show for a guest
//     can seed the row with the guest's address; the booking event names the primary attendee), so the lead credited
//     does not depend on delivery order
// The status is a pure function of those fields (bookingStatus). A meeting counts as `held` only on an actual
// completion signal: no Cal.com webhook proves one, so `held` comes only from an audited manual reconciliation
// (setManualOutcome), which also overrides the webhook-derived status when a person knows better - except on a booking
// that was rescheduled away: that one is no longer the meeting, whatever was marked on it before the reschedule arrived.

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
  `)
  // #367 outcome fields. created_at stays dazl's receipt time of the first event for this uid; *_ms are Cal.com event
  // times (ms); start_at, end_at, ended_at and manual_at are seconds.
  // Static statements (one per column), so the SQL audit sees schema DDL only (lib/db/sql-audit.ts).
  const cols = new Set((db.prepare('PRAGMA table_info(calcom_bookings)').all() as { name: string }[]).map(r => r.name))
  if (!cols.has('status')) db.exec("ALTER TABLE calcom_bookings ADD COLUMN status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'ended', 'held', 'no_show', 'cancelled', 'rescheduled'))")
  if (!cols.has('start_at')) db.exec('ALTER TABLE calcom_bookings ADD COLUMN start_at INTEGER')
  if (!cols.has('end_at')) db.exec('ALTER TABLE calcom_bookings ADD COLUMN end_at INTEGER')
  if (!cols.has('ical_uid')) db.exec('ALTER TABLE calcom_bookings ADD COLUMN ical_uid TEXT')
  if (!cols.has('ical_seq')) db.exec('ALTER TABLE calcom_bookings ADD COLUMN ical_seq INTEGER')
  if (!cols.has('detail_ms')) db.exec('ALTER TABLE calcom_bookings ADD COLUMN detail_ms INTEGER')
  if (!cols.has('attendees')) db.exec('ALTER TABLE calcom_bookings ADD COLUMN attendees TEXT')
  if (!cols.has('cancelled_ms')) db.exec('ALTER TABLE calcom_bookings ADD COLUMN cancelled_ms INTEGER')
  if (!cols.has('rescheduled_to')) db.exec('ALTER TABLE calcom_bookings ADD COLUMN rescheduled_to TEXT')
  if (!cols.has('rescheduled_from')) db.exec('ALTER TABLE calcom_bookings ADD COLUMN rescheduled_from TEXT')
  if (!cols.has('ended_at')) db.exec('ALTER TABLE calcom_bookings ADD COLUMN ended_at INTEGER')
  if (!cols.has('no_show_marks')) db.exec('ALTER TABLE calcom_bookings ADD COLUMN no_show_marks TEXT')
  if (!cols.has('manual_outcome')) db.exec("ALTER TABLE calcom_bookings ADD COLUMN manual_outcome TEXT CHECK (manual_outcome IS NULL OR manual_outcome IN ('held', 'no_show', 'cancelled'))")
  if (!cols.has('manual_at')) db.exec('ALTER TABLE calcom_bookings ADD COLUMN manual_at INTEGER')
  if (!cols.has('manual_by')) db.exec('ALTER TABLE calcom_bookings ADD COLUMN manual_by TEXT')
  if (!cols.has('last_event_ms')) db.exec('ALTER TABLE calcom_bookings ADD COLUMN last_event_ms INTEGER')
  if (!cols.has('lead_prev_stage')) db.exec('ALTER TABLE calcom_bookings ADD COLUMN lead_prev_stage TEXT')
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

export type { BookingStatus }
export { meetingOver, reconcileActions } from './outcome-rules.ts'
// A booking that still stands (counts as booked): not cancelled and not superseded by a reschedule.
export const STANDING: readonly BookingStatus[] = ['scheduled', 'ended', 'held', 'no_show']
export const STANDING_SQL = "('scheduled', 'ended', 'held', 'no_show')"
export type ManualOutcome = 'held' | 'no_show' | 'cancelled'
export type Attendee = { email: string; name: string | null }
type BookingTrigger = 'BOOKING_CREATED' | 'BOOKING_RESCHEDULED' | 'BOOKING_CANCELLED'
export type CalEvent =
  | { kind: 'booking'; trigger: BookingTrigger; uid: string; at: number | null; attendees: Attendee[]; startAt: number | null; endAt: number | null; icalUid: string | null; icalSeq: number | null; fromUid: string | null }
  | { kind: 'ended'; uid: string; attendees: Attendee[]; endAt: number | null }
  | { kind: 'no_show'; uid: string; at: number | null; marks: { email: string; noShow: boolean }[] }

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null)
const str = (v: unknown, max = 120): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const ms = (v: unknown): number | null => { const n = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(n) ? n : null }
const secs = (v: unknown): number | null => { const n = ms(v); return n === null ? null : Math.floor(n / 1000) }
const emailOf = (a: unknown): string => { const e = obj(a)?.email; return typeof e === 'string' ? normalizeEmail(e).slice(0, 254) : '' }
function attendeesOf(v: unknown): Attendee[] {
  const out: Attendee[] = []
  for (const a of Array.isArray(v) ? v.slice(0, 20) : []) {
    const email = emailOf(a)
    if (email && !out.some(o => o.email === email)) out.push({ email, name: str(obj(a)?.name, 150) })
  }
  return out
}

// The events dazl records. Anything else (other triggers, a payload without a uid or an attendee email, a reschedule
// that does not name the booking it replaces) is null and ignored - never half-applied.
export function parseEvent(rawBody: string): CalEvent | null {
  let body: Obj | null
  try { body = obj(JSON.parse(rawBody)) } catch { return null }
  if (!body) return null
  const trigger = body.triggerEvent
  const at = ms(body.createdAt)
  if (trigger === 'BOOKING_CREATED' || trigger === 'BOOKING_RESCHEDULED' || trigger === 'BOOKING_CANCELLED') {
    const p = obj(body.payload)
    const uid = str(p?.uid)
    const attendees = attendeesOf(p?.attendees)
    if (!p || !uid || !attendees.length) return null
    const fromUid = trigger === 'BOOKING_RESCHEDULED' ? str(p.rescheduleUid) : null
    if (trigger === 'BOOKING_RESCHEDULED' && (!fromUid || fromUid === uid)) return null
    const seq = typeof p.iCalSequence === 'number' && Number.isInteger(p.iCalSequence) && p.iCalSequence >= 0 ? p.iCalSequence : null
    return { kind: 'booking', trigger, uid, at, attendees, startAt: secs(p.startTime), endAt: secs(p.endTime), icalUid: str(p.iCalUID, 200), icalSeq: seq, fromUid }
  }
  if (trigger === 'MEETING_ENDED') { // flat payload: the booking's fields sit at the top level
    const uid = str(body.uid)
    const attendees = attendeesOf(body.attendees)
    return uid && attendees.length ? { kind: 'ended', uid, attendees, endAt: secs(body.endTime) } : null
  }
  if (trigger === 'BOOKING_NO_SHOW_UPDATED') {
    const p = obj(body.payload)
    const uid = str(p?.bookingUid)
    const marks: { email: string; noShow: boolean }[] = []
    for (const a of Array.isArray(p?.attendees) ? (p.attendees as unknown[]).slice(0, 20) : []) {
      const email = emailOf(a), noShow = obj(a)?.noShow
      if (email && typeof noShow === 'boolean' && !marks.some(m => m.email === email)) marks.push({ email, noShow })
    }
    return uid && marks.length ? { kind: 'no_show', uid, at, marks } : null
  }
  return null
}

// BOOKING_CREATED only, first attendee: the shape callers had before #367.
export function parseBooking(rawBody: string): { uid: string; email: string; name: string | null } | null {
  const e = parseEvent(rawBody)
  return e?.kind === 'booking' && e.trigger === 'BOOKING_CREATED' ? { uid: e.uid, email: e.attendees[0].email, name: e.attendees[0].name } : null
}

type NoShowMarks = Record<string, { noShow: boolean; ms: number }>
export interface BookingRow {
  booking_uid: string; attendee_email: string; attendee_name: string | null; lead_id: string | null; status: BookingStatus
  start_at: number | null; end_at: number | null; ical_uid: string | null; ical_seq: number | null; detail_ms: number | null; attendees: string | null
  cancelled_ms: number | null; rescheduled_to: string | null; rescheduled_from: string | null; ended_at: number | null; no_show_marks: string | null
  manual_outcome: ManualOutcome | null; manual_at: number | null; manual_by: string | null; last_event_ms: number | null; lead_prev_stage: string | null
}
// Every column an event or a reconciliation may change (the UPDATE writes exactly these).
const FIELDS = ['attendee_email', 'attendee_name', 'lead_id', 'status', 'start_at', 'end_at', 'ical_uid', 'ical_seq', 'detail_ms', 'attendees', 'cancelled_ms',
  'rescheduled_to', 'rescheduled_from', 'ended_at', 'no_show_marks', 'manual_outcome', 'manual_at', 'manual_by', 'last_event_ms', 'lead_prev_stage'] as const
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const normRow = (r: Record<string, unknown>): BookingRow => {
  const out = {} as Record<string, unknown>
  out.booking_uid = r.booking_uid
  for (const f of FIELDS) out[f] = r[f] ?? null
  for (const f of ['start_at', 'end_at', 'ical_seq', 'detail_ms', 'cancelled_ms', 'ended_at', 'manual_at', 'last_event_ms']) out[f] = num(r[f])
  return out as unknown as BookingRow
}
const marksOf = (s: string | null): NoShowMarks => { try { return s ? JSON.parse(s) as NoShowMarks : {} } catch { return {} } }
const maxStr = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a > b ? a : b)
const maxNum = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b))
const minNum = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b))

// The status a row's fields imply. Superseded by a reschedule wins over everything, a manual reconciliation included (a
// reschedule notice that arrives after someone marked the old uid held still moves the meeting: the manual fields and
// the audit stay on the row as history); then a manual reconciliation; then cancelled > the primary attendee marked
// no-show > the slot ended (outcome unconfirmed) > scheduled.
export function bookingStatus(r: Pick<BookingRow, 'manual_outcome' | 'rescheduled_to' | 'cancelled_ms' | 'ended_at' | 'no_show_marks' | 'attendee_email'>): BookingStatus {
  if (r.rescheduled_to) return 'rescheduled'
  if (r.manual_outcome) return r.manual_outcome
  if (r.cancelled_ms !== null) return 'cancelled'
  if (marksOf(r.no_show_marks)[r.attendee_email]?.noShow) return 'no_show'
  if (r.ended_at !== null) return 'ended'
  return 'scheduled'
}

// Merge one event into one row (pure). `superseded`: this row is the old uid a BOOKING_RESCHEDULED names.
export function mergeEvent(row: BookingRow, ev: CalEvent, superseded = false): BookingRow {
  const r: BookingRow = { ...row }
  if (ev.kind === 'booking' && superseded) {
    r.rescheduled_to = maxStr(r.rescheduled_to, ev.uid)
    // No booking event for this uid yet: its attendee email is only the guess of whichever event inserted the row (a
    // no-show notice names the attendee it marks, maybe a guest). The reschedule names the meeting's attendees, primary
    // first, the same address a reschedule-first insert takes, so the row (and its lead link) converges either way.
    if (r.detail_ms === null) Object.assign(r, { attendee_email: ev.attendees[0].email, attendee_name: ev.attendees[0].name })
  } else if (ev.kind === 'booking') {
    const json = JSON.stringify(ev.attendees)
    const next = [ev.icalSeq ?? -1, ev.at ?? -1, `${ev.startAt}|${ev.endAt}|${ev.icalUid}|${json}`] as const
    const cur = r.detail_ms === null ? null : [r.ical_seq ?? -1, r.detail_ms, `${r.start_at}|${r.end_at}|${r.ical_uid}|${r.attendees}`] as const
    if (!cur || next[0] > cur[0] || (next[0] === cur[0] && (next[1] > cur[1] || (next[1] === cur[1] && next[2] > cur[2])))) {
      Object.assign(r, { start_at: ev.startAt, end_at: ev.endAt, ical_uid: ev.icalUid, ical_seq: ev.icalSeq, detail_ms: ev.at ?? -1, attendees: json, attendee_email: ev.attendees[0].email, attendee_name: ev.attendees[0].name })
    }
    if (ev.trigger === 'BOOKING_CANCELLED') r.cancelled_ms = minNum(r.cancelled_ms, ev.at ?? 0)
    if (ev.trigger === 'BOOKING_RESCHEDULED') r.rescheduled_from = maxStr(r.rescheduled_from, ev.fromUid)
  } else if (ev.kind === 'ended') {
    r.ended_at = maxNum(r.ended_at, ev.endAt ?? 0)
    // MEETING_ENDED names the booking's attendees, primary first: until a booking event brings the detail, that is the
    // row's attendee (the same rule as a superseding reschedule), whatever no-show notice arrived before it
    if (r.detail_ms === null) Object.assign(r, { attendee_email: ev.attendees[0].email, attendee_name: ev.attendees[0].name })
  } else {
    const marks = marksOf(r.no_show_marks)
    const t = ev.at ?? -1
    for (const m of ev.marks) {
      const cur = marks[m.email]
      if (!cur && Object.keys(marks).length >= 20) continue
      if (!cur || t > cur.ms || (t === cur.ms && m.noShow && !cur.noShow)) marks[m.email] = { noShow: m.noShow, ms: t }
    }
    r.no_show_marks = JSON.stringify(Object.fromEntries(Object.entries(marks).sort(([a], [b]) => (a < b ? -1 : 1))))
  }
  if (ev.kind !== 'ended') r.last_event_ms = maxNum(r.last_event_ms, ev.at)
  r.status = bookingStatus(r)
  return r
}

function* lockRow(t: Tx, tenantId: string, uid: string, lock = true): TxBody<BookingRow | null> {
  const r = yield* t.get<Record<string, unknown>>(`SELECT * FROM calcom_bookings WHERE tenant_id = ? AND booking_uid = ?${lock && t.kind === 'pg' ? ' FOR UPDATE' : ''}`, [tenantId, uid])
  return r ? normRow(r) : null
}
// The lead rows whose stage this transaction may move, locked in id order before any standing() read. A lead's stage
// depends on ALL its bookings, and the booking row locks only cover the touched uids: without this, two concurrent
// cancellations of two different bookings of one lead (Postgres, READ COMMITTED) each still see the other booking
// standing, both read standing true -> true and neither restores the stage. Holding the lead lock through the writes
// and syncStage serializes them: the second sees the first one's committed cancel. Every writer of calcom_bookings
// takes lead locks before booking-row locks (recordEvent, setManualOutcome), so the clean-up writes syncStage makes to
// other bookings of a locked lead never wait on a transaction that is itself waiting for that lead. SQLite: the
// transaction is BEGIN IMMEDIATE (one writer for its whole length), so there is nothing to lock and FOR UPDATE, which
// SQLite does not parse, is omitted - the same pattern as lockRow and lib/billing/stripe.ts.
function* lockLeads(t: Tx, tenantId: string, ids: Iterable<string>): TxBody<void> {
  for (const id of [...new Set(ids)].sort()) {
    yield* t.get(`SELECT l.id FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?${t.kind === 'pg' ? ' FOR UPDATE OF l' : ''}`, [id, tenantId])
  }
}
function* writeRow(t: Tx, tenantId: string, r: BookingRow): TxBody<void> {
  yield* t.run(`UPDATE calcom_bookings SET ${FIELDS.map(f => `${f} = ?`).join(', ')} WHERE tenant_id = ? AND booking_uid = ?`, [...FIELDS.map(f => r[f]), tenantId, r.booking_uid])
}
const changed = (a: BookingRow, b: BookingRow) => FIELDS.some(f => a[f] !== b[f])

function* standing(t: Tx, tenantId: string, leadId: string): TxBody<boolean> {
  return !!(yield* t.get(`SELECT 1 AS x FROM calcom_bookings WHERE tenant_id = ? AND lead_id = ? AND status IN ${STANDING_SQL} LIMIT 1`, [tenantId, leadId]))
}

// Candidate leads for this address: ones we actually mailed at it (a sent/sending/uncertain outreach row - a
// contact-page crawled address counts as much as a stored one, #364; 'uncertain' may have gone out, so it counts, while
// draft/approved/skipped prove no contact and are excluded) plus ones storing it as their contact. Exactly one
// candidate -> that lead; anything else (zero, or conflicting candidates from either source) -> null, never guessed.
function* matchLead(t: Tx, tenantId: string, email: string): TxBody<string | null> {
  if (!email) return null // primary attendee not known yet (a row only no-show notices have named): never linked
  const emailed = yield* t.all<{ lead_id: string }>("SELECT DISTINCT lead_id FROM outreach_messages WHERE tenant_id = ? AND lower(to_email) = ? AND status IN ('sent','sending','uncertain') AND lead_id IS NOT NULL", [tenantId, email])
  const stored = yield* t.all<{ id: string }>('SELECT l.id FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? AND l.contact IS NOT NULL AND lower(l.contact) = ?', [tenantId, email])
  const candidates = new Set([...emailed.map((r) => r.lead_id), ...stored.map((r) => r.id)])
  return candidates.size === 1 ? [...candidates][0] : null
}

// The lead's stage follows whether it has a standing booking. Gaining one sets 'booked_call' and remembers the stage it
// replaced on that booking row ('' = no stage); losing the last one (cancelled, rescheduled away) restores it, but only
// while the stage is still 'booked_call' - a stage someone changed by hand since is left alone. Driven by the standing
// state before and after, not by which event arrived, so the stage converges like the rows do. `carried`: the stage a
// booking remembered for this lead when the booking's link just moved to another lead (it no longer sits on a row of
// this lead): used to restore, or parked on another standing booking of this lead if the lead still has one.
function* syncStage(t: Tx, tenantId: string, leadId: string, before: boolean, rows: BookingRow[], carried?: string): TxBody<void> {
  const after = yield* standing(t, tenantId, leadId)
  if (before === after) {
    if (after && carried !== undefined && !(yield* t.get('SELECT 1 AS x FROM calcom_bookings WHERE tenant_id = ? AND lead_id = ? AND lead_prev_stage IS NOT NULL LIMIT 1', [tenantId, leadId]))) {
      const keep = yield* t.get<{ booking_uid: string }>(`SELECT booking_uid FROM calcom_bookings WHERE tenant_id = ? AND lead_id = ? AND status IN ${STANDING_SQL} ORDER BY booking_uid LIMIT 1`, [tenantId, leadId])
      if (keep) yield* t.run('UPDATE calcom_bookings SET lead_prev_stage = ? WHERE tenant_id = ? AND booking_uid = ?', [carried, tenantId, keep.booking_uid])
    }
    return
  }
  const lead = yield* t.get<{ stage: string | null }>('SELECT l.stage FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?', [leadId, tenantId])
  if (!lead) return
  if (after) {
    const holder = rows.find(r => r.lead_id === leadId && STANDING.includes(r.status))
    if (lead.stage === 'booked_call' || !holder) return
    yield* t.run('UPDATE calcom_bookings SET lead_prev_stage = ? WHERE tenant_id = ? AND booking_uid = ?', [lead.stage ?? '', tenantId, holder.booking_uid])
    yield* t.run("UPDATE leads SET stage = 'booked_call' WHERE id = ?", [leadId])
    return
  }
  const row = yield* t.get<{ lead_prev_stage: string }>('SELECT lead_prev_stage FROM calcom_bookings WHERE tenant_id = ? AND lead_id = ? AND lead_prev_stage IS NOT NULL ORDER BY booking_uid LIMIT 1', [tenantId, leadId])
  const prev = row?.lead_prev_stage ?? carried
  if (prev !== undefined && lead.stage === 'booked_call') yield* t.run('UPDATE leads SET stage = ? WHERE id = ?', [prev === '' ? null : prev, leadId])
  yield* t.run('UPDATE calcom_bookings SET lead_prev_stage = NULL WHERE tenant_id = ? AND lead_id = ? AND lead_prev_stage IS NOT NULL', [tenantId, leadId])
}

export type EventOutcome = { outcome: 'duplicate' | 'matched' | 'unmatched'; status: BookingStatus }

// The event merged into the touched rows, and each row's lead link: recomputed when the row has none yet or its winning
// attendee email changed. A row whose link moves leaves its remembered stage with the lead it came from (`carried`).
function* plan(t: Tx, tenantId: string, ev: CalEvent, rows: BookingRow[]): TxBody<{ next: BookingRow[]; carried: Map<string, string> }> {
  const next = rows.map(r => mergeEvent(r, ev, r.booking_uid !== ev.uid))
  const carried = new Map<string, string>()
  for (let i = 0; i < next.length; i++) {
    const o = rows[i], n = next[i]
    if (n.lead_id === null || n.attendee_email !== o.attendee_email) n.lead_id = yield* matchLead(t, tenantId, n.attendee_email)
    if (o.lead_id !== null && n.lead_id !== o.lead_id) {
      if (o.lead_prev_stage !== null && !carried.has(o.lead_id)) carried.set(o.lead_id, o.lead_prev_stage)
      n.lead_prev_stage = null
    }
  }
  return { next, carried }
}
const leadsOf = (...sets: BookingRow[][]) => [...new Set(sets.flat().map(r => r.lead_id).filter((l): l is string => l !== null))].sort()

// A transaction that found, after taking its booking-row locks, that it needs a lead lock it did not take first. Taking
// it now would lock a lead after a booking row, against the one lock order, and could deadlock; instead the transaction
// rolls back and reruns with that lead in its lock plan from the start (withLeadRelock).
class LeadRelockNeeded extends Error {
  readonly leads: string[]
  constructor(leads: string[]) { super('calcom: lead lock plan changed under a concurrent commit'); this.leads = leads }
}
const RELOCK_ATTEMPTS = 3
// Run `body` (one transaction) with the lead ids to lock up front; on LeadRelockNeeded rerun it with those leads added,
// at most RELOCK_ATTEMPTS times in all (each rerun needs yet another concurrent relink in its own short window).
async function withLeadRelock<R>(run: (extra: string[]) => Promise<R>): Promise<R> {
  let extra: string[] = []
  for (let attempt = 1; ; attempt++) {
    try { return await run(extra) } catch (e) {
      if (!(e instanceof LeadRelockNeeded) || attempt >= RELOCK_ATTEMPTS) throw e
      extra = [...new Set([...extra, ...e.leads])].sort()
    }
  }
}

// One transaction per event: the touched booking rows, every lead link they had or get, and those leads' stages land
// together. Lock order, always: the affected lead rows (id order, lockLeads), then the touched booking rows (uid order,
// FOR UPDATE on Postgres). Which leads are affected depends on the rows, so they are first read unlocked to plan the lead
// locks; if a concurrent commit changed a row in between, the plan is redone on the locked rows, and if that plan needs
// a lead not locked yet the transaction is rerun with it (LeadRelockNeeded) rather than lock it out of order.
// 'duplicate' = the event changed nothing (a Cal.com retry or a replay); otherwise matched/unmatched says whether the
// event's booking has a lead. A row a no-show notice inserts has no attendee yet ('': the notice names whom it marks,
// not the primary attendee) and stays unlinked until a booking, reschedule or MEETING_ENDED event names the attendee.
export function recordEvent(db: Db, tenantId: string, ev: CalEvent, nowS = Math.floor(Date.now() / 1000)): Promise<EventOutcome> {
  const first = ev.kind === 'no_show' ? { email: '', name: null } : ev.attendees[0]
  const uids = [...new Set([ev.uid, ...(ev.kind === 'booking' && ev.fromUid ? [ev.fromUid] : [])])].sort()
  return withLeadRelock(extra => db.tx(function* (t: Tx): TxBody<EventOutcome> {
    let dirty = false
    for (const uid of uids) {
      const ins = yield* t.run('INSERT INTO calcom_bookings (tenant_id, booking_uid, attendee_email, attendee_name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant_id, booking_uid) DO NOTHING', [tenantId, uid, first.email, first.name, nowS])
      if (ins.changes > 0) dirty = true
    }
    const seen: BookingRow[] = []
    for (const uid of uids) seen.push((yield* lockRow(t, tenantId, uid, false))!)
    const guess = yield* plan(t, tenantId, ev, seen)
    const locked = [...new Set([...leadsOf(seen, guess.next), ...extra])]
    yield* lockLeads(t, tenantId, locked)
    const old: BookingRow[] = []
    for (const uid of uids) old.push((yield* lockRow(t, tenantId, uid))!)
    const { next, carried } = old.some((r, i) => changed(r, seen[i])) ? yield* plan(t, tenantId, ev, old) : guess
    const leads = leadsOf(old, next)
    const missing = leads.filter(l => !locked.includes(l))
    if (missing.length) throw new LeadRelockNeeded(missing)
    const before = new Map<string, boolean>()
    for (const l of leads) before.set(l, yield* standing(t, tenantId, l))
    for (let i = 0; i < next.length; i++) if (changed(old[i], next[i])) { dirty = true; yield* writeRow(t, tenantId, next[i]) }
    for (const l of leads) yield* syncStage(t, tenantId, l, before.get(l)!, next, carried.get(l))
    const own = next.find(r => r.booking_uid === ev.uid)!
    return { outcome: dirty ? (own.lead_id ? 'matched' : 'unmatched') : 'duplicate', status: own.status }
  }))
}

// The pre-#367 entry point (a BOOKING_CREATED for one attendee); returns only the match outcome.
export async function recordBooking(db: Db, tenantId: string, b: { uid: string; email: string; name: string | null }): Promise<'duplicate' | 'matched' | 'unmatched'> {
  const ev: CalEvent = { kind: 'booking', trigger: 'BOOKING_CREATED', uid: b.uid, at: null, attendees: [{ email: normalizeEmail(b.email), name: b.name }], startAt: null, endAt: null, icalUid: null, icalSeq: null, fromUid: null }
  return (await recordEvent(db, tenantId, ev)).outcome
}

export type ManualResult = { ok: true; status: BookingStatus } | { ok: false; error: 'not_found' | 'superseded' | 'not_yet' }

// Audited manual reconciliation, the only source of `held`. held / no_show need the meeting to be over (meetingOver: its
// scheduled end has passed or Cal.com reported MEETING_ENDED); with neither known the claim is refused (fail closed),
// and the settings panel offers the buttons by the same predicate. The lead is locked before the booking row, the
// recordEvent lock order, rerun the same way if a concurrent relink changes the lead (lockLeads explains why the lead
// lock is needed at all). A booking that was
// rescheduled away is not the meeting any more: reconcile the uid it moved to. outcome null clears the override and the
// webhook-derived status applies again. The audit event commits in the same transaction as the change.
export function setManualOutcome(db: Db, tenantId: string, actorId: string, uid: string, outcome: ManualOutcome | null, ctx: { correlationId?: string | null } = {}, nowS = Math.floor(Date.now() / 1000)): Promise<ManualResult> {
  return withLeadRelock(extra => db.tx(function* (t: Tx): TxBody<ManualResult> {
    const seen = yield* lockRow(t, tenantId, uid, false)
    if (!seen) return { ok: false, error: 'not_found' }
    const locked = [...new Set([...(seen.lead_id ? [seen.lead_id] : []), ...extra])]
    yield* lockLeads(t, tenantId, locked)
    const row = (yield* lockRow(t, tenantId, uid))! // booking rows are never deleted
    if (row.lead_id && !locked.includes(row.lead_id)) throw new LeadRelockNeeded([row.lead_id]) // relinked by a commit in between
    if (row.rescheduled_to) return { ok: false, error: 'superseded' }
    if ((outcome === 'held' || outcome === 'no_show') && !meetingOver(row, nowS)) return { ok: false, error: 'not_yet' }
    const next: BookingRow = { ...row, manual_outcome: outcome, manual_at: outcome ? nowS : null, manual_by: outcome ? actorId.slice(0, 80) : null }
    next.status = bookingStatus(next)
    const before = row.lead_id ? yield* standing(t, tenantId, row.lead_id) : false
    if (changed(row, next)) yield* writeRow(t, tenantId, next)
    if (row.lead_id) yield* syncStage(t, tenantId, row.lead_id, before, [next])
    yield* recordTx(t, { tenantId, actorId, action: 'booking.outcome_set', resourceType: 'calcom_booking', resourceId: uid.slice(0, 80), summary: { from: row.status, to: next.status, manual: outcome ?? 'cleared' }, correlationId: ctx.correlationId ?? null }, nowS)
    return { ok: true, status: next.status }
  }))
}

// Newest first; same-second bookings by booking uid, the order SQLite's primary-key index gave.
export function listBookings(db: Db, tenantId: string, limit = 50) {
  return db.all(`
    SELECT b.booking_uid, b.attendee_email, b.attendee_name, b.created_at, b.lead_id, l.company, l.name AS lead_name,
           b.status, b.start_at, b.end_at, b.ended_at, b.rescheduled_to, b.rescheduled_from, b.manual_outcome, b.manual_at
    FROM calcom_bookings b LEFT JOIN leads l ON l.id = b.lead_id
    WHERE b.tenant_id = ? ORDER BY b.created_at DESC, b.booking_uid LIMIT ?`, [tenantId, limit])
}
