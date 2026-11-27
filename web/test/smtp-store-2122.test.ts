import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'

test('SMTP storage isolates workspaces, encrypts credentials and invalidates replaced connection IDs', async () => {
  const { migrateSmtpMailboxes, saveSmtpMailbox, smtpMailboxStatus, loadSmtpMailbox } = await import('../lib/email/smtp-store.ts')
  const raw = new Database(':memory:')
  try {
    raw.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('a'), ('b')")
    migrateSmtpMailboxes(raw)
    migrateSmtpMailboxes(raw)
    const db = sqliteDb(raw)
    const master = Buffer.alloc(32, 7)
    const mailbox = { host: 'mail.example.net', port: 587, username: 'owner@example.net', password: 'test app password' }
    const first = await saveSmtpMailbox(db, 'a', mailbox, master)
    assert.deepEqual(await smtpMailboxStatus(db, 'a'), { id: first, host: mailbox.host, port: mailbox.port, username: mailbox.username })
    assert.equal(await smtpMailboxStatus(db, 'b'), null)
    assert.equal(await loadSmtpMailbox(db, 'b', first, master), null)
    assert.deepEqual(await loadSmtpMailbox(db, 'a', first, master), mailbox)
    const second = await saveSmtpMailbox(db, 'a', { ...mailbox, password: 'replacement' }, master)
    assert.notEqual(first, second)
    assert.equal(await loadSmtpMailbox(db, 'a', first, master), null)
    assert.equal((await loadSmtpMailbox(db, 'a', second, master))?.password, 'replacement')

    const b = await saveSmtpMailbox(db, 'b', mailbox, master)
    const row = raw.prepare('SELECT smtp_password_encrypted AS ciphertext FROM mailbox_connections WHERE id = ?').get(second) as { ciphertext: string }
    assert.ok(!row.ciphertext.includes('replacement'))
    raw.prepare('UPDATE mailbox_connections SET smtp_password_encrypted = ? WHERE id = ?').run(row.ciphertext, b)
    await assert.rejects(loadSmtpMailbox(db, 'b', b, master))
  } finally {
    raw.close()
  }
})
