// #712 on the DEFAULT deployed path: with DAZL_SCAN_SHARED_QUEUE unset (the deployed config), scans are still
// fair across tenants. Hermes-PC's 2026-11-12 PARTIAL said the default claimer (claimKeyedJob) was strict FIFO;
// #1081 since made it per-tenant fair. These tests name #712 so its gate counts them, and pin the default path.
// In-memory SQLite, synthetic tenants and keys; nothing runs, only claims. $0.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { createQueryJob } from '../lib/scan/store.ts'
import { claimKeyedJob } from '../lib/scan/runner.ts'

delete process.env.DAZL_SCAN_SHARED_QUEUE
const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64')
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function setup(...tenants: string[]) {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  for (const t of tenants) saveKey(db, t, 'anthropic', KEY, master)
  return db
}
const queue = (db: Database.Database, tenant: string, n: number) => Array.from({ length: n }, (_, i) => createQueryJob(db, tenant, { query: `${tenant} job ${i}` }))
const finish = (db: Database.Database, id: string) =>
  db.prepare("UPDATE scan_jobs SET status = 'done', claimed_at = NULL, finished_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), id)

test('#712: shared queue flag off (deployed default): tenant A queues 6 scans first, tenant B\'s one scan starts before all of A\'s finish', () => {
  assert.equal(process.env.DAZL_SCAN_SHARED_QUEUE, undefined, 'default path: flag unset')
  const db = setup('A', 'B')
  queue(db, 'A', 6)
  const first = claimKeyedJob(db)!
  assert.equal(first.user_id, 'A')
  const [b] = queue(db, 'B', 1)
  finish(db, first.id)
  const next = claimKeyedJob(db)!
  assert.equal(next.id, b, 'B is claimed next, not A\'s 2nd scan')
  const aLeft = db.prepare("SELECT COUNT(*) AS n FROM scan_jobs WHERE user_id = 'A' AND status = 'pending'").get() as { n: number }
  assert.equal(aLeft.n, 5, 'B started while 5 of A\'s scans were still waiting')
})

test('#712: shared queue flag off: two tenants with backlogs alternate turns instead of first-come-first-served', () => {
  const db = setup('A', 'B')
  queue(db, 'A', 3); queue(db, 'B', 3)
  const order: string[] = []
  for (let i = 0; i < 6; i++) { const j = claimKeyedJob(db)!; order.push(j.user_id); finish(db, j.id) }
  assert.deepEqual(order, ['A', 'B', 'A', 'B', 'A', 'B'])
})
