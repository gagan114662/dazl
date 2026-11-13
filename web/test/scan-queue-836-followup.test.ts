// #836 follow-up: the review findings on the shared scan queue with two processes, and the decision of 2026-11-13 that a
// graceful restart must not leave an account locked out for the lease. Each test is the scenario of one finding.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { sqliteDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { DbQueue } from '../lib/queue/db.ts'
import { kickSharedScanQueue, renewScanLeases, type ClaimedScan } from '../lib/queue/scan-claimer.ts'
import { createJob, finishJob } from '../lib/scan/store-db.ts'
import { requeueInFlightForShutdown, trackInFlight, type Job } from '../lib/scan/runner.ts'
import { MAX_ATTEMPTS } from '../lib/scan/store.ts'
import { workerPass } from '../lib/scan/worker.ts'

const A = 'a'.repeat(32), B = 'b'.repeat(32), LEASE = 600
const nowS = () => Math.floor(Date.now() / 1000)
const until = async (cond: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)) } }
function world() {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  for (const t of [A, B]) {
    raw.prepare("INSERT INTO users (id, email, business_name, password_hash, salt, created_at) VALUES (?, ?, 'Co', 'x', 'x', 1)").run(t, `${t.slice(0, 4)}@example.test`)
    raw.prepare("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at, created_at) VALUES (?, 'anthropic', 'x', '1234', 1, 1)").run(t)
  }
  const job = (t: string) => createJob(db, t, { business_name: 'Co', industry: 'dental', location: 'Toronto' })
  const reserve = (id: string, t: string, attempt: number) => raw.prepare("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, created_at) VALUES (?, ?, ?, ?, 'llm.anthropic', 0.02, 'reserved', ?)").run(`c-${id}-${attempt}`, t, id, attempt, nowS())
  const scan = (id: string) => raw.prepare('SELECT status, attempts, error FROM scan_jobs WHERE id = ?').get(id) as { status: string; attempts: number; error: string | null }
  const item = (id: string) => raw.prepare('SELECT status, attempts, claim_token, lease_expires_at FROM work_queue WHERE id = ?').get(id) as { status: string; attempts: number; claim_token: number | null; lease_expires_at: number | null } | undefined
  let inFlight = 0
  const ran: string[] = []
  const deps = (run?: (j: ClaimedScan) => Promise<'done' | 'failed' | 'retry'>, over: { now?: () => number; track?: (j: ClaimedScan, token: number) => () => void } = {}) => ({
    queue: db as Db, domain: db as Db, leaseSeconds: LEASE, log: () => {}, ...over,
    slots: { available: () => inFlight < 3, acquire: () => { inFlight++ }, release: () => { inFlight-- } }, onCrash: () => {},
    run: run ?? (async (j: ClaimedScan) => { ran.push(`${j.id}@${j.attempts}`); return (await finishJob(db, j, { status: 'done', error: null })).owned ? 'done' as const : 'failed' as const }),
  })
  return { raw, db, job, reserve, scan, item, deps, ran, idle: () => inFlight === 0 }
}

test('#836 review 3: a pending scan that still holds a reserved paid call is never started by the shared queue: it ends accounting_uncertain, and a clean scan beside it runs', async () => {
  const w = world()
  const dirty = await w.job(A), clean = await w.job(B)
  w.reserve(dirty, A, 1) // an earlier attempt's paid call, never settled (data from before #594)
  await kickSharedScanQueue(w.deps()); await until(w.idle)
  await kickSharedScanQueue(w.deps()); await until(w.idle)
  assert.deepEqual(w.ran, [`${clean}@1`], 'only the clean scan ran')
  assert.deepEqual(w.scan(dirty), { status: 'failed', attempts: 0, error: 'accounting_uncertain' })
  assert.equal((w.raw.prepare("SELECT status FROM scan_spend_calls WHERE scan_job_id = ?").get(dirty) as { status: string }).status, 'reserved', 'the paid call stays on record')
  // and the bind itself refuses such a row even when it is offered one (a reservation landing between the park and the bind)
  const late = await w.job(A)
  const q = new DbQueue(w.db)
  await q.enqueue({ id: late, tenantId: A, kind: 'scan' })
  w.raw.prepare("UPDATE scan_jobs SET status = 'pending' WHERE id = ?").run(late)
  w.reserve(late, A, 1)
  w.raw.exec("CREATE TRIGGER hold_park BEFORE UPDATE OF status ON scan_jobs WHEN NEW.claimed_at = 0 BEGIN SELECT RAISE(IGNORE); END") // the park step skipped: only the bind's own guard is left
  await kickSharedScanQueue(w.deps()); await until(w.idle)
  assert.equal(w.ran.includes(`${late}@1`), false, 'the bind refused the row')
  assert.equal(w.scan(late).status, 'pending')
  w.raw.close()
})

