import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from '../db/client.ts'
import { contactForEmailTx, resolveLead } from '../accounts/graph.ts'

// Cal.com booking webhooks -> pipeline stage. A booking is matched to a lead by the attendee's
// normalized email against lead.contact. Zero or several matches stay "unmatched" - a booking is
// never guessed onto a lead. Idempotent on (tenant, booking uid): Cal.com retries are safe.
// Reads and writes run on the Db layer (SQLite or Postgres); migrateCalcom is the SQLite schema.

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
  // The canonical contact the booking resolved to (lib/accounts/graph.ts, #364), when it resolved to one.
  if (!(db.prepare('PRAGMA table_info(calcom_bookings)').all() as { name: string }[]).some(c => c.name === 'contact_id')) db.exec('ALTER TABLE calcom_bookings ADD COLUMN contact_id TEXT')
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

export function parseBooking(rawBody: string): { uid: string; email: string; name: string | null } | null {
  let body: { triggerEvent?: unknown; payload?: { uid?: unknown; attendees?: unknown } }
  try { body = JSON.parse(rawBody) } catch { return null }
  if (body?.triggerEvent !== 'BOOKING_CREATED' || !body.payload) return null
  const uid = typeof body.payload.uid === 'string' ? body.payload.uid.slice(0, 120) : ''
  const attendees = Array.isArray(body.payload.attendees) ? body.payload.attendees : []
  const first = attendees[0] as { email?: unknown; name?: unknown } | undefined
  const email = normalizeEmail(typeof first?.email === 'string' ? first.email : '')
  if (!uid || !email) return null
  return { uid, email, name: typeof first?.name === 'string' ? first.name.slice(0, 150) : null }
}

export const normalizeEmail = (s: string) => s.trim().toLowerCase()

// Returns 'duplicate' when this booking was already recorded, otherwise the match outcome. One transaction: the
// booking, the leads' stage and the booking's links land together. A duplicate is skipped by the primary key
// (ON CONFLICT DO NOTHING): the table has no CHECK, and parseBooking always gives a uid and an email, so this skips
// exactly what INSERT OR IGNORE skipped.
// Matching: the canonical contact only (lib/accounts/graph.ts). Every lead of the tenant carrying the attendee's email is
// resolved first (whatever backlog a bounded sync left); the booking matches when the email names one contact and every
// one of those leads is linked to it (the same person found by several plays: each lead is booked, the booking points at
// the contact and its newest lead). A lead held for identity review, a lead linked without that contact, several
// candidate contacts, or an identity that could not be resolved leaves the booking unmatched: never guessed, and a
// single lead with that email is not enough on its own any more (it may be quarantined against another company).
export async function recordBooking(db: Db, tenantId: string, b: { uid: string; email: string; name: string | null }): Promise<'duplicate' | 'matched' | 'unmatched'> {
  const email = normalizeEmail(b.email)
  let resolved = true
  try {
    const leads = await db.all<{ id: string }>('SELECT l.id FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? AND l.contact IS NOT NULL AND lower(trim(l.contact)) = ? ORDER BY l.id LIMIT 51', [tenantId, email])
    if (leads.length > 50) resolved = false
    else for (const l of leads) await resolveLead(db, tenantId, l.id)
  } catch { resolved = false }
  return db.tx(function* (t: Tx): TxBody<'duplicate' | 'matched' | 'unmatched'> {
    const ins = yield* t.run('INSERT INTO calcom_bookings (tenant_id, booking_uid, attendee_email, attendee_name) VALUES (?, ?, ?, ?) ON CONFLICT (tenant_id, booking_uid) DO NOTHING', [tenantId, b.uid, email, b.name])
    if (ins.changes === 0) return 'duplicate'
    const c = resolved ? yield* contactForEmailTx(t, tenantId, email) : null
    if (!c) return 'unmatched'
    for (const id of c.lead_ids) yield* t.run("UPDATE leads SET stage = 'booked_call' WHERE id = ?", [id])
    yield* t.run('UPDATE calcom_bookings SET lead_id = ?, contact_id = ? WHERE tenant_id = ? AND booking_uid = ?', [c.lead_ids[c.lead_ids.length - 1], c.contact_id, tenantId, b.uid])
    return 'matched'
  })
}

// Newest first; same-second bookings by booking uid, the order SQLite's primary-key index gave.
export function listBookings(db: Db, tenantId: string, limit = 50) {
  return db.all(`
    SELECT b.booking_uid, b.attendee_email, b.attendee_name, b.created_at, b.lead_id, l.company, l.name AS lead_name
    FROM calcom_bookings b LEFT JOIN leads l ON l.id = b.lead_id
    WHERE b.tenant_id = ? ORDER BY b.created_at DESC, b.booking_uid LIMIT ?`, [tenantId, limit])
}
