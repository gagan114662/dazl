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
// Production-shaped finish (runner.ts finish(), store-db.ts): claimed_at is cleared, finished_at is set.
const finish = (db: Database.Database, id: string, at = Math.floor(Date.now() / 1000)) =>
  db.prepare("UPDATE scan_jobs SET status = 'done', claimed_at = NULL, finished_at = ? WHERE id = ?").run(at, id)

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

test('#1081: five tenants with backlogs and 3 slots rotate through every tenant evenly, even when finish times tie at the second', () => {
  const db = setup('A', 'B', 'C', 'D', 'E')
  for (const t of ['A', 'B', 'C', 'D', 'E']) queue(db, t, 10)
  const served: Record<string, number> = {}
  const slots = [claimKeyedJob(db)!, claimKeyedJob(db)!, claimKeyedJob(db)!]
  for (let turn = 0; turn < 30; turn++) {
    const done = slots.shift()!
    served[done.user_id] = (served[done.user_id] ?? 0) + 1
    finish(db, done.id) // production clock: finishes in the same second tie on finish time
    slots.push(claimKeyedJob(db)!)
  }
  assert.deepEqual(Object.keys(served).sort(), ['A', 'B', 'C', 'D', 'E'], 'every tenant was served')
  const counts = Object.values(served)
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `served evenly: ${JSON.stringify(served)}`)
})

test('#1081: a job still in post-finish enrichment holds its tenant\'s slot, so the idle tenant goes first', () => {
  const db = setup('A', 'B')
  queue(db, 'A', 2)
  const a1 = claimKeyedJob(db)!
  // finish() wrote the rows; enrichment is still running for A's job (it holds the in-process run slot)
  finish(db, a1.id, 1_700_000_000)
  db.prepare("UPDATE scan_jobs SET enrich_started_at = CAST(strftime('%s','now') AS INTEGER), enrich_finished_at = NULL WHERE id = ?").run(a1.id)
  queue(db, 'B', 1)
  assert.equal(claimKeyedJob(db)!.user_id, 'B')
  // a stale enrichment mark (a crash, never ended) stops counting after its window
  const db2 = setup('A', 'B')
  queue(db2, 'A', 2)
  const x = claimKeyedJob(db2)!
  finish(db2, x.id, 1)
  db2.prepare("UPDATE scan_jobs SET enrich_started_at = 2, enrich_finished_at = NULL WHERE id = ?").run(x.id)
  queue(db2, 'B', 1)
  db2.prepare("UPDATE scan_jobs SET finished_at = ? WHERE user_id = 'B'").run(0)
  assert.equal(claimKeyedJob(db2)!.user_id, 'B', 'B never served: still first')
  assert.equal(claimKeyedJob(db2)!.user_id, 'A', 'A is not blocked forever by a stale enrichment mark')
})

// Claim cost (#1081 review): the claim runs on every kick (scan, CSV, plays, status poll, tick) inside an IMMEDIATE
// transaction on the synchronous driver, so its cost must be bounded by the queue, never by history.
function claimPlan(db: Database.Database): { id: number; parent: number; detail: string }[] {
  let sql = ''
  const orig = db.prepare.bind(db)
  const spy = (s: string) => { if (s.includes('WITH eligible')) sql = s; return orig(s) }
  ;(db as unknown as { prepare: typeof spy }).prepare = spy
  try { claimKeyedJob(db) } finally { (db as unknown as { prepare: typeof orig }).prepare = orig }
  assert.ok(sql, 'the claim query was captured')
  return orig('EXPLAIN QUERY PLAN ' + sql).all() as { id: number; parent: number; detail: string }[]
}
function assertBoundedPlan(plan: { id: number; parent: number; detail: string }[], label: string) {
  const text = plan.map(p => p.detail).join('\n')
  assert.match(text, /SEARCH scan_jobs USING INDEX scan_jobs_enriching \(enrich_started_at>\?\)/, `${label}: the enrichment arm seeks the partial index`)
  // scan_jobs_status serves exactly the 'pending' (eligible) and 'running' arms; a third use is the 'done' history walk
  assert.equal(plan.filter(p => /scan_jobs_status/.test(p.detail)).length, 2, `${label}: no arm walks status='done':\n${text}`)
  // no full scan of scan_jobs under any alias: the only SCAN steps allowed read the small materialized sets
  // (e = eligible, t = its distinct tenants, the running union's subquery), never the table
  const scans = plan.filter(p => /^SCAN /.test(p.detail) && !/^SCAN (e|t|eligible|\(subquery-\d+\))$/.test(p.detail))
  assert.deepEqual(scans.map(p => p.detail), [], `${label}: no full table scan of scan_jobs (any alias):\n${text}`)
  // the per-tenant figures are computed once per tenant (inside the materialized `served`), not once per pending job
  const byId = new Map(plan.map(p => [p.id, p]))
  const inServed = (p: { parent: number }): boolean => { for (let q = byId.get(p.parent); q; q = byId.get(q.parent)) if (/MATERIALIZE served/.test(q.detail)) return true; return false }
  const correlated = plan.filter(p => /CORRELATED SCALAR SUBQUERY/.test(p.detail))
  assert.equal(correlated.length, 3, `${label}: the three per-tenant subqueries`)
  for (const c of correlated) assert.ok(inServed(c), `${label}: ${c.detail} runs inside MATERIALIZE served, not per pending row:\n${text}`)
}

test('#1081: the claim query plan stays bounded by the queue, never by the done history (enrichment arm on scan_jobs_enriching; per-tenant figures materialized)', () => {
  const db = setup('A', 'B')
  queue(db, 'A', 3); queue(db, 'B', 1)
  assertBoundedPlan(claimPlan(db), 'empty history')
  // Each stage pins different regressions; keep both. The empty-history stage (no sqlite_stat1) is the one that
  // catches the done arm losing `+status` (with statistics SQLite picks scan_jobs_enriching anyway). This stage, with
  // a long done history and fresh statistics, is the one that catches an arm such as 'running' walking that history.
  const now = Math.floor(Date.now() / 1000)
  const hist = db.transaction(() => [...queue(db, 'A', 2500), ...queue(db, 'B', 2500)])()
  const run = db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?")
  const done = db.prepare("UPDATE scan_jobs SET status = 'done', finished_at = ?, enrich_started_at = ?, enrich_finished_at = ? WHERE id = ?")
  db.transaction(() => hist.forEach((id, i) => { run.run(id); done.run(now - 86400 + i, now - 86400 + i, now - 86400 + i, id) }))()
  db.exec('ANALYZE')
  assertBoundedPlan(claimPlan(db), '5000 done rows + ANALYZE')
})
