import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pgDb } from '../lib/db/client.ts'
import { runPgMigrations, loadMigrations, MIGRATIONS_DIR } from '../lib/db/migrate-pg.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

// Every table the app creates in SQLite (extract-schema.ts) must exist after the PG migrations.
const sqliteRef = readFileSync(new URL('../scripts/pg-migrate/schema-sqlite-reference.generated.sql', import.meta.url), 'utf8')
const SQLITE_TABLES = [...sqliteRef.matchAll(/^CREATE TABLE (\w+)/gm)].map(m => m[1]).sort()

test('migration files load in order with no gaps', () => {
  const ms = loadMigrations()
  assert.ok(ms.length >= 1)
  assert.equal(ms[0].name, 'baseline')
  const dir = mkdtempSync(path.join(tmpdir(), 'mig-'))
  writeFileSync(path.join(dir, '0002_x.sql'), 'SELECT 1')
  assert.throws(() => loadMigrations(dir), /no gaps/)
})

async function withDb<T>(f: (db: ReturnType<typeof pgDb>) => Promise<T>): Promise<T> {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema })
  try { return await f(db) } finally { await db.close(); await s.drop() }
}

test('fresh database: the migrations create every app table; a second run applies nothing', { skip: pgSkip }, () => withDb(async db => {
  const first = await runPgMigrations(db.pool)
  assert.deepEqual(first.applied, loadMigrations().map(m => m.version))
  const tables = (await db.all<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema() AND table_name <> 'dazl_schema_migrations' ORDER BY 1")).map(r => r.t)
  assert.equal(SQLITE_TABLES.length, 90) // includes play_research_sources (0024) + autopilot_work (0025); 76 + trial_reservations, trial_budget_lock (0012), crm_push_claims (0014) + organizations, memberships (0015), inbox_thread_reads (0016), tenant_spend_pools (0017) + scheduler_runs, scheduler_progress (0018)
  assert.deepEqual(tables, SQLITE_TABLES)
  const second = await runPgMigrations(db.pool)
  assert.deepEqual(second.applied, [])
  assert.deepEqual(second.alreadyApplied, first.applied)
}))

test('two instances migrating at once: each migration is applied exactly once', { skip: pgSkip }, () => withDb(async db => {
  const other = pgDb({ connectionString: PG_URL!, searchPath: (await db.get<{ s: string }>('SELECT current_schema() AS s'))!.s })
  try {
    const [a, b] = await Promise.all([runPgMigrations(db.pool), runPgMigrations(other.pool)])
    const all = [...a.applied, ...b.applied].sort((x, y) => x - y)
    assert.deepEqual(all, loadMigrations().map(m => m.version))
    assert.equal((await db.get<{ n: number }>('SELECT count(*)::int AS n FROM dazl_schema_migrations'))!.n, all.length)
  } finally { await other.close() }
}))

test('an applied migration that changed, or a DB ahead of the code, stops the run', { skip: pgSkip }, () => withDb(async db => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mig-'))
  writeFileSync(path.join(dir, '0001_one.sql'), 'CREATE TABLE one (id TEXT PRIMARY KEY)')
  await runPgMigrations(db.pool, loadMigrations(dir))
  writeFileSync(path.join(dir, '0001_one.sql'), 'CREATE TABLE one (id TEXT PRIMARY KEY, x TEXT)')
  await assert.rejects(runPgMigrations(db.pool, loadMigrations(dir)), /changed after it was applied/)
  await db.run('INSERT INTO dazl_schema_migrations (version, name, checksum) VALUES (9, ?, ?)', ['future', 'x'])
  writeFileSync(path.join(dir, '0001_one.sql'), 'CREATE TABLE one (id TEXT PRIMARY KEY)')
  await assert.rejects(runPgMigrations(db.pool, loadMigrations(dir)), /does not know/)
}))

test('a failing migration rolls back and is not recorded', { skip: pgSkip }, () => withDb(async db => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mig-'))
  writeFileSync(path.join(dir, '0001_ok.sql'), 'CREATE TABLE ok1 (id TEXT)')
  writeFileSync(path.join(dir, '0002_bad.sql'), 'CREATE TABLE half (id TEXT); SELECT no_such_function()')
  await assert.rejects(runPgMigrations(db.pool, loadMigrations(dir)), /migration 2 \(bad\) failed/)
  assert.deepEqual((await db.all<{ version: number }>('SELECT version FROM dazl_schema_migrations')).map(r => r.version), [1])
  assert.equal((await db.get<{ r: string | null }>("SELECT to_regclass('half')::text AS r"))!.r, null)
}))

