import crypto from 'node:crypto'
import type Database from 'better-sqlite3'

// Cal.com booking webhooks -> pipeline stage. A booking is matched to a lead by the attendee's
// normalized email against lead.contact. Zero or several matches stay "unmatched" - a booking is
// never guessed onto a lead. Idempotent on (tenant, booking uid): Cal.com retries are safe.

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
}

export function getSecret(db: Database.Database, tenantId: string): string | null {
  const r = db.prepare('SELECT secret FROM calcom_hooks WHERE tenant_id = ?').get(tenantId) as { secret: string } | undefined
  return r?.secret ?? null
}

export function rotateSecret(db: Database.Database, tenantId: string): string {
  const secret = crypto.randomBytes(24).toString('base64url')
  db.prepare("INSERT INTO calcom_hooks (tenant_id, secret) VALUES (?, ?) ON CONFLICT(tenant_id) DO UPDATE SET secret = excluded.secret, created_at = CAST(strftime('%s','now') AS INTEGER)").run(tenantId, secret)
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

// Returns 'duplicate' when this booking was already recorded, otherwise the match outcome.
export function recordBooking(db: Database.Database, tenantId: string, b: { uid: string; email: string; name: string | null }): 'duplicate' | 'matched' | 'unmatched' {
  const email = normalizeEmail(b.email)
  const ins = db.prepare('INSERT OR IGNORE INTO calcom_bookings (tenant_id, booking_uid, attendee_email, attendee_name) VALUES (?, ?, ?, ?)').run(tenantId, b.uid, email, b.name)
  if (ins.changes === 0) return 'duplicate'
  // Exactly one lead with this contact email across the tenant's jobs -> book it. Anything else stays unmatched.
  const rows = db.prepare('SELECT l.id FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? AND l.contact IS NOT NULL AND lower(l.contact) = ?').all(tenantId, email) as { id: string }[]
  if (rows.length === 1) {
    db.prepare("UPDATE leads SET stage = 'booked_call' WHERE id = ?").run(rows[0].id)
    db.prepare('UPDATE calcom_bookings SET lead_id = ? WHERE tenant_id = ? AND booking_uid = ?').run(rows[0].id, tenantId, b.uid)
    return 'matched'
  }
  return 'unmatched'
}

export function listBookings(db: Database.Database, tenantId: string, limit = 50) {
  return db.prepare(`
    SELECT b.booking_uid, b.attendee_email, b.attendee_name, b.created_at, b.lead_id, l.company, l.name AS lead_name
    FROM calcom_bookings b LEFT JOIN leads l ON l.id = b.lead_id
    WHERE b.tenant_id = ? ORDER BY b.created_at DESC LIMIT ?`).all(tenantId, limit)
}
