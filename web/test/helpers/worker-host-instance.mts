// One worker host process for test/workers-two-process.test.ts: its own SQLite connection to the shared database file,
// running the test registry (test/helpers/worker-registry.ts). What it did is printed as JSON on stdout.
//   WH_MODE=drain  WH_CONC loops of claim -> execute -> finish until the worker queue is empty (or WH_DEADLINE_MS);
//                  each finished claim is recorded in wt_spans (start/end ms, outcome)
//   WH_MODE=local  control: the same, but limits enforced only inside this process (a semaphore of WH_LOCAL_CAP), the
//                  queue claimed without the deployment's caps: what process-local limits allow across two processes
//   WH_MODE=crash  claim one item, then exit(1) without finishing it (a host that died mid-run)
//   WH_MODE=hold   claim one item, mark it in wt_marks, wait for the parent's 'go' mark, then execute and finish it
//   WH_MODE=late   claim one item, mark it, wait until another host has finished the run, then finish it anyway
//   WH_MODE=enqueue  WH_N concurrent enqueues for tenant WH_TENANT (admission under contention)
import Database from 'better-sqlite3'
import { sqliteDb } from '../../lib/db/client.ts'
import { DbQueue } from '../../lib/queue/db.ts'
import { enqueueRun, WorkerHost, type Claimed } from '../../lib/workers/runtime.ts'
import { TEST_REGISTRY } from './worker-registry.ts'

const env = process.env
const name = env.WH_NAME!, mode = env.WH_MODE!
const raw = new Database(env.WH_DB!)
raw.pragma('busy_timeout = 10000')
const db = sqliteDb(raw)
const host = new WorkerHost(db, { registry: TEST_REGISTRY, instance: name, backoff: { baseSeconds: 0, jitter: 0 } })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const out = (v: unknown) => { process.stdout.write(JSON.stringify(v)); }
const mark = (what: string, item: string) => db.run('INSERT INTO wt_marks (host, what, item, at) VALUES (?, ?, ?, ?)', [name, what, item, Date.now()])
const marked = async (what: string, item?: string) => !!(await db.get(`SELECT 1 AS x FROM wt_marks WHERE what = ?${item ? ' AND item = ?' : ''}`, item ? [what, item] : [what]))
const active = async () => Number((await db.get<{ c: number }>("SELECT count(*) AS c FROM work_queue WHERE kind LIKE 'worker:%' AND status IN ('pending', 'claimed')"))!.c)

async function barrier() {
  if (!env.WH_BARRIER) return
  await db.run('INSERT INTO wt_ready (host) VALUES (?)', [name])
  while (Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM wt_ready'))!.n) < Number(env.WH_BARRIER)) await sleep(5)
}

async function span(c: Claimed, t0: number, t1: number, outcome: string) {
  await db.run('INSERT INTO wt_spans (item, tenant, host, t0, t1, outcome) VALUES (?, ?, ?, ?, ?, ?)', [c.claim.item.id, c.claim.item.tenantId, name, t0, t1, outcome])
}

// A span runs from just after the claim committed to just before its finish starts, so it lies inside the claim's
// lifetime: spans that overlap prove claims that overlapped.
const deadline = Date.now() + Number(env.WH_DEADLINE_MS ?? 20_000)
if (mode === 'drain') {
  await barrier()
  const counts: Record<string, number> = {}
  const loop = async () => {
    let idle = 0
    while (Date.now() < deadline && (env.WH_UNTIL === 'deadline' || idle < 3)) {
      await host.maintain()
      const c = await host.claimNext()
      if (!c) { if (env.WH_UNTIL !== 'deadline' && (await active()) === 0) idle++; await sleep(15); continue }
      const t0 = Date.now()
      idle = 0
      const res = await host.execute(c)
      const t1 = Date.now()
      const o = await host.finish(c, res)
      counts[o] = (counts[o] ?? 0) + 1
      await span(c, t0, t1, o)
    }
  }
  await Promise.all(Array.from({ length: Number(env.WH_CONC ?? 3) }, loop))
  out(counts)
} else if (mode === 'local') {
  await barrier()
  const q = new DbQueue(db, { backoff: { baseSeconds: 0, jitter: 0 } })
  let inFlight = 0, done = 0
  const cap = Number(env.WH_LOCAL_CAP ?? 2)
  const loop = async () => {
    while (Date.now() < deadline) {
      if (inFlight >= cap) { await sleep(5); continue }
      inFlight++
      const c = await q.claim({ kinds: [`worker:${env.WH_WORKER}`], maxInFlight: 1000, perTenantInFlight: 1000, leaseSeconds: 30 })
      if (!c) { inFlight--; if ((await active()) === 0) break; await sleep(15); continue }
      const t0 = Date.now()
      await sleep(Number(env.WH_SLEEP_MS ?? 100))
      const t1 = Date.now()
      await q.complete(c.token)
      inFlight--
      done++
      await db.run('INSERT INTO wt_spans (item, tenant, host, t0, t1, outcome) VALUES (?, ?, ?, ?, ?, ?)', [c.item.id, c.item.tenantId, name, t0, t1, 'done'])
    }
  }
  await Promise.all(Array.from({ length: Number(env.WH_CONC ?? 3) }, loop))
  out({ done })
} else if (mode === 'crash') {
  let c: Claimed | null = null
  while (!c && Date.now() < deadline) { c = await host.claimNext(); if (!c) await sleep(10) }
  await mark('claimed', c!.claim.item.id)
  out({ crashedOn: c!.claim.item.id })
  process.exit(1)
} else if (mode === 'hold' || mode === 'late') {
  let c: Claimed | null = null
  while (!c && Date.now() < deadline) { c = await host.claimNext(); if (!c) await sleep(10) }
  const id = c!.claim.item.id
  await mark('claimed', id)
  if (mode === 'hold') { while (!(await marked('go')) && Date.now() < deadline) await sleep(10) }
  else { while (!(await db.get("SELECT 1 AS x FROM worker_runs WHERE id = ? AND status = 'done'", [id])) && Date.now() < deadline) await sleep(20) }
  const res = mode === 'late' ? { ok: true as const, output: JSON.stringify({ n: -1, by: 'late' }) } : await host.execute(c!)
  out({ item: id, outcome: await host.finish(c!, res) })
} else if (mode === 'enqueue') {
  await barrier()
  const user = { tenantId: env.WH_TENANT!, actorId: env.WH_TENANT!, role: 'owner' as const }
  const rs = await Promise.all(Array.from({ length: Number(env.WH_N) }, (_, i) => enqueueRun(db, user, env.WH_WORKER!, { n: i })))
  out({ ok: rs.filter(r => r.ok).length, backlog: rs.filter(r => !r.ok && r.error === 'backlog').length })
}
await db.close()
