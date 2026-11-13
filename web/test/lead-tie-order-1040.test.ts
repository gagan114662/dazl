// #1040: the leads (scan_job_id, created_at) index must not change which order same-second leads come back in. The legacy
// store (lib/scan/store.ts) and the Db store (lib/scan/store-db.ts) both break those ties by insert_seq, never the plan.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import * as Legacy from '../lib/scan/store.ts'
import * as Store from '../lib/scan/store-db.ts'

test('#1040: same-second leads with equal ranks list and export in insertion order on both stores, with the new index', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  assert.ok((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'leads_job_created'").get()), 'the index is there')
  const J = 'a'.repeat(24)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at) VALUES (?, 'A', 'x', 'x', 'x', 'running', 1)").run(J)
  const ids = ['z9', 'b2', 'm5', 'a1']   // not in id order, so only insert_seq can give insertion order
  for (const id of ids) db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, score, created_at) VALUES (?, ?, ?, 'hiring', 'https://news.example/a', 50, 1000)").run(id, J, `Co ${id}`)
  assert.deepEqual(Legacy.listLeads(db, 'A', J).map(l => (l as { id: string }).id), ids, 'legacy list')
  assert.deepEqual((await Store.listLeads(sqliteDb(db), 'A', J)).map(l => (l as { id: string }).id), ids, 'Db list')
  assert.deepEqual(Legacy.exportLeads(db, 'A', J).map(r => (r as { lead_id: string }).lead_id), ids, 'legacy export')
  assert.deepEqual((await Store.exportLeads(sqliteDb(db), 'A', J)).map(r => (r as { lead_id: string }).lead_id), ids, 'Db export')
})
