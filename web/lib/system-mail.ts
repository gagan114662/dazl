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

// Run from the scheduled tick, fenced by its lease.
export async function reapOutbox(db: Db, o: { now?: number; fence?: (t: Tx) => TxBody<void> } = {}): Promise<number> {
  const cutoff = (o.now ?? Math.floor(Date.now() / 1000)) - OUTBOX_RETAIN_S
  return db.tx(function* (t) {
    if (o.fence) yield* o.fence(t)
    return (yield* t.run('DELETE FROM system_mail_outbox WHERE created_at <= ?', [cutoff])).changes
  })
}
