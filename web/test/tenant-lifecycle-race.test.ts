// Review (PR #455, R1-1): a write for tenant A that passed the recreation guard before A's tombstone was written and
// is still open when the deletion runs. On Postgres (READ COMMITTED) nothing waits for an open writer, so without the
// per-step table locks in deleteTenant the write committed after the deletion reported 'completed' and the row
// survived. Now each step waits for such writers and erases their rows. SQLite has one writer at a time: the step
// fails with SQLITE_BUSY while the writer is open and succeeds once it has committed; a row is never lost.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pgDb, sqliteDb } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { deleteTenant, tombstone } from '../lib/tenant/lifecycle.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const A = 'race-tenant-aaaa', BY = 'operator (synthetic race test)'
const POLICY = { suppressions: 'erase' as const }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('postgres: a write open since before the tombstone is waited for by the deletion, then erased; the deletion does not complete around it', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema })
  const writer = new pg.Client({ connectionString: PG_URL })
  try {
    await runPgMigrations(db.pool)
    await db.run("INSERT INTO users (id, email, password_hash, salt) VALUES (?, 'race@example.test', 'x', 'y')", [A])
    await writer.connect(); await writer.query(`SET search_path TO ${s.schema}`)
    await writer.query('BEGIN')
    await writer.query("INSERT INTO tenant_memory (tenant_id, tone) VALUES ($1, 'late')", [A]) // the guard passes: no tombstone yet
    const deletion = deleteTenant(db, A, { policy: POLICY, requestedBy: BY })
    deletion.catch(() => {}) // awaited below
    // the deletion must now be waiting for the open writer: an ungranted table lock of ours, and no step completed
    let waiting = false
    for (let i = 0; i < 100 && !waiting; i++) {
      await sleep(50)
      waiting = Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE NOT l.granted AND l.mode = 'ShareRowExclusiveLock' AND c.relnamespace = current_schema()::regnamespace"))!.n) > 0
    }
    const during = (await tombstone(db, A))?.state
    await writer.query('COMMIT')
    const t = await deletion
    assert.equal(t.state, 'completed')
    assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM tenant_memory WHERE tenant_id = ?', [A]))!.n), 0, 'a completed deletion leaves no row for the tenant, including the one written in flight')
    assert.ok(waiting, 'the deletion waited for the open writer instead of running around it')
    assert.equal(during, 'requested', 'while it waited, the tombstone was written (new writes refused) and no step had run')
    await assert.rejects(db.run("INSERT INTO tenant_memory (tenant_id, tone) VALUES (?, 'later')", [A]), /tenant deleted/)
  } finally { await writer.end().catch(() => {}); await db.close(); await s.drop() }
})

test('sqlite: one writer at a time: the deletion fails while another connection holds a write open and completes once it committed; no row is lost', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tenant-race-')), file = path.join(dir, 'live.db')
  const raw = new Database(file, { timeout: 200 }); migrateAllSqlite(raw)
  const writer = new Database(file, { timeout: 200 })
  try {
    const db = sqliteDb(raw)
    await db.run("INSERT INTO users (id, email, password_hash, salt) VALUES (?, 'race@example.test', 'x', 'y')", [A])
    writer.exec('BEGIN IMMEDIATE')
    writer.prepare("INSERT INTO tenant_memory (tenant_id, tone) VALUES (?, 'late')").run(A) // the guard passes: no tombstone yet
    await assert.rejects(deleteTenant(db, A, { policy: POLICY, requestedBy: BY }), /SQLITE_BUSY|database is locked/, 'the step cannot start while the writer is open')
    assert.equal(await tombstone(db, A), undefined, 'nothing was written')
    writer.exec('COMMIT')
    assert.equal((await deleteTenant(db, A, { policy: POLICY, requestedBy: BY })).state, 'completed')
    assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM tenant_memory WHERE tenant_id = ?', [A]))!.n), 0)
  } finally { writer.close(); raw.close(); rmSync(dir, { recursive: true, force: true }) }
})
