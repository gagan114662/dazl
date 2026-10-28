// Shared-queue scan claiming (lib/queue/scan-claimer.ts, DAZL_SCAN_SHARED_QUEUE): the claim rules on both engines, and
// kickRunner with the flag on and off. The scan run itself is a stub here (or, through kickRunner, the real runner
// with stubbed providers that are never reached); nothing leaves the process. The two-process Postgres cases are in
// two-instance-scan.test.ts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { setDb, sqliteDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { DbQueue } from '../lib/queue/db.ts'
import { kickSharedScanQueue, sharedScanQueue, type ClaimedScan } from '../lib/queue/scan-claimer.ts'
import { createJob, finishJob } from '../lib/scan/store-db.ts'
import { setErrorSinks } from '../lib/ops/errors.ts'
import { bothEngines } from './helpers/engines.ts'

const A = 'a'.repeat(32), B = 'b'.repeat(32), NOKEY = 'c'.repeat(32)
const LEASE = 60
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)) }
const until = async (cond: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)) } }

async function seed(db: Db) {
  for (const t of [A, B]) await db.run("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at, created_at) VALUES (?, 'anthropic', 'x', '1234', 1, 1)", [t])
  const job = (t: string, funded = 'user') => createJob(db, t, { business_name: 'Co', industry: 'dental', location: 'Toronto' }).then(async id => { if (funded !== 'user') await db.run('UPDATE scan_jobs SET funded_by = ? WHERE id = ?', [funded, id]); return id })
  return { job }
}
function harness(db: Db, slots = 10) {
  let inFlight = 0
  const ran: string[] = [], crashed: string[] = []
  const deps = (run?: (j: ClaimedScan) => Promise<'done' | 'failed' | 'retry'>) => ({
    queue: db, domain: db, leaseSeconds: LEASE,
    slots: { available: () => inFlight < slots, acquire: () => { inFlight++ }, release: () => { inFlight-- } },
    onCrash: (j: ClaimedScan) => { crashed.push(j.id) },
    run: run ?? (async (j: ClaimedScan) => { ran.push(`${j.id}@${j.attempts}`); return (await finishJob(db, j, { status: 'done', error: null })).owned ? 'done' as const : 'failed' as const }),
  })
  return { deps, ran, crashed, inFlight: () => inFlight }
}
const status = async (db: Db, id: string) => (await db.get<{ status: string; attempts: number; error: string | null }>('SELECT status, attempts, error FROM scan_jobs WHERE id = ?', [id]))!

test('the flag is off unless DAZL_SCAN_SHARED_QUEUE is exactly 1', () => {
  assert.equal(sharedScanQueue({}), false)
  for (const v of ['0', 'true', 'yes', ' 1', '']) assert.equal(sharedScanQueue({ DAZL_SCAN_SHARED_QUEUE: v }), false, v)
  assert.equal(sharedScanQueue({ DAZL_SCAN_SHARED_QUEUE: '1' }), true)
})

bothEngines('funded pending scans are mirrored, claimed, bound and run once; an unfunded one waits, as with the legacy claimer', async ({ db }) => {
  const { job } = await seed(db)
  const a1 = await job(A), b1 = await job(B), trial = await job(NOKEY, 'trial'), unfunded = await job(NOKEY)
  const h = harness(db)
  await kickSharedScanQueue(h.deps()); await until(() => h.inFlight() === 0)
  assert.deepEqual(h.ran.sort(), [`${a1}@1`, `${b1}@1`, `${trial}@1`].sort())
  for (const id of [a1, b1, trial]) assert.deepEqual([(await status(db, id)).status, (await new DbQueue(db).get(id))!.status], ['done', 'done'])
  assert.deepEqual([(await status(db, unfunded)).status, await new DbQueue(db).get(unfunded)], ['pending', undefined], 'no key, not trial: not mirrored')
  // a second kick runs nothing again
  await kickSharedScanQueue(h.deps()); await until(() => h.inFlight() === 0)
  assert.equal(h.ran.length, 3)
  assert.equal(h.inFlight(), 0, 'every slot released')
})

