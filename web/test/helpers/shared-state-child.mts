// One "app instance" for test/shared-state.test.ts: opens the shared store, then races the other instance for leases
// and rate-limit allowance. Prints what it got as JSON.
import Database from 'better-sqlite3'
import { sqliteDb, pgDb } from '../../lib/db/client.ts'
import type { Db } from '../../lib/db/client.ts'
import { tryLease } from '../../lib/shared/lease.ts'
import { rateLimit } from '../../lib/rate-limit.ts'

let db: Db
if (process.env.CHILD_SQLITE) {
  const raw = new Database(process.env.CHILD_SQLITE)
  raw.pragma('busy_timeout = 10000')
  db = sqliteDb(raw)
} else {
  db = pgDb({ connectionString: process.env.DAZL_TEST_PG_URL!, searchPath: process.env.CHILD_PG_SCHEMA, max: 8 })
}
// Start barrier: each instance marks itself ready in the shared store and waits for the other, so both race together
// whatever their process start-up time.
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
await tryLease(db, `ready-${process.env.CHILD_ORDER}`, { ttlMs: 600_000, stepBudgetMs: 1000, heartbeat: false })
while (Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM app_leases WHERE name LIKE 'ready-%'"))!.n) < 2) await sleep(2)
const jobs = Array.from({ length: 40 }, (_, i) => `job-${String(i).padStart(2, '0')}`)
const claimed: string[] = []
let allowed = 0
// The two instances walk the job list from opposite ends, one job at a time, like two workers polling a queue: each
// wins its own end and they contend where they meet.
if (process.env.CHILD_ORDER === 'desc') jobs.reverse()
await Promise.all([
  (async () => { for (const j of jobs) { if (await tryLease(db, j, { ttlMs: 60_000, stepBudgetMs: 1000, heartbeat: false })) claimed.push(j); await sleep(2) } })(), // 2ms of 'work' per job
  ...Array.from({ length: 40 }, async () => { if ((await rateLimit('shared-burst', 30, 60_000, db)).ok) allowed++ }),
])
await db.close()
process.stdout.write(JSON.stringify({ claimed, allowed }))