test('#836 review 2: a live scan keeps its queue claim past the lease (its row\'s claim time, renewed by paid calls, is copied to the item); a dead one still loses it', async () => {
  const w = world()
  const live = await w.job(A), dead = await w.job(B)
  let release: (() => void) | undefined
  const hold = () => new Promise<'done'>(r => { release = () => r('done') })
  const t0 = nowS()
  await kickSharedScanQueue(w.deps(hold, { now: () => t0 }))
  assert.equal(w.item(live)!.status, 'claimed'); assert.equal(w.item(dead)!.status, 'claimed')
  const firstLease = w.item(live)!.lease_expires_at!
  // LEASE + 60 s later: the live scan made a paid call a minute ago (its row's claim time moved); the dead one did not
  const later = t0 + LEASE + 60
  w.raw.prepare('UPDATE scan_jobs SET claimed_at = ? WHERE id = ?').run(later - 60, live)
  assert.equal(await renewScanLeases(w.db, w.db, LEASE), 1, 'one lease renewed')
  assert.equal(w.item(live)!.lease_expires_at, later - 60 + LEASE); assert.ok(w.item(live)!.lease_expires_at! > firstLease)
  const token = w.item(live)!.claim_token
  await kickSharedScanQueue(w.deps(hold, { now: () => later }))
  assert.deepEqual([w.item(live)!.status, w.item(live)!.claim_token, w.item(live)!.attempts], ['claimed', token, 1], 'the live scan\'s claim is untouched: not reaped, not re-claimed')
  assert.deepEqual(w.scan(live), { status: 'running', attempts: 1, error: null })
  assert.notEqual(w.item(dead)!.claim_token, w.item(live)!.claim_token)
  assert.equal(w.scan(dead).attempts >= 1, true)
  assert.ok(w.item(dead)!.status !== 'claimed' || w.item(dead)!.attempts === 2, 'the dead scan\'s claim ran out with its lease')
  // a renewal never resurrects a claim that changed hands: compare-and-set on the old lease
  w.raw.prepare("UPDATE work_queue SET lease_expires_at = lease_expires_at + 1 WHERE id = ?").run(live)
  w.raw.prepare('UPDATE scan_jobs SET claimed_at = claimed_at - 5 WHERE id = ?').run(live)
  assert.equal(await renewScanLeases(w.db, w.db, LEASE), 0, 'nothing to renew when the row\'s time is not newer')
  release?.()
  w.raw.close()
})

test('#836 review 5: a pending scan with no saved key (and not trial-funded) is not work for the worker: no kick, no write, pass after pass; with a key it is', async () => {
  const w = world()
  const keyless = 'c'.repeat(32)
  w.raw.prepare("INSERT INTO users (id, email, business_name, password_hash, salt, created_at) VALUES (?, 'c@example.test', 'Co', 'x', 'x', 1)").run(keyless)
  const id = await w.job(keyless)
  let kicks = 0
  const pass = () => workerPass({ db: w.raw, kick: async () => { kicks++ }, env: { DAZL_SCAN_SHARED_QUEUE: '1' } })
  const before = w.raw.prepare('SELECT total_changes() AS n').get()
  for (let i = 0; i < 5; i++) assert.equal(await pass(), 'idle')
  assert.equal(kicks, 0); assert.deepEqual(w.raw.prepare('SELECT total_changes() AS n').get(), before, 'no write while it waits for a key')
  w.raw.prepare("UPDATE scan_jobs SET funded_by = 'trial' WHERE id = ?").run(id)
  assert.equal(await pass(), 'kicked', 'trial-funded: the queue takes it')
  w.raw.prepare("UPDATE scan_jobs SET funded_by = 'user' WHERE id = ?").run(id)
  w.raw.prepare("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at, created_at) VALUES (?, 'anthropic', 'x', '1234', 1, 1)").run(keyless)
  assert.equal(await pass(), 'kicked', 'a saved key: the queue takes it')
  assert.equal(kicks, 2)
  w.raw.close()
})

