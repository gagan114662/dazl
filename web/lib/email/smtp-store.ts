import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db } from '../db/client.ts'
import { decryptSecret, encryptSecret } from '../secrets.ts'

type Mailbox = { host: string; port: number; username: string; password: string }
type MailboxStatus = Omit<Mailbox, 'password'> & { id: string }

export function migrateSmtpMailboxes(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mailbox_connections (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('smtp', 'gmail', 'outlook')),
      smtp_host TEXT, smtp_port INTEGER, smtp_username TEXT, smtp_password_encrypted TEXT,
      imap_host TEXT, imap_port INTEGER, imap_username TEXT, imap_password_encrypted TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, provider)
    );
  `)
}

const context = (workspaceId: string, id: string) => `smtp-mailbox:${workspaceId}:${id}`

export async function saveSmtpMailbox(db: Db, workspaceId: string, mailbox: Mailbox, master?: Buffer): Promise<string> {
  const id = randomUUID()
  const now = new Date().toISOString()
  const ciphertext = encryptSecret(mailbox.password, context(workspaceId, id), master)
  await db.run(`
    INSERT INTO mailbox_connections (id, workspace_id, provider, smtp_host, smtp_port, smtp_username,
      smtp_password_encrypted, created_at, updated_at)
    VALUES (?, ?, 'smtp', ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, provider) DO UPDATE SET id = excluded.id, smtp_host = excluded.smtp_host,
      smtp_port = excluded.smtp_port, smtp_username = excluded.smtp_username,
      smtp_password_encrypted = excluded.smtp_password_encrypted, updated_at = excluded.updated_at
  `, [id, workspaceId, mailbox.host, mailbox.port, mailbox.username, ciphertext, now, now])
  return id
}

const STATUS_FIELDS = 'id, smtp_host AS host, smtp_port AS port, smtp_username AS username'
const SMTP_ROW = "FROM mailbox_connections WHERE workspace_id = ? AND provider = 'smtp'"

export async function smtpMailboxStatus(db: Db, workspaceId: string): Promise<MailboxStatus | null> {
  return await db.get<MailboxStatus>(`SELECT ${STATUS_FIELDS} ${SMTP_ROW}`, [workspaceId]) ?? null
}

export async function loadSmtpMailbox(db: Db, workspaceId: string, id: string, master?: Buffer): Promise<Mailbox | null> {
  const row = await db.get<MailboxStatus & { ciphertext: string }>(
    `SELECT ${STATUS_FIELDS}, smtp_password_encrypted AS ciphertext ${SMTP_ROW} AND id = ?`, [workspaceId, id],
  )
  if (!row) return null
  return { host: row.host, port: row.port, username: row.username, password: decryptSecret(row.ciphertext, context(workspaceId, id), master) }
}