// The guard triggers are translated from SQLite; check they behave the same on PG.
test('baseline guards: append-only, immutable, delete-only-expired, status transitions, identity ids', { skip: pgSkip }, () => withDb(async db => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mig-'))
  copyFileSync(path.join(MIGRATIONS_DIR, '0001_baseline.sql'), path.join(dir, '0001_baseline.sql'))
  await runPgMigrations(db.pool, loadMigrations(dir))
  const now = Math.floor(Date.now() / 1000)
  const hex = 'a'.repeat(64)

  await db.run("INSERT INTO evidence_purge_audit (id, tenant_id, operator, reason, copies_deleted, bytes_deleted, leads_unlinked) VALUES ('p1', 't1', 'op', 'written request', 1, 1, 1)")
  await assert.rejects(db.run("UPDATE evidence_purge_audit SET reason = 'changed reason' WHERE id = 'p1'"), /append-only/)
  await assert.rejects(db.run("DELETE FROM evidence_purge_audit WHERE id = 'p1'"), /append-only/)

  const copy = (id: string, expires: number) => db.run(
    "INSERT INTO lead_evidence_copies (id, tenant_id, job_id, attempt, source_url, canonical_url, title, title_sha256, sha256, text, byte_length, fetched_at, expires_at) VALUES (?, 't1', 'j1', 1, 'https://e.x/a', ?, 't', ?, ?, 'body', 4, ?, ?)",
    [id, `https://e.x/${id}`, hex, hex, now, expires])
  await copy('live', now + 3600)
  await copy('old', now - 3600)
  await assert.rejects(db.run("UPDATE lead_evidence_copies SET text = 'x' WHERE id = 'live'"), /immutable/)
  await assert.rejects(db.run("DELETE FROM lead_evidence_copies WHERE id = 'live'"), /retention period/)
  // An expired copy must really be deleted (a BEFORE DELETE trigger returning NULL would silently skip it).
  assert.deepEqual(await db.run("DELETE FROM lead_evidence_copies WHERE id = 'old'"), { changes: 1 })
  await db.tx(function* (t) {
    yield* t.run("INSERT INTO evidence_purge_gate (tenant_id) VALUES ('t1')")
    assert.deepEqual(yield* t.run("DELETE FROM lead_evidence_copies WHERE id = 'live'"), { changes: 1 })
    yield* t.run("DELETE FROM evidence_purge_gate WHERE tenant_id = 't1'")
  })
  // title limit is bytes, as in SQLite: 400 three-byte characters are 1200 bytes
  await assert.rejects(db.run(
    "INSERT INTO lead_evidence_copies (id, tenant_id, job_id, attempt, source_url, canonical_url, title, title_sha256, sha256, text, byte_length, fetched_at, expires_at) VALUES ('big', 't1', 'j1', 1, 'u', 'u2', ?, ?, ?, 'b', 1, 1, 1)",
    ['€'.repeat(400), hex, hex]), /check constraint/)

  await db.run("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location) VALUES ('j1', 'u1', 'pending', 'Biz', 'software', 'Toronto')")
  await assert.rejects(db.run("UPDATE scan_jobs SET status = 'done' WHERE id = 'j1'"), /illegal scan job status transition/)
  await assert.rejects(db.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score) VALUES ('l1', 'j1', '', 'Acme', 's', 'https://e.x/l', 1)"), /running job/)
  await db.run("UPDATE scan_jobs SET status = 'running' WHERE id = 'j1'")
  await db.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score) VALUES ('l1', 'j1', '', 'Acme', 's', 'https://e.x/l', 1)")

  // INTEGER PRIMARY KEY (sqlite rowid) is an identity column
  await db.run("INSERT INTO outreach_llm_usage (tenant_id, purpose, outcome) VALUES ('t1', 'draft', 'ok')")
  await db.run("INSERT INTO outreach_llm_usage (tenant_id, purpose, outcome) VALUES ('t1', 'draft', 'ok')")
  assert.deepEqual((await db.all<{ id: number }>('SELECT id FROM outreach_llm_usage ORDER BY id')).map(r => r.id), [1, 2])
}))

// Parity with current main: stripe_event_order took 0007 (#253), so the enrichment columns are 0008. loadMigrations also
// throws on a gap or duplicate version, so a second 0007 file would fail here before it could reach a database.
test('enrichment migration is 0008, after main\'s 0007 stripe_event_order', () => {
  const ms = loadMigrations()
  assert.equal(ms.find(m => m.version === 7)?.name, 'stripe_event_order')
  assert.equal(ms.find(m => m.version === 8)?.name, 'scan_job_enrichment')
})
