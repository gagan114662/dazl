// Forward gate for the widenWhyCap rebuild (#2154): a previous-release database that still carries the
// old 300-char why CHECK - and the tenant guard's cross-table triggers, whose bodies name `leads` - must
// migrate forward without the rebuild aborting and without losing a single schema object. The old
// rebuild dropped and renamed `leads` while tomb_lead_sources (on lead_sources) still named it; SQLite
// reparses every trigger at RENAME and refuses to parse one that names a table that does not exist
// between the DROP and the RENAME, so the whole startup migration aborted - and the rebuild's hardcoded
// restore list silently dropped the leads triggers and indexes it did not know about.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string }

function schemaObjects(db: Database.Database): SchemaObject[] {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all() as SchemaObject[]
}

// A database as the previous release left it: every schema object exactly as the current release's
// migrations write it (the definitions are real - they come from a freshly migrated database, tenant
// guard triggers included), except the leads table still carries the old why cap of 300, the shape
// widenWhyCap detects. No migration runs while the fixture is built, so nothing widens early.
function previousReleaseDb(): Database.Database {
  const proto = new Database(':memory:')
  migrateAllSqlite(proto)
  const objects = schemaObjects(proto)
  const leads = objects.find(o => o.type === 'table' && o.name === 'leads')!
  assert.ok(leads.sql.includes('length(why) <= 600)'), 'prototype database carries the current 600 cap')
  const oldLeadsSql = leads.sql.replace('length(why) <= 600)', 'length(why) <= 300)')
  const creationOrder = proto.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid").all() as { name: string; sql: string }[]
  proto.close()
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const o of creationOrder) db.exec(o.name === 'leads' ? oldLeadsSql : o.sql)
  return db
}

test('widenWhyCap forward gate: an old-cap database with tenant-guard triggers migrates whole', () => {
  const db = previousReleaseDb()
  // The fixture really is the previous release's shape: old cap on, and the full guard/index set a real
  // database carries - the leads-side objects the old rebuild's restore list partly forgot, and the
  // tenant guard's triggers on lead_sources whose bodies name `leads`.
  const before = schemaObjects(db)
  const byName = new Map(before.map(o => [o.name, o]))
  const leadsSql = byName.get('leads')!.sql
  assert.ok(leadsSql.includes('length(why) <= 300)'), 'fixture leads carries the old 300 cap')
  for (const name of ['leads_job', 'leads_dedup', 'leads_job_created', 'leads_insert_seq_idx', 'leads_only_while_running', 'leads_insert_seq', 'tomb_leads', 'tomb_upd_leads', 'tomb_lead_sources', 'tomb_upd_lead_sources'])
    assert.ok(byName.has(name), `fixture carries ${name}`)
  assert.match(byName.get('tomb_lead_sources')!.sql, /\bleads\b/, 'the cross-table trigger names leads')

  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('j1', 'u1', 'Biz', 'software', 'Toronto', 'running')").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, why) VALUES ('l1', 'j1', 'Pat', 'Acme', 'pat@acme.example', 'Hiring', 'https://acme.example/jobs', 80, ?)").run('x'.repeat(290))
  assert.throws(() => db.prepare("UPDATE leads SET why = ? WHERE id = 'l1'").run('y'.repeat(400)), 'the old cap still refuses 400 chars before the migrate')

  migrateAllSqlite(db) // the forward migrate: widens the cap, loses nothing

  const widenedSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'leads'").get() as { sql: string }).sql
  assert.ok(widenedSql.includes('length(why) <= 600)'), 'the why cap widened to 600')
  assert.ok(!widenedSql.includes('length(why) <= 300)'), 'the old cap is gone')
  db.prepare("UPDATE leads SET why = ? WHERE id = 'l1'").run('y'.repeat(500)) // 500 now fits
  assert.throws(() => db.prepare("UPDATE leads SET why = ? WHERE id = 'l1'").run('z'.repeat(601)), '601 is still refused')
  assert.equal((db.prepare("SELECT length(why) AS n FROM leads WHERE id = 'l1'").get() as { n: number }).n, 500, 'the seeded row survived the rebuild')

  // Every pre-existing schema object is still there, byte-identical - the leads table itself is the
  // only object allowed to differ, and only by the widened CHECK.
  const after = schemaObjects(db)
  const afterByName = new Map(after.map(o => [o.name, o]))
  for (const o of before) {
    const now = afterByName.get(o.name)
    assert.ok(now, `${o.name} still exists after the migrate`)
    if (o.name !== 'leads') assert.equal(now!.sql, o.sql, `${o.name} is byte-identical after the migrate`)
  }

  migrateAllSqlite(db) // a second migrate is a no-op
  assert.deepEqual(schemaObjects(db), after, 'the second migrate changes no schema object')
})