bothEngines('run slots bound how many scans one instance takes per kick; the rest stay queued for the next kick or instance', async ({ db }) => {
  const { job } = await seed(db)
  for (let i = 0; i < 5; i++) await job(A)
  const h = harness(db, 2)
  const gate: (() => void)[] = []
  await kickSharedScanQueue(h.deps(j => new Promise(res => gate.push(() => { h.ran.push(j.id); res('done') }))))
  assert.equal(h.inFlight(), 2)
  assert.equal(await new DbQueue(db).depth({ status: 'claimed' }), 2)
  assert.equal(await new DbQueue(db).depth({ status: 'pending' }), 3)
  for (const g of gate) g()
  await until(() => h.inFlight() === 0) // the items settle asynchronously (a Postgres round trip each)
  assert.equal(await new DbQueue(db).depth({ status: 'done' }), 2)
})

bothEngines('a scan cancelled while queued completes its item without running; a live attempt elsewhere is not bound twice', async ({ db }) => {
  const { job } = await seed(db)
  const cancelled = await job(A), live = await job(B)
  const q = new DbQueue(db)
  // mirrored by an earlier kick that had no free slot
  await kickSharedScanQueue({ ...harness(db, 0).deps() })
  assert.deepEqual([(await q.get(cancelled))!.status, (await q.get(live))!.status], ['pending', 'pending'])
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id IN (?, ?)", [Math.floor(Date.now() / 1000), cancelled, live])
  await db.run("UPDATE scan_jobs SET status = 'failed', error = 'cancelled', claimed_at = NULL WHERE id = ?", [cancelled])
  const h = harness(db)
  await kickSharedScanQueue(h.deps()); await until(() => h.inFlight() === 0)
  assert.deepEqual(h.ran, [], 'nothing ran')
  assert.equal((await q.get(cancelled))!.status, 'done', 'a finished scan needs no run: its item completes')
  assert.equal((await q.get(live))!.status, 'pending', 'a fresh running row is a live attempt: released for a retry')
  assert.deepEqual([(await status(db, live)).status, (await status(db, live)).attempts], ['running', 1], 'and left alone')
})

bothEngines('a scan whose worker died (running past the lease) is taken over as the next attempt', async ({ db }) => {
  const { job } = await seed(db)
  const id = await job(A)
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id = ?", [Math.floor(Date.now() / 1000) - LEASE - 5, id])
  const h = harness(db)
  await kickSharedScanQueue(h.deps()); await until(() => h.inFlight() === 0)
  assert.deepEqual(h.ran, [`${id}@2`])
  assert.deepEqual([(await status(db, id)).status, (await status(db, id)).attempts], ['done', 2])
})

// Review on #301: a stale reclaim must respect the retry cap exactly as the legacy reaper does (reapStaleJobs): at
// MAX_ATTEMPTS (3) the scan fails as 'timeout' and is never run a fourth time; below it, it runs as the next attempt.
for (const withItem of [false, true]) {
  bothEngines(`retry cap: a stale scan at attempt 3 fails as timeout and never runs as attempt 4; at attempt 2 it runs as attempt 3 (${withItem ? 'its queue item claimed by the dead instance' : 'no queue item yet'})`, async ({ db }) => {
    const { job } = await seed(db)
    const atCap = await job(A), below = await job(B)
    const q = new DbQueue(db)
    const now = Math.floor(Date.now() / 1000)
    if (withItem) {
      // mirrored and claimed by an instance that then died: the claims' leases have run out
      await kickSharedScanQueue({ ...harness(db, 0).deps() })
      for (let i = 0; i < 2; i++) assert.ok(await q.claim({ kinds: ['scan'], leaseSeconds: LEASE, perTenantInFlight: 9, maxInFlight: 9 }))
      await db.run("UPDATE work_queue SET lease_expires_at = ? WHERE status = 'claimed'", [now - 5])
    }
    for (const [id, attempts] of [[atCap, 3], [below, 2]] as const) await db.run("UPDATE scan_jobs SET status = 'running', attempts = ?, claimed_at = ? WHERE id = ?", [attempts, now - LEASE - 5, id])
    const h = harness(db)
    // an expired claim is reaped by the next claim and goes back to pending after the queue's retry backoff
    // (DEFAULT_BACKOFF): one kick reaps it, the next one after the backoff runs it
    const later = withItem ? { now: () => Math.floor(Date.now() / 1000) + 7200 } : {}
    if (withItem) { await kickSharedScanQueue({ ...h.deps(), now: () => Math.floor(Date.now() / 1000) + 3600 }); await until(() => h.inFlight() === 0); assert.deepEqual(h.ran, []) }
    await kickSharedScanQueue({ ...h.deps(), ...later }); await until(() => h.inFlight() === 0)
    assert.deepEqual(h.ran, [`${below}@3`], 'only the scan below the cap ran, as attempt 3')
    const capped = await db.get<{ status: string; error: string; attempts: number; claimed_at: number | null; finished_at: number | null }>('SELECT status, error, attempts, claimed_at, finished_at FROM scan_jobs WHERE id = ?', [atCap])
    assert.deepEqual({ ...capped!, attempts: Number(capped!.attempts), finished_at: capped!.finished_at !== null }, { status: 'failed', error: 'timeout', attempts: 3, claimed_at: null, finished_at: true }, 'the legacy reaper\'s outcome')
    assert.deepEqual([(await status(db, below)).status, (await status(db, below)).attempts], ['done', 3])
    // a second kick changes nothing: the capped scan stays failed, never attempt 4
    await kickSharedScanQueue({ ...h.deps(), ...later }); await until(() => h.inFlight() === 0)
    assert.equal(h.ran.length, 1)
    assert.equal((await status(db, atCap)).attempts, 3)
    const item = await q.get(atCap)
    if (withItem) assert.equal(item!.status, 'done', 'its queue item is settled without running')
    else assert.equal(item, undefined, 'a failed scan is never mirrored')
  })
}

