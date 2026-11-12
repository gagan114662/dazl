// The legacy (non-queue) scan claimer is fair across tenants (#1081): it no longer takes the oldest pending job of ANY
// tenant, so one tenant's backlog (a 50-domain CSV import) cannot hold every other tenant's scan behind it. Order:
// the tenant with the fewest running jobs first, then the tenant served least recently, then the oldest job.
// In-memory SQLite, synthetic tenants and keys; nothing runs, only claims.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { createQueryJob } from '../lib/scan/store.ts'
import { claimKeyedJob } from '../lib/scan/runner.ts'

const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64')
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function setup(...tenants: string[]) {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  for (const t of tenants) saveKey(db, t, 'anthropic', KEY, master)
  return db
}
const queue = (db: Database.Database, tenant: string, n: number) => Array.from({ length: n }, (_, i) => createQueryJob(db, tenant, { query: `${tenant} job ${i}` }))
const finish = (db: Database.Database, id: string) => db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)

test('#1081: tenant A holds 50 pending CSV-style jobs and all 3 slots; tenant B\'s one scan is claimed at the next slot turnover', () => {
  const db = setup('A', 'B')
  queue(db, 'A', 50)
  const running = [claimKeyedJob(db)!, claimKeyedJob(db)!, claimKeyedJob(db)!]
  assert.deepEqual(running.map(j => j.user_id), ['A', 'A', 'A'], 'fixture: A filled the 3 slots before B arrived')
  const [b] = queue(db, 'B', 1)
  finish(db, running[0].id) // one slot frees
  const next = claimKeyedJob(db)!
  assert.equal(next.user_id, 'B', 'B is next, not A\'s 4th job')
  assert.equal(next.id, b)
})

test('#1081: with equal running counts, the tenant served least recently goes first, even if its job is newer', () => {
  const db = setup('A', 'B')
  queue(db, 'A', 2)
  const a1 = claimKeyedJob(db)!
  assert.equal(a1.user_id, 'A')
  finish(db, a1.id)
  queue(db, 'B', 1) // newer than A's remaining job; A was just served, B never
  assert.equal(claimKeyedJob(db)!.user_id, 'B')
  assert.equal(claimKeyedJob(db)!.user_id, 'A')
})

test('#1081: within one tenant, jobs are still claimed oldest first', () => {
  const db = setup('A')
  const ids = queue(db, 'A', 4)
  const got = [claimKeyedJob(db)!.id, claimKeyedJob(db)!.id, claimKeyedJob(db)!.id, claimKeyedJob(db)!.id]
  assert.deepEqual(got, ids)
  assert.equal(claimKeyedJob(db), null)
})
