// Mail dazl itself sends to an account (verification and reset links), as opposed to outreach, which goes out
// through the tenant's own Gmail. Delivery is SMTP when SYSTEM_MAIL_SMTP_URL and SYSTEM_MAIL_FROM are both set.
// Otherwise nothing leaves the host: the message is kept in system_mail_outbox (operators read it on the host, and
// tests read it), and dropped after OUTBOX_RETAIN_S.
import { randomBytes } from 'node:crypto'
import type { Db, Tx, TxBody } from './db/client.ts'

// SQLite: migrateAuth (lib/auth-db.ts); PG: 0023_email_ownership.sql.
export const OUTBOX_DDL = `
  CREATE TABLE IF NOT EXISTS system_mail_outbox (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS system_mail_outbox_created ON system_mail_outbox (created_at);
`
export const OUTBOX_RETAIN_S = 24 * 60 * 60
export type SystemMail = { userId: string; to: string; subject: string; text: string }
export type Transport = (m: { from: string; to: string; subject: string; text: string }) => Promise<void>

let override: Transport | null = null
// Tests replace the SMTP transport; the app never calls this.
export function setTransportForTests(t: Transport | null): void { override = t }

async function smtp(url: string): Promise<Transport> {
  const nodemailer = await import('nodemailer')
  const tx = nodemailer.createTransport(url)
  return async m => { await tx.sendMail(m) }
}

export const systemMailAvailable = (env: Record<string, string | undefined> = process.env): boolean => !!(env.SYSTEM_MAIL_SMTP_URL && env.SYSTEM_MAIL_FROM)

export async function sendSystemMail(db: Db, m: SystemMail, env: Record<string, string | undefined> = process.env): Promise<'sent' | 'outbox'> {
  const url = env.SYSTEM_MAIL_SMTP_URL, from = env.SYSTEM_MAIL_FROM
  if (url && from) {
    await (override ?? await smtp(url))({ from, to: m.to, subject: m.subject, text: m.text })
    return 'sent'
  }
  await db.run('INSERT INTO system_mail_outbox (id, user_id, to_email, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [randomBytes(12).toString('hex'), m.userId, m.to, m.subject, m.text, Math.floor(Date.now() / 1000)])
  return 'outbox'
}

// #1089: how old a stored row may be before readiness calls the outbox stale. A row is stored only when
// SMTP is not configured (sendSystemMail above) — on a healthy deployment the table stays empty, so a row
// older than this means account mail is being written here instead of sent, or the reaper above is not
// running: the prod failure behind this issue (rows sat for weeks, each holding a live link). Five minutes
// is the triage's number: long enough that a just-stored row mid-incident is not yet an alarm.
export const OUTBOX_STALE_S = 5 * 60
export type OutboxCheck =
  | { ok: true; stored: number; oldest_age_s: number | null }
  | { ok: false; reason: 'stale'; stored: number; oldest_age_s: number }
  | { ok: false; reason: 'error' }

// Single-flight per store (Qodo on #1754): readiness races this read against a deadline and stops
// waiting, but a stalled query keeps its pool connection, so concurrent probes must not each start
// their own read. One in-flight read per Db, shared until it settles, then cleared.
const outboxFlights = new WeakMap<Db, Promise<OutboxCheck>>()

// What readiness reports about the stored outbox (lib/ops/health.ts, checks.outbox). Counts and the oldest
// row's age only — never a recipient, subject or body. Never throws: a store that cannot be read is itself
// the finding ('error'), and readiness must still answer.
export function outboxReadiness(db: Db, now: number = Math.floor(Date.now() / 1000)): Promise<OutboxCheck> {
  const existing = outboxFlights.get(db)
  if (existing) return existing
  const p = readOutbox(db, now)
  outboxFlights.set(db, p)
  void p.finally(() => { if (outboxFlights.get(db) === p) outboxFlights.delete(db) })
  return p
}

async function readOutbox(db: Db, now: number): Promise<OutboxCheck> {
  try {
    const row = await db.get<{ n: number | string; oldest: number | string | null }>('SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM system_mail_outbox')
    const stored = Number(row?.n ?? 0)
    if (!stored || row?.oldest == null) return { ok: true, stored: 0, oldest_age_s: null }
    const oldest_age_s = Math.max(0, now - Number(row.oldest))
    return oldest_age_s > OUTBOX_STALE_S
      ? { ok: false, reason: 'stale', stored, oldest_age_s }
      : { ok: true, stored, oldest_age_s }
  } catch { return { ok: false, reason: 'error' } }
}

// Run from the scheduled tick, fenced by its lease.
export async function reapOutbox(db: Db, o: { now?: number; fence?: (t: Tx) => TxBody<void> } = {}): Promise<number> {
  const cutoff = (o.now ?? Math.floor(Date.now() / 1000)) - OUTBOX_RETAIN_S
  return db.tx(function* (t) {
    if (o.fence) yield* o.fence(t)
    return (yield* t.run('DELETE FROM system_mail_outbox WHERE created_at <= ?', [cutoff])).changes
  })
}
