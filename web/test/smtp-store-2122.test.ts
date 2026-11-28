import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { exportTenant } from '../lib/tenant/lifecycle.ts'
import { bothEngines } from './helpers/engines.ts'

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

test('the application SQLite loader creates and preserves the SMTP mailbox table', async () => {
  const { migrateAllSqlite } = await import('../lib/db/sqlite-migrations.ts')
  const raw = new Database(':memory:')
  try {
    migrateAllSqlite(raw)
    raw.prepare("INSERT INTO users (id, email, password_hash, salt, created_at) VALUES ('a', 'a@example.net', 'hash', 'salt', 1)").run()
    raw.prepare("INSERT INTO mailbox_connections (id, tenant_id, provider, created_at, updated_at) VALUES ('connection', 'a', 'smtp', 'now', 'now')").run()
    migrateAllSqlite(raw)
    assert.deepEqual(raw.prepare('SELECT id FROM mailbox_connections').all(), [{ id: 'connection' }])
  } finally {
    raw.close()
  }
})

test('SMTP storage upgrades the previously named owner column and retains existing connections', async () => {
  const { migrateSmtpMailboxes, smtpMailboxStatus } = await import('../lib/email/smtp-store.ts')
  const raw = new Database(':memory:')
  try {
    raw.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('a'), ('b')")
    raw.exec(`CREATE TABLE mailbox_connections (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, smtp_host TEXT, smtp_port INTEGER, smtp_username TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (workspace_id, provider)
    )`)
    raw.prepare("INSERT INTO mailbox_connections (id, workspace_id, provider, smtp_host, smtp_port, smtp_username, created_at, updated_at) VALUES ('old', 'a', 'smtp', 'mail.example.net', 587, 'a@example.net', 'now', 'now')").run()

    migrateSmtpMailboxes(raw)
    migrateSmtpMailboxes(raw)

    assert.equal(raw.prepare('SELECT tenant_id FROM mailbox_connections WHERE id = ?').pluck().get('old'), 'a')
    assert.equal((await smtpMailboxStatus(sqliteDb(raw), 'a'))?.id, 'old')
    assert.equal(await smtpMailboxStatus(sqliteDb(raw), 'b'), null)
    raw.prepare('DELETE FROM users WHERE id = ?').run('a')
    assert.equal(await smtpMailboxStatus(sqliteDb(raw), 'a'), null)
  } finally {
    raw.close()
  }
})


bothEngines('mailbox migration supports workspace isolation and owner deletion', async ({ db }) => {
  const { disconnectSmtpMailbox, loadSmtpMailbox, saveSmtpMailbox, smtpMailboxStatus } = await import('../lib/email/smtp-store.ts')
  for (const id of ['a', 'b']) {
    await db.run('INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)', [id, id + '@example.net', 'hash', 'salt', 1])
  }
  const master = Buffer.alloc(32, 7)
  const mailbox = { host: 'mail.example.net', port: 587, username: 'a@example.net', password: 'test app password' }
  const id = await saveSmtpMailbox(db, 'a', mailbox, master)
  assert.deepEqual(await loadSmtpMailbox(db, 'a', id, master), mailbox)
  assert.equal(await loadSmtpMailbox(db, 'b', id, master), null)
  assert.equal(await disconnectSmtpMailbox(db, 'b', id), false)
  assert.equal((await smtpMailboxStatus(db, 'a'))?.id, id)
  const snapshot = await exportTenant(db, 'a')
  assert.equal(snapshot.tables.mailbox_connections?.[0]?.smtp_password_encrypted, '[redacted: stored credential]')
  await db.run('DELETE FROM users WHERE id = ?', ['a'])
  assert.equal(await smtpMailboxStatus(db, 'a'), null)
})