bothEngines('a crash fails the item (not retried) and goes to onCrash; a retry outcome puts the item back; a scan pending again after a terminal item is re-enqueued', async ({ db }) => {
  const { job } = await seed(db)
  const boom = await job(A)
  const h = harness(db)
  await kickSharedScanQueue(h.deps(async () => { throw new Error('escaped runJob') })); await until(() => h.inFlight() === 0)
  assert.deepEqual(h.crashed, [boom])
  const q = new DbQueue(db)
  assert.deepEqual([(await q.get(boom))!.status, (await q.get(boom))!.lastError], ['failed', 'executor_failed'])
  // the runner put the scan back to pending (a retryable failure): the dead item is retired and a new one enqueued
  await db.run("UPDATE scan_jobs SET status = 'pending', claimed_at = NULL WHERE id = ?", [boom])
  await kickSharedScanQueue(h.deps()); await until(() => h.inFlight() === 0)
  assert.deepEqual(h.ran, [`${boom}@2`])
  assert.equal((await q.get(boom))!.status, 'done')
  const again = await job(B)
  await kickSharedScanQueue(h.deps(async () => 'retry')); await until(() => h.inFlight() === 0)
  assert.deepEqual([(await q.get(again))!.status, (await q.get(again))!.lastError], ['pending', 'executor_retry'])
})

test('kickRunner with the flag on claims through the work queue (the real runner, its crash path); off, the queue is untouched', async () => {
  const { kickRunner } = await import('../lib/scan/runner.ts')
  const { saveKey } = await import('../lib/llm/key-store.ts')
  const run = async (flag: boolean) => {
    const raw = new Database(':memory:'); migrateAllSqlite(raw); setDb(sqliteDb(raw))
    const master = randomBytes(32); saveKey(raw, A, 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
    const id = await createJob(sqliteDb(raw), A, { business_name: 'Co', industry: 'dental', location: 'Toronto' })
    const providers = { anthropic: { research: async () => { throw new Error('provider must not be reached') } } } as never
    const restore = setErrorSinks([])
    if (flag) process.env.DAZL_SCAN_SHARED_QUEUE = '1'
    try {
      // the job's clock throws before runJob's own try: a crash, so no provider call and no network
      await kickRunner(raw, { providers, master, score: false, jobBudgetMs: 60_000, clock: () => { throw new Error('clock broke') } })
      await flush()
    } finally { restore(); delete process.env.DAZL_SCAN_SHARED_QUEUE; setDb(null) }
    const job = raw.prepare('SELECT status, error, attempts FROM scan_jobs WHERE id = ?').get(id)
    const items = raw.prepare('SELECT id, status, last_error FROM work_queue').all()
    raw.close()
    return { id, job, items }
  }
  const on = await run(true)
  assert.deepEqual(on.job, { status: 'failed', error: 'crashed', attempts: 1 })
  assert.deepEqual(on.items, [{ id: on.id, status: 'failed', last_error: 'executor_failed' }], 'claimed through the queue')
  const off = await run(false)
  assert.deepEqual(off.job, { status: 'failed', error: 'crashed', attempts: 1 }, 'the legacy claimer ran it the same way')
  assert.deepEqual(off.items, [], 'flag off: the work queue is never touched')
})