test('#836 decision 2026-11-13: a graceful stop with a paid call in flight ends the scan at once as accounting_uncertain (the call stays recorded, the scan is never run again), closes its queue claim, and the account\'s next scan is claimable immediately', async () => {
  const w = world()
  const first = await w.job(A)
  const tracked: [ClaimedScan, number][] = []
  await kickSharedScanQueue(w.deps(() => new Promise(() => {}), { track: (j, token) => { tracked.push([j, token]); return trackInFlight(j as Job, token) } }))
  assert.equal(w.scan(first).status, 'running')
  w.reserve(first, A, 1) // the paid call in flight when the process is told to stop
  assert.equal(requeueInFlightForShutdown(w.raw), 0, 'not handed back')
  assert.deepEqual(w.scan(first), { status: 'failed', attempts: 1, error: 'accounting_uncertain' }, 'ended now, not after the lease')
  assert.deepEqual([w.item(first)!.status, w.item(first)!.claim_token], ['done', null], 'its queue claim is closed')
  assert.equal((w.raw.prepare('SELECT status FROM scan_spend_calls WHERE scan_job_id = ?').get(first) as { status: string }).status, 'reserved', 'the paid call stays recorded, unsettled')
  for (const [j] of tracked) trackInFlight(j as Job)() // the stopped process is gone
  // the same account's next scan runs at once on the other process (per-tenant limit 1: the dead claim no longer counts)
  const next = await w.job(A)
  const ran: string[] = []
  await kickSharedScanQueue({ ...w.deps(async j => { ran.push(`${j.id}@${j.attempts}`); return (await finishJob(w.db, j, { status: 'done', error: null })).owned ? 'done' : 'failed' }) })
  await until(() => ran.length === 1)
  assert.deepEqual(ran, [`${next}@1`], 'the next scan is claimed immediately; the interrupted one is never run again')
  assert.deepEqual(w.scan(first), { status: 'failed', attempts: 1, error: 'accounting_uncertain' })
  w.raw.close()
})

test('#836 decision 2026-11-13: a graceful stop of a scan on its last attempt ends it at once as timeout; a scan with attempts left and no paid call in flight is still handed back; another process\'s attempt is never touched', async () => {
  const w = world()
  const last = await w.job(A), fresh = await w.job(B)
  const tokens = new Map<string, number>(), untrack: (() => void)[] = []
  await kickSharedScanQueue(w.deps(() => new Promise(() => {}), { track: (j, token) => { tokens.set(j.id, token); const u = trackInFlight(j as Job, token); untrack.push(u); return u } }))
  // `last` is on its final attempt
  w.raw.prepare('UPDATE scan_jobs SET attempts = ? WHERE id = ?').run(MAX_ATTEMPTS, last)
  for (const u of untrack) u()
  const u1 = trackInFlight({ id: last, attempts: MAX_ATTEMPTS } as Job, tokens.get(last)), u2 = trackInFlight({ id: fresh, attempts: 1 } as Job, tokens.get(fresh))
  assert.equal(requeueInFlightForShutdown(w.raw), 1, 'one scan handed back')
  assert.deepEqual(w.scan(fresh), { status: 'pending', attempts: 1, error: null }); assert.equal(w.item(fresh)!.status, 'pending')
  assert.deepEqual(w.scan(last), { status: 'failed', attempts: MAX_ATTEMPTS, error: 'timeout' }); assert.equal(w.item(last)!.status, 'done')
  u1(); u2()
  // an attempt this process no longer owns (re-claimed at a higher attempt, with a paid call in flight) is left alone
  const other = await w.job(A)
  w.raw.prepare("UPDATE scan_jobs SET status = 'running', attempts = 2, claimed_at = ? WHERE id = ?").run(nowS(), other)
  w.reserve(other, A, 2)
  const u3 = trackInFlight({ id: other, attempts: 1 } as Job)
  assert.equal(requeueInFlightForShutdown(w.raw), 0)
  assert.deepEqual(w.scan(other), { status: 'running', attempts: 2, error: null })
  u3()
  w.raw.close()
})
