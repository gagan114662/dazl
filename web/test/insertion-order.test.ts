// lib/db/insertion-order.ts on an existing SQLite store: the column is added once, backfilled from rowid, and every
// later insert continues the order, however many times the migration runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateWarm } from '../lib/warm/connections.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { migrateInsertionOrder, INSERTION_ORDER_TABLES } from '../lib/db/insertion-order.ts'

// A store as it is today, before the migration: the four tables with rows, ids deliberately out of insertion order,
// and a deleted row so rowids have a gap.
function existingStore() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateWarm(db)
  // The owning migrations add insert_seq themselves now: take it out again, as a store from before it existed.
  for (const t of INSERTION_ORDER_TABLES) {
    db.exec(`DROP TRIGGER IF EXISTS ${t}_insert_seq; DROP INDEX IF EXISTS ${t}_insert_seq_idx; ALTER TABLE ${t} DROP COLUMN insert_seq`)
  }
  const job = (id: string) => db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, created_at) VALUES (?, 'u', 'b', 'i', 'l', 100)").run(id)
  for (const id of ['j9', 'j1', 'j5', 'jx']) job(id)
  db.prepare("DELETE FROM scan_jobs WHERE id = 'j1'").run()
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = 'j9'").run()
  for (const id of ['l7', 'l2']) db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, created_at) VALUES (?, 'j9', 'P', 'C', 's', 'https://e.example/x', 1, 100)").run(id)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body) VALUES ('m1', 'u', 'l7', 'a@e.example', 'Hi', 'A body that is long enough to pass.')").run()
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES ('e1', 'l7', 'u', 'sitecrawl', 'person', 'Dana', 'https://e.example/t', '2026-10-01', 1)").run()
  db.prepare("INSERT INTO warm_user_paths (id, tenant_id, lead_id, contact_url, mutual_name) VALUES ('w1', 'u', 'l7', 'linkedin.com/in/x', 'Mx')").run()
  for (const id of ['a9', 'a1']) db.prepare("INSERT INTO connector_audit (id, tenant_id, connector, lookup, status) VALUES (?, 'u', 'enrich:apollo', 'x', 'ok')").run(id)
  return db
}

const snapshot = (db: Database.Database) => JSON.stringify(INSERTION_ORDER_TABLES.map(t => [
  db.prepare(`SELECT rowid AS r, insert_seq FROM ${t} ORDER BY rowid`).all(),
  db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND name LIKE '%insert_seq%' ORDER BY name").all(t),
  (db.prepare('SELECT name FROM pragma_table_info(?)').all(t) as { name: string }[]).filter(c => c.name === 'insert_seq').length,
]))

test('on an existing store: insert_seq is added once, backfilled from rowid, and re-running changes nothing', () => {
  const db = existingStore()
  migrateInsertionOrder(db)
  for (const t of INSERTION_ORDER_TABLES) {
    const rows = db.prepare(`SELECT rowid AS r, insert_seq AS s FROM ${t}`).all() as { r: number; s: number }[]
    assert.ok(rows.length > 0)
    assert.ok(rows.every(x => x.s === x.r), `${t}: backfilled from rowid`)
  }
  const once = snapshot(db)
  migrateInsertionOrder(db)
  migrateInsertionOrder(db)
  assert.equal(snapshot(db), once, 'a second and third run change nothing')
  // and the full app migration over the same store is idempotent too
  migrateAllSqlite(db)
  const all = snapshot(db)
  migrateAllSqlite(db)
  assert.equal(snapshot(db), all)
})

test('new rows continue the order; a row that brings its own insert_seq keeps it; ties sort as rowid did', () => {
  const db = existingStore()
  migrateInsertionOrder(db)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, created_at) VALUES ('j0', 'u', 'b', 'i', 'l', 100)").run()
  const order = (sql: string) => (db.prepare(sql).all() as { id: string }[]).map(r => r.id)
  assert.deepEqual(order('SELECT id FROM scan_jobs ORDER BY created_at DESC, insert_seq DESC'), order('SELECT id FROM scan_jobs ORDER BY created_at DESC, rowid DESC'))
  assert.deepEqual(order('SELECT id FROM scan_jobs ORDER BY insert_seq'), ['j9', 'j5', 'jx', 'j0'])
  // a copy back from Postgres brings values ahead of rowid: later inserts must still sort after them
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, created_at, insert_seq) VALUES ('jc', 'u', 'b', 'i', 'l', 100, 1000)").run()
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, created_at) VALUES ('jn', 'u', 'b', 'i', 'l', 100)").run()
  const seq = (id: string) => (db.prepare('SELECT insert_seq AS s FROM scan_jobs WHERE id = ?').get(id) as { s: number }).s
  assert.equal(seq('jc'), 1000)
  assert.equal(seq('jn'), 1001)
  // the stamp is an UPDATE of insert_seq only: the status-transition and sent-is-final triggers (UPDATE OF status) stay quiet
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score) VALUES ('l9', 'j9', 'P', 'C', 's', 'https://e.example/y', 1)").run()
  assert.equal((db.prepare("SELECT insert_seq AS s FROM leads WHERE id = 'l9'").get() as { s: number }).s, 3)
})

test('a fresh store gets the column, index and trigger from migrateAllSqlite', () => {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  for (const t of INSERTION_ORDER_TABLES) {
    assert.ok((db.prepare('SELECT name FROM pragma_table_info(?)').all(t) as { name: string }[]).some(c => c.name === 'insert_seq'), t)
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(`${t}_insert_seq`), t)
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(`${t}_insert_seq_idx`), t)
  }
})
