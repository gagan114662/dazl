// lib/db/copy-store.ts: the cutover copy (SQLite file -> Postgres) and the rollback copy (Postgres -> a new SQLite
// file) on synthetic data, with the checks that keep it safe: a non-empty target, a target missing a table, and a copy
// that does not read back identically are all refused, and a refused copy leaves the target empty.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { sqliteDb, pgDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { copyStore, compareStores, CopyRefused, CopyVerifyError } from '../lib/db/copy-store.ts'
import { DbQueue } from '../lib/queue/db.ts'
import * as S from '../lib/scan/store-db.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const A = 'a'.repeat(32), B = 'b'.repeat(32)
const T0 = 1_800_000_000

function sqliteStore(): Db { const h = new Database(':memory:'); migrateAllSqlite(h); return sqliteDb(h) }

async function pgStore(): Promise<{ db: Db & { pool: import('pg').Pool }; drop: () => Promise<void> }> {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 2 })
  await runPgMigrations(db.pool)
  return { db, drop: async () => { await db.close(); await s.drop() } }
}

// Two tenants, a finished scan with its leads (the PG guard trigger refuses leads for a job that is not running, so
// this is what the copy must get past), a watch and what it has seen (foreign keys), queue work, awkward text.
async function seed(db: Db): Promise<void> {
  for (const [id, email] of [[A, 'a@example.test'], [B, 'b@example.test']]) {
    await db.run('INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)', [id, email, 'h', 's', T0])
  }
  await db.run("INSERT INTO tenant_plans (tenant_id, plan, subscription_status) VALUES (?, 'pro', 'past_due')", [A])
  const job = await S.createJob(db, A, { business_name: 'Café "Ünïcode" \'quoted\'\nsecond line', industry: 'software', location: 'Toronto' }, null, T0)
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id = ?", [T0, job])
  for (const i of [1, 2, 3]) {
    await db.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, created_at, timing_note) VALUES (?, ?, 'Pat', ?, 'Hiring', ?, ?, ?, ?)",
      [`l${i}`, job, `Co ${i}`, `https://e.example/${i}`, 50 + i, T0 + i, i === 2 ? null : `note ${i} — ✓`])
  }
  await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ?, claimed_at = NULL WHERE id = ?", [T0 + 9, job])
  await S.createJob(db, B, { business_name: 'B biz', industry: 'retail', location: 'Austin' }, null, T0 + 1)
  await db.run("INSERT INTO watches (id, user_id, query, icp, next_run_at, created_at) VALUES ('w1', ?, 'q', '{}', ?, ?)", [A, T0 + 604800, T0])
  await db.run("INSERT INTO watch_seen (watch_id, seen_key, first_seen_at) VALUES ('w1', 'example.com', ?)", [T0])
  const q = new DbQueue(db)
  await q.enqueue({ tenantId: A, kind: 'scan', id: 'q1', now: T0, dedupeKey: 'k' })
  await q.enqueue({ tenantId: B, kind: 'scan', id: 'q2', now: T0 })
  await db.run("UPDATE work_queue_meta SET v = 41 WHERE k = 'token'") // tokens 1..41 were handed out before the copy
}

async function counts(db: Db, tables: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of tables) out[t] = Number((await db.get<{ c: number }>(`SELECT count(*) AS c FROM ${t}`))!.c)
  return out
}
const SEEDED = { users: 2, tenant_plans: 1, scan_jobs: 2, leads: 3, watches: 1, watch_seen: 1, work_queue: 2, work_queue_meta: 1 }

test('cutover copy: SQLite -> Postgres copies every row, verifies it, and leaves the guard triggers on', { skip: pgSkip }, async () => {
  const src = sqliteStore(), pg = await pgStore()
  try {
    await seed(src)
    const r = await copyStore(src, pg.db, { batch: 2 })
    assert.equal(r.from, 'sqlite'); assert.equal(r.to, 'pg')
    assert.deepEqual(await counts(pg.db, Object.keys(SEEDED)), SEEDED)
    assert.deepEqual(r.tables.filter(t => t.rows > 0).map(t => [t.table, t.rows]).sort(), Object.entries(SEEDED).sort())
    // parents before children
    const order = r.tables.map(t => t.table)
    assert.ok(order.indexOf('watches') < order.indexOf('watch_seen'))
    assert.ok(order.indexOf('scan_jobs') < order.indexOf('leads'))
    assert.deepEqual(await compareStores(src, pg.db), [])
    const job = (await pg.db.get<{ business_name: string }>("SELECT business_name FROM scan_jobs WHERE user_id = ?", [A]))!
    assert.equal(job.business_name, 'Café "Ünïcode" \'quoted\'\nsecond line')
    // the triggers are back on for live writes: a lead for a finished job is still refused
    const done = (await pg.db.get<{ id: string }>("SELECT id FROM scan_jobs WHERE status = 'done'"))!.id
    await assert.rejects(pg.db.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score) VALUES ('x', ?, 'P', 'C', 's', 'https://e.example/x', 1)", [done]), /running job/)
    // the copied queue still works on Postgres
    // the copied queue still works on Postgres, and its fencing-token counter carried over instead of restarting
    const c = await new DbQueue(pg.db).claim({ now: T0 + 10 })
    assert.equal(c?.item.id, 'q1')
    assert.equal(c?.token, 42)
  } finally { await src.close(); await pg.drop() }
})

