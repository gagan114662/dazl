// One app instance for test/two-instance-scan.test.ts: its own Postgres pool on the shared schema (SI_SCHEMA). It runs
// scans the way the Db layer stores them: claim the queue item (lib/queue/db.ts), bind the scan_jobs row with the same
// conditional UPDATE the runner's claim uses (pending -> running, attempts + 1), "run" (a stub: no provider, no fetch,
// three deterministic leads per job), then end the attempt with finishJob (lib/scan/store-db.ts), fenced on the attempt
// it bound. Prints what it did as JSON on its last stdout line.
//   SI_MODE=drain  claim through the queue until it is empty
//   SI_MODE=race   no queue: try to bind every pending job directly, in shuffled order (two instances race each bind)
//   SI_MODE=crash  claim and bind one job, record the run, then hang until the parent kills it (SIGKILL)
//   SI_MODE=stall  claim and bind one job, then wait for the parent's 'go' and try to finish that old attempt
import { pgDb, type Db } from '../../lib/db/client.ts'
import { DbQueue } from '../../lib/queue/db.ts'
import { finishJob, type LeadRow } from '../../lib/scan/store-db.ts'

const name = process.env.SI_NAME!, mode = process.env.SI_MODE!
const db = pgDb({ connectionString: process.env.DAZL_TEST_PG_URL!, searchPath: process.env.SI_SCHEMA, max: 4 })
const q = new DbQueue(db, { backoff: { baseSeconds: 0, jitter: 0 } })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const nowS = () => Math.floor(Date.now() / 1000)
const claimOpts = { kinds: ['scan'], maxInFlight: 100, perTenantInFlight: 100, leaseSeconds: Number(process.env.SI_LEASE_S ?? 60) }
const out = (o: unknown) => process.stdout.write('\n' + JSON.stringify(o) + '\n')

// The runner's bind: only a pending job becomes this instance's attempt.
async function bind(d: Db, id: string): Promise<number | null> {
  const r = await d.get<{ attempts: number }>("UPDATE scan_jobs SET status = 'running', attempts = attempts + 1, claimed_at = ? WHERE id = ? AND status = 'pending' RETURNING attempts", [nowS(), id])
  return r ? Number(r.attempts) : null
}
// The stubbed scan: the same three leads for a job however often or wherever it runs.
const leadsFor = (id: string): LeadRow[] => [1, 2, 3].map(i => ({
  name: `Person ${i}`, company: `Company ${id.slice(0, 6)}-${i}`, contact: null, signal: 'Hiring a sales lead', source_url: `https://c${i}.example.test/${id}`,
  score: 60 + i, evidence_excerpt: 'We are hiring', event_date: null, date_status: 'undated', retrieved_at: null, confidence: null, dedup_key: `${id}:${i}`,
}))
const recordRun = (id: string, attempt: number) => db.run('INSERT INTO scan_test_runs (job_id, attempt, instance) VALUES (?, ?, ?)', [id, attempt, name])
const finish = (id: string, attempt: number) => finishJob(db, { id, attempts: attempt }, { status: 'done', error: null, leads: leadsFor(id), candidates: 3 })

async function barrier() { // both instances start together, so they really race
  await db.run('INSERT INTO scan_test_ready (instance) VALUES (?)', [name])
  while (Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM scan_test_ready'))!.n) < 2) await sleep(2)
}

if (mode === 'crash' || mode === 'stall') {
  const c = (await q.claim({ ...claimOpts, tenants: [process.env.SI_TENANT!] }))!
  const attempt = (await bind(db, c.item.id))!
  await recordRun(c.item.id, attempt)
  if (mode === 'crash') {
    out({ holding: c.item.id, attempt })
    setInterval(() => {}, 1000) // mid-job, until killed
  } else {
    await db.run('INSERT INTO scan_test_ready (instance) VALUES (?)', [name])
    while (!(await db.get("SELECT 1 AS x FROM scan_test_ready WHERE instance = 'go'"))) await sleep(20)
    const r = await finish(c.item.id, attempt) // the job was re-run elsewhere meanwhile: this attempt must write nothing
    const completed = await q.complete(c.token)
    await db.close()
    out({ job: c.item.id, attempt, owned: r.owned, completed })
  }
} else if (mode === 'drain') {
  await barrier()
  let ran = 0, stale = 0
  const worker = async () => {
    for (let idle = 0; idle < 3;) {
      const c = await q.claim(claimOpts)
      if (!c) { idle++; await sleep(20); continue }
      idle = 0
      const attempt = await bind(db, c.item.id)
      if (attempt === null) { stale++; await q.complete(c.token); continue }
      await recordRun(c.item.id, attempt)
      await sleep(3) // the job's work
      const r = await finish(c.item.id, attempt)
      if (r.owned && await q.complete(c.token)) ran++; else stale++
    }
  }
  await Promise.all([worker(), worker()])
  await db.close()
  out({ ran, stale })
} else if (mode === 'race') {
  await barrier()
  const ids = (await db.all<{ id: string }>("SELECT id FROM scan_jobs WHERE status = 'pending'")).map(r => r.id).sort(() => Math.random() - 0.5)
  let won = 0, lost = 0
  await Promise.all([0, 1].map(async w => {
    for (const id of ids.filter((_, i) => i % 2 === w)) {
      const attempt = await bind(db, id)
      if (attempt === null) { lost++; continue }
      won++
      await recordRun(id, attempt)
      await finish(id, attempt)
    }
  }))
  await db.close()
  out({ won, lost })
}
