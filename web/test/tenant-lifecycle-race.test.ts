// Review (PR #455, R1-1, then R5): a write for tenant A that passed the recreation guard before A's tombstone was
// written and is still open when the deletion runs. On Postgres (READ COMMITTED) nothing waits for an open writer, so
// the write committed after the deletion reported 'completed' and the row survived. Now every guard holds a shared
// advisory lock on the row's tenant id, each deletion step takes it exclusively, so the step waits for A's in-flight
// writers only: another tenant's open transaction neither delays A's deletion nor is delayed by it (R5: the table
// locks of the first fix stalled every tenant), and the wait is bounded by a lock timeout that leaves the state
// unchanged. SQLite has one writer at a time: the step fails with SQLITE_BUSY while the writer is open and succeeds
// once it has committed; a row is never lost.
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

const A = 'race-tenant-aaaa', B = 'race-tenant-bbbb', C = 'race-tenant-cccc', BY = 'operator (synthetic race test)'
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
    // the deletion must now be waiting for the open writer: an ungranted advisory lock on A's key, and no step completed
    let waiting = false
    for (let i = 0; i < 300 && !waiting; i++) { // up to 15 s: the suite runs many files at once on a loaded machine
      await sleep(50)
      waiting = Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND mode = 'ExclusiveLock' AND objid = hashtext(?)::oid", [A]))!.n) > 0
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

// Review (PR #455, R5): the first fix locked every table, so one open write by any tenant stalled A's deletion and the
// deletion's queued locks stalled every other tenant's writes. With per-tenant advisory locks, B's open transaction
// is irrelevant to A's deletion and C keeps writing while it runs.
test('postgres: another tenant\'s open write neither delays the deletion nor is blocked by it; a third tenant keeps writing', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema })
  const bWriter = new pg.Client({ connectionString: PG_URL }), cWriter = new pg.Client({ connectionString: PG_URL })
  try {
    await runPgMigrations(db.pool)
    for (const id of [A, B, C]) await db.run("INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, 'x', 'y')", [id, `${id}@example.test`])
    await db.run("INSERT INTO tenant_memory (tenant_id, tone) VALUES (?, 'mine')", [A])
    for (const w of [bWriter, cWriter]) { await w.connect(); await w.query(`SET search_path TO ${s.schema}`) }
    await bWriter.query('BEGIN'); await bWriter.query("INSERT INTO tenant_memory (tenant_id, tone) VALUES ($1, 'busy')", [B]) // B: open, unrelated
    const started = Date.now()
    const t = await deleteTenant(db, A, { policy: POLICY, requestedBy: BY })
    assert.equal(t.state, 'completed', "A's deletion completed while B's transaction was still open")
    assert.ok(Date.now() - started < 4000, `did not wait on B (${Date.now() - started} ms)`)
    assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM tenant_memory WHERE tenant_id = ?', [A]))!.n), 0)
    // and while a deletion of A is in progress (its advisory lock held by an open step), C's writes go through at once
    const hold = new pg.Client({ connectionString: PG_URL }); await hold.connect(); await hold.query(`SET search_path TO ${s.schema}`)
    await hold.query('BEGIN'); await hold.query('SELECT pg_advisory_xact_lock(hashtext($1))', [A]) // what a step holds
    try {
      await cWriter.query("SET statement_timeout = '2s'")
      await cWriter.query("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES ('c-job', $1, 'x', 'y', 'z')", [C])
      assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM scan_jobs WHERE user_id = ?', [C]))!.n), 1, 'C wrote while A is locked')
    } finally { await hold.query('ROLLBACK').catch(() => {}); await hold.end().catch(() => {}) }
    await bWriter.query('COMMIT')
    assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM tenant_memory WHERE tenant_id = ?', [B]))!.n), 1, "B's write landed")
  } finally { for (const w of [bWriter, cWriter]) await w.end().catch(() => {}); await db.close(); await s.drop() }
})

test('postgres: a step that waits longer than the lock timeout gives up with the state unchanged; the deletion resumes once the writer is gone', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema })
  const writer = new pg.Client({ connectionString: PG_URL })
  try {
    await runPgMigrations(db.pool)
    await db.run("INSERT INTO users (id, email, password_hash, salt) VALUES (?, 'race@example.test', 'x', 'y')", [A])
    await db.run("INSERT INTO sessions (id, user_id, expires_at) VALUES ('sess-a', ?, 4102444800)", [A])
    await writer.connect(); await writer.query(`SET search_path TO ${s.schema}`)
    await writer.query('BEGIN'); await writer.query("INSERT INTO tenant_memory (tenant_id, tone) VALUES ($1, 'late')", [A])
    await assert.rejects(deleteTenant(db, A, { policy: POLICY, requestedBy: BY, lockTimeoutMs: 300 }), /step requested -> revoked waited 300 ms for in-flight writes of this tenant and gave up; nothing changed, retry/)
    assert.equal((await tombstone(db, A))?.state, 'requested', 'the tombstone stands, the step rolled back')
    assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM sessions WHERE user_id = ?', [A]))!.n), 1, 'nothing revoked')
    await writer.query('COMMIT')
    assert.equal((await deleteTenant(db, A)).state, 'completed', 'resumed with the default timeout')
    assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM tenant_memory WHERE tenant_id = ?', [A]))!.n), 0, 'the late row went with the rest')
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