test('rollback copy: Postgres -> a new SQLite file round-trips identically, triggers recreated', { skip: pgSkip }, async () => {
  const src = sqliteStore(), pg = await pgStore(), back = sqliteStore()
  try {
    await seed(src)
    await copyStore(src, pg.db)
    await pg.db.run("UPDATE tenant_plans SET plan = 'free', subscription_status = 'canceled' WHERE tenant_id = ?", [A]) // a write taken on Postgres after cutover
    const r = await copyStore(pg.db, back)
    assert.equal(r.to, 'sqlite')
    assert.deepEqual(await compareStores(pg.db, back), [])
    assert.deepEqual(await back.get('SELECT plan, subscription_status FROM tenant_plans WHERE tenant_id = ?', [A]), { plan: 'free', subscription_status: 'canceled' })
    const done = (await back.get<{ id: string }>("SELECT id FROM scan_jobs WHERE status = 'done'"))!.id
    await assert.rejects(back.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score) VALUES ('x', ?, 'P', 'C', 's', 'https://e.example/x', 1)", [done]), /running/)
  } finally { await src.close(); await back.close(); await pg.drop() }
})

test('refused: a target that already holds rows is not touched', async () => {
  const src = sqliteStore(), dst = sqliteStore()
  try {
    await seed(src)
    await dst.run('INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, ?, ?)', [B, 'other@example.test', 'h', 's'])
    await assert.rejects(copyStore(src, dst), (e: Error) => e instanceof CopyRefused && /not empty \(users has 1 rows\)/.test(e.message))
    assert.deepEqual(await counts(dst, Object.keys(SEEDED)), { ...Object.fromEntries(Object.keys(SEEDED).map(k => [k, 0])), users: 1, work_queue_meta: 1 })
  } finally { await src.close(); await dst.close() }
})

test('refused: a source table or column the target does not have, before anything is written', async () => {
  const src = sqliteStore(), dst = sqliteStore()
  try {
    await seed(src)
    await src.run('CREATE TABLE extra_notes (id TEXT PRIMARY KEY)')
    await src.run("INSERT INTO extra_notes VALUES ('n1')")
    await assert.rejects(copyStore(src, dst), (e: Error) => e instanceof CopyRefused && /extra_notes has 1 rows but no table in the target/.test(e.message))
    await src.run('DELETE FROM extra_notes') // an empty table the target lacks is skipped, not refused
    await src.run('ALTER TABLE users ADD COLUMN nickname TEXT')
    await assert.rejects(copyStore(src, dst), (e: Error) => e instanceof CopyRefused && /users: the target has no column nickname/.test(e.message))
    assert.deepEqual(await counts(dst, ['users', 'leads', 'scan_jobs']), { users: 0, leads: 0, scan_jobs: 0 })
  } finally { await src.close(); await dst.close() }
})

test('a copy that does not read back identically rolls back entirely', { skip: pgSkip }, async () => {
  const src = sqliteStore(), pg = await pgStore()
  try {
    await seed(src)
    // a target column that changes values on the way in (7 reads back as 7.0): the checksum catches it
    await pg.db.run('ALTER TABLE scan_jobs ALTER COLUMN attempts TYPE numeric(5,1)')
    await assert.rejects(copyStore(src, pg.db), (e: Error) => e instanceof CopyVerifyError && /scan_jobs: content differs/.test(e.message))
    assert.deepEqual(await counts(pg.db, ['users', 'leads', 'scan_jobs', 'work_queue_meta']), { users: 0, leads: 0, scan_jobs: 0, work_queue_meta: 0 })
    // and the triggers it switched off are on again (the transaction rolled back)
    const off = await pg.db.all("SELECT tgname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal AND g.tgenabled = 'D' AND c.relnamespace = current_schema()::regnamespace")
    assert.deepEqual(off, [])
  } finally { await src.close(); await pg.drop() }
})

test('compareStores names each table whose rows differ', async () => {
  const a = sqliteStore(), b = sqliteStore()
  try {
    await seed(a)
    await copyStore(a, b)
    assert.deepEqual(await compareStores(a, b), [])
    await b.run("UPDATE leads SET score = 1 WHERE id = 'l1'")
    await b.run("DELETE FROM watch_seen")
    assert.deepEqual(await compareStores(a, b), ['leads: same row count, different content', 'watch_seen: 1 rows vs 0'])
  } finally { await a.close(); await b.close() }
})
