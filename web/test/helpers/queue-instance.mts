// One "app instance" for test/multi-instance.test.ts: its own Postgres pool on the shared schema, draining the shared
// queue (claim -> run -> complete) and spending a shared daily send allowance. Prints what it did as JSON.
//   QI_MODE=drain  claim until the queue is empty; every run is recorded in queue_test_runs
//   QI_MODE=crash  claim one item, record the run, then exit without completing (an instance that died mid-job)
import { pgDb } from '../../lib/db/client.ts'
import { DbQueue } from '../../lib/queue/db.ts'
import { rateLimit } from '../../lib/rate-limit.ts'

const name = process.env.QI_NAME!, mode = process.env.QI_MODE!
const db = pgDb({ connectionString: process.env.DAZL_TEST_PG_URL!, searchPath: process.env.QI_SCHEMA, max: 4 })
const q = new DbQueue(db, { backoff: { baseSeconds: 0, jitter: 0 } })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const claimOpts = { maxInFlight: 100, perTenantInFlight: 100, leaseSeconds: Number(process.env.QI_LEASE_S ?? 60) }

if (mode === 'crash') {
  const c = (await q.claim({ ...claimOpts, tenants: [process.env.QI_TENANT!] }))! // the job this instance dies holding
  await db.run('INSERT INTO queue_test_runs (item_id, instance) VALUES (?, ?)', [c.item.id, name])
  process.stdout.write(JSON.stringify({ crashedOn: c.item.id }))
  process.exit(1) // no complete, no clean shutdown
}

// Start barrier: both instances register, then wait for each other, so they really race.
await db.run('INSERT INTO queue_test_ready (instance) VALUES (?)', [name])
while (Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM queue_test_ready'))!.n) < 2) await sleep(2)

let ran = 0, lateCompletes = 0, sendsAllowed = 0
const worker = async () => {
  for (let idle = 0; idle < 3;) {
    const c = await q.claim(claimOpts)
    if (!c) { idle++; await sleep(20); continue }
    idle = 0
    await db.run('INSERT INTO queue_test_runs (item_id, instance) VALUES (?, ?)', [c.item.id, name])
    await sleep(3) // the job's work
    if (await q.complete(c.token)) ran++; else lateCompletes++
  }
}
// two workers per instance, plus this instance's share of the day's sends against one daily cap
await Promise.all([worker(), worker(), ...Array.from({ length: 10 }, async () => {
  if ((await rateLimit(`send-day:${process.env.QI_TENANT}`, 12, 86_400_000, db)).ok) sendsAllowed++
})])
await db.close()
process.stdout.write(JSON.stringify({ ran, lateCompletes, sendsAllowed }))
