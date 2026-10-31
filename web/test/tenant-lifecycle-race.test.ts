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
import { randomBytes } from 'node:crypto'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

// Advisory locks are keyed per database, not per schema: unique ids per run, so a concurrent run of this file against
// the same test server (another checkout, a reviewer) does not share lock keys with this one.
const RUN = randomBytes(3).toString('hex')
const A = `race-${RUN}-aaaa`, B = `race-${RUN}-bbbb`, C = `race-${RUN}-cccc`, BY = 'operator (synthetic race test)'
// an ungranted exclusive advisory lock on this tenant's key: a deletion step waiting for the tenant's open writers
const WAITING_ON = "SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND mode = 'ExclusiveLock' AND objid = (hashtext(?)::bigint & 4294967295)"
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
      waiting = Number((await db.get<{ n: number }>(WAITING_ON, [A]))!.n) > 0
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
    // with table locks this call never returned while B was open (the test timeout was the failure); now it completes
    const t = await deleteTenant(db, A, { policy: POLICY, requestedBy: BY })
    assert.equal(t.state, 'completed', "A's deletion completed while B's transaction was still open")
    assert.equal(Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = (hashtext(?)::bigint & 4294967295)", [B]))!.n), 0, 'nothing of ours waited on B')
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

// Review (PR #455, R2-4): a membership for the account, inserted in a transaction open across the tombstone write.
// Its guard holds A's advisory key (member_id = A), so the first step waits for it, then finds it and refuses before
// anything is revoked; once the operator removes it the deletion resumes.
test('postgres: a membership insert racing the tombstone is waited for, then refused by the first step with nothing revoked', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema })
  const joiner = new pg.Client({ connectionString: PG_URL })
  try {
    await runPgMigrations(db.pool)
    await db.run("INSERT INTO users (id, email, password_hash, salt) VALUES (?, 'race@example.test', 'x', 'y')", [A])
    await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'a', 'personal', ?, 1)", [A, A])
    await db.run("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, 'owner', 1)", [A, A])
    await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'team c', 'team', 'someone', 1)", [C])
    await db.run("INSERT INTO sessions (id, user_id, expires_at) VALUES ('sess-a', ?, 4102444800)", [A])
    await joiner.connect(); await joiner.query(`SET search_path TO ${s.schema}`)
    await joiner.query('BEGIN')
    await joiner.query("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES ($1, $2, 'viewer', 2)", [C, A]) // no tombstone yet: the guard passes, A's key is held shared
    const deletion = deleteTenant(db, A, { policy: POLICY, requestedBy: BY })
    deletion.catch(() => {})
    let waiting = false
    for (let i = 0; i < 300 && !waiting; i++) {
      await sleep(50)
      waiting = Number((await db.get<{ n: number }>(WAITING_ON, [A]))!.n) > 0
    }
    assert.ok(waiting, 'the first step waits for the open membership insert')
    assert.equal((await tombstone(db, A))?.state, 'requested')
    await joiner.query('COMMIT')
    await assert.rejects(deletion, /founder belongs to another workspace/)
    assert.equal((await tombstone(db, A))?.state, 'requested', 'refused before revoking')
    assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM sessions WHERE user_id = ?', [A]))!.n), 1, 'credentials intact')
    await db.run('DELETE FROM memberships WHERE tenant_id = ? AND member_id = ?', [C, A])
    assert.equal((await deleteTenant(db, A)).state, 'completed')
    assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM memberships WHERE member_id = ?', [A]))!.n), 0)
  } finally { await joiner.end().catch(() => {}); await db.close(); await s.drop() }
})

// Probe (PR #455, F1): the parent-chain predicate must be a primary-key lookup joined to tenant_tombstones, not a scan
// of the parent table per written row.
test('postgres: the parent-key guard resolves the parent by primary key (indexed), not by scanning the parent table', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema })
  try {
    await runPgMigrations(db.pool)
    for (const name of ['tomb_leads', 'tomb_upd_lead_sources']) {
      const def = (await db.get<{ d: string }>('SELECT pg_get_functiondef(?::regproc) AS d', [`dazl_guard_${name}`]))!.d
      assert.match(def, /JOIN tenant_tombstones t\d+ ON t\d+\.deleted_tenant = p\d+\.user_id WHERE p\d+\.id = /, `${name}: primary-key lookup joined to the tombstones`)
      assert.doesNotMatch(def, /IN \(SELECT id FROM scan_jobs WHERE/, `${name}: no per-row scan of scan_jobs`)
    }
    // with a populated parent table, the planner uses the primary key for the guard's lookup
    await db.run("INSERT INTO users (id, email, password_hash, salt) VALUES (?, 'race@example.test', 'x', 'y')", [B])
    await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) SELECT 'plan-' || g, ?, 'x', 'y', 'z' FROM generate_series(1, 3000) g", [B])
    await db.run('ANALYZE scan_jobs'); await db.run('ANALYZE tenant_tombstones')
    const plan = (await db.all<Record<string, string>>("EXPLAIN SELECT 1 WHERE EXISTS (SELECT 1 FROM scan_jobs p0 JOIN tenant_tombstones t0 ON t0.deleted_tenant = p0.user_id WHERE p0.id = 'plan-77')")).map(r => Object.values(r)[0]).join('\n')
    assert.match(plan, /Index (Only )?Scan using scan_jobs_pkey/, plan)
  } finally { await db.close(); await s.drop() }
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
