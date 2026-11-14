// #1157: a scan whose attempt is gone (a restart, a crash, an expired lease) while a FREE TinyFish call (priced US$0 inside its free
// allowance) is still 'reserved' used to end 'failed accounting_uncertain' ("a paid step may already have been billed") and
// discard everything it found: Hermes's Bangalore matrix scan sat 'running' for 20 minutes and then failed that way. Nothing
// billable was in flight, so the orphaned row is settled at $0 and the scan is treated as any interrupted one. Reproduced on
// real data first (a real Bangalore scan killed while a US$0 tinyfish.fetch was reserved). A PRICED reserved call, and any
// other kind of call, still end the scan closed: that is the double-bill guard and it is unchanged.
// Both engines for the Db-layer reapers; SQLite for the synchronous store, the queue runner and the shutdown handoff.
import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { bothEngines } from './helpers/engines.ts'
import * as S from '../lib/scan/store-db.ts'
import { reapStaleScans } from '../lib/queue/scan-claimer.ts'
import * as Legacy from '../lib/scan/store.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { requeueInFlightForShutdown, trackInFlight } from '../lib/scan/runner.ts'

const A = 'a'.repeat(32), B = 'b'.repeat(32), T0 = 1_800_000_000
type Call = { kind: string; reserve: number; status?: string; attempt?: number }
const FREE_FETCH: Call = { kind: 'tinyfish.fetch', reserve: 0 }
const FREE_SEARCH: Call = { kind: 'tinyfish.search', reserve: 0 }
const MODEL: Call = { kind: 'llm.anthropic', reserve: 0.01 }
const PRICED_TF: Call = { kind: 'tinyfish.fetch', reserve: 0.002 } // outside the free allowance: it has a price
const FREE_OTHER: Call = { kind: 'apollo.lookup', reserve: 0 }   // not a TinyFish call: the free rule does not cover it

async function stale(db: Parameters<typeof S.createJob>[0], tenant: string, attempts: number, calls: Call[], claimedAt = T0) {
  const id = await S.createJob(db, tenant, { business_name: 'Biz', industry: 'manufacturing', location: 'Bangalore' }, null, T0)
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = ?, claimed_at = ? WHERE id = ?", [attempts, claimedAt, id])
  let n = 0
  for (const c of calls) await db.run('INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [`${id}-${n++}`, tenant, id, c.attempt ?? attempts, c.kind, c.reserve, c.status ?? 'reserved', T0])
  return id
}
const row = (db: Parameters<typeof S.createJob>[0], id: string) => db.get<{ status: string; error: string | null }>('SELECT status, error FROM scan_jobs WHERE id = ?', [id])
const spend = (db: Parameters<typeof S.createJob>[0], id: string) => db.all<{ kind: string; status: string; actual_usd: number | null; reason: string | null }>('SELECT kind, status, actual_usd, reason FROM scan_spend_calls WHERE scan_job_id = ? ORDER BY id', [id])
const seedUsers = async (db: Parameters<typeof S.createJob>[0]) => { for (const u of [A, B]) await db.run("INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, 'x', 'y') ON CONFLICT DO NOTHING", [u, `${u.slice(0, 1)}@example.test`]).catch(() => {}) }

bothEngines('stale reaper: a free TinyFish call left reserved is settled at $0 and the scan goes back to pending; a priced, model or non-TinyFish call still ends it closed', async ({ db }) => {
  await seedUsers(db)
  const free = await stale(db, A, 1, [{ kind: 'llm.anthropic', reserve: 0.01, status: 'settled' }, FREE_SEARCH, FREE_FETCH])
  const freeLast = await stale(db, A, 3, [FREE_FETCH]) // last attempt: ends 'timeout' (the ordinary rule), not accounting_uncertain
  const model = await stale(db, A, 1, [MODEL, FREE_FETCH]) // a priced call beside the free one: the whole scan stays closed
  const priced = await stale(db, A, 1, [PRICED_TF])
  const other = await stale(db, A, 1, [FREE_OTHER])
  const fresh = await stale(db, A, 1, [FREE_FETCH], T0 + 10 * 3600 - 5) // a live attempt (claim 5 s old): nothing of it is touched
  const otherTenant = await stale(db, B, 1, [FREE_FETCH])
  await S.reapStaleJobs(db, T0 + 10 * 3600)
  assert.deepEqual(await row(db, free), { status: 'pending', error: null })
  assert.deepEqual(await spend(db, free), [
    { kind: 'llm.anthropic', status: 'settled', actual_usd: null, reason: null },
    { kind: 'tinyfish.search', status: 'settled', actual_usd: 0, reason: 'interrupted_free' },
    { kind: 'tinyfish.fetch', status: 'settled', actual_usd: 0, reason: 'interrupted_free' },
  ])
  assert.deepEqual(await row(db, freeLast), { status: 'failed', error: 'timeout' })
  assert.deepEqual(await row(db, model), { status: 'failed', error: 'accounting_uncertain' })
  assert.deepEqual((await spend(db, model)).map(r => [r.kind, r.status]), [['llm.anthropic', 'reserved'], ['tinyfish.fetch', 'settled']], 'the priced call stays reserved (the scan stays closed); only the free row is settled, at $0')
  assert.deepEqual(await row(db, priced), { status: 'failed', error: 'accounting_uncertain' })
  assert.deepEqual(await row(db, other), { status: 'failed', error: 'accounting_uncertain' })
  assert.deepEqual(await row(db, fresh), { status: 'running', error: null })
  assert.equal((await spend(db, fresh))[0].status, 'reserved', 'a live attempt keeps its reservation')
  assert.deepEqual(await row(db, otherTenant), { status: 'pending', error: null }, 'the reaper is not tenant-scoped, as before: a stale scan of any tenant is handled')
})

bothEngines('queue-mode scan reaper (scan-claimer): the same free-call rule as the legacy reaper', async ({ db }) => {
  await seedUsers(db)
  const free = await stale(db, A, 1, [FREE_FETCH])
  const priced = await stale(db, A, 1, [MODEL])
  await reapStaleScans(db, 60, T0 + 3600)
  assert.deepEqual(await row(db, free), { status: 'pending', error: null })
  assert.deepEqual(await row(db, priced), { status: 'failed', error: 'accounting_uncertain' })
})

test('sync reaper, queue runner bind and shutdown handoff (SQLite): a free reserved call is settled, a priced one is not', () => {
  const mk = () => { const db = new Database(':memory:'); migrateScan(db); return db }
  const job = (db: Database.Database, id: string, claimedAt = T0) => db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, attempts, claimed_at, created_at) VALUES (?, ?, 'Biz', 'manufacturing', 'Bangalore', 'running', 1, ?, ?)").run(id, A, claimedAt, T0)
  const call = (db: Database.Database, id: string, c: Call) => db.prepare("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, created_at) VALUES (?, ?, ?, 1, ?, ?, 'reserved', ?)").run(`${id}-c-${c.kind}`, A, id, c.kind, c.reserve, T0)
  const st = (db: Database.Database, id: string) => db.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(id)
  const rows = (db: Database.Database, id: string) => db.prepare('SELECT status, actual_usd, reason FROM scan_spend_calls WHERE scan_job_id = ?').all(id)

  // 1. the synchronous reaper the app still calls on reads (it reads the wall clock: claims from 1970-era T0 are stale)
  const r = mk(); job(r, 'free', 1); call(r, 'free', FREE_FETCH); job(r, 'paid', 1); call(r, 'paid', MODEL)
  Legacy.reapStaleRunningJobs(r)
  assert.deepEqual(st(r, 'free'), { status: 'pending', error: null })
  assert.deepEqual(rows(r, 'free'), [{ status: 'settled', actual_usd: 0, reason: 'interrupted_free' }])
  assert.deepEqual(st(r, 'paid'), { status: 'failed', error: 'accounting_uncertain' })

  // 2. the graceful-shutdown handoff (a restart/deploy): THE restart case. A free call in flight no longer ends the scan.
  const h = mk(); const now = Math.floor(Date.now() / 1000)
  job(h, 'free', now); call(h, 'free', FREE_FETCH); job(h, 'paid', now); call(h, 'paid', MODEL)
  const jobs = ['free', 'paid'].map(id => ({ id, user_id: A, attempts: 1 }) as never)
  const untracks = jobs.map(j => trackInFlight(j))
  requeueInFlightForShutdown(h)
  untracks.forEach(u => u())
  assert.deepEqual(st(h, 'free'), { status: 'pending', error: null }, 'restart with a free call in flight: the scan goes back to pending and is claimed again at once')
  assert.deepEqual(rows(h, 'free'), [{ status: 'settled', actual_usd: 0, reason: 'interrupted_free' }])
  assert.deepEqual(st(h, 'paid'), { status: 'failed', error: 'accounting_uncertain' }, 'a priced call in flight still ends it closed')
})

test('#1157 the default stale-scan window is one paid call plus a margin (about 3 minutes), not 20; the env override still works and never goes below the floor', () => {
  assert.equal(Legacy.MIN_STALE_RUNNING_S, Math.ceil(Legacy.MAX_PAID_CALL_MS / 1000) + 45)
  assert.equal(Legacy.staleRunningSeconds({}), Legacy.MIN_STALE_RUNNING_S)
  assert.ok(Legacy.MIN_STALE_RUNNING_S < 5 * 60, 'a scan whose process died ends well inside 5 minutes')
  assert.ok(Legacy.MIN_STALE_RUNNING_S > Legacy.MAX_PAID_CALL_MS / 1000, 'and still outlives the longest single paid call')
  assert.equal(Legacy.staleRunningSeconds({ SCAN_STALE_RUNNING_S: '1200' }), 1200, 'the old 20 minutes is one env var away')
  assert.equal(Legacy.staleRunningSeconds({ SCAN_STALE_RUNNING_S: '10' }), Legacy.MIN_STALE_RUNNING_S, 'below the floor is clamped up')
})

bothEngines('#1157 a scan whose process died is reaped just past the window and not before it (a live call is never reaped)', async ({ db }) => {
  await seedUsers(db)
  const now = T0 + 5000
  const inside = await stale(db, A, 1, [FREE_FETCH], now - Legacy.STALE_RUNNING_S + 5)
  const past = await stale(db, A, 1, [FREE_FETCH], now - Legacy.STALE_RUNNING_S - 5)
  await S.reapStaleJobs(db, now)
  assert.deepEqual(await row(db, inside), { status: 'running', error: null })
  assert.deepEqual(await row(db, past), { status: 'pending', error: null })
})

// ---- review round 1 -------------------------------------------------------------------------------------------------------
import { migrateScanSpendCap, runWithScanSpend, scanCapConfig, scanSpendCalls, spendAttemptUncertain } from '../lib/scan/spend-cap.ts'
import { migrateKeys } from '../lib/llm/key-store.ts'
import { kickQueueRunner, type ScanExecutor } from '../lib/scan/queue-runner.ts'
import { migrateTinyfish, tfSearch, resetTinyfishState } from '../lib/search/tinyfish.ts'
import { createJob as createJobSync, createQueryJob } from '../lib/scan/store.ts'
const MARKED: Call = { kind: 'tinyfish.search', reserve: 0 } // + reason 'maybe_billed': a free call the live attempt flagged (a 402)

test('#1157 a free call answered 402 leaves a DURABLE maybe-billed mark, so a later reaper does not settle it as free', async () => {
  resetTinyfishState()
  const db = new Database(':memory:'); migrateScan(db); migrateTinyfish(db)
  const id = createQueryJob(db, 'A', { query: 'free 402' })
  db.prepare("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = 1 WHERE id = ?").run(id)
  const f = (async () => new Response('{}', { status: 402 })) as unknown as typeof fetch
  const uncertain = await runWithScanSpend({ db, jobId: id, tenantId: 'A', attempt: 1, cap: scanCapConfig({}), accountLimits: null, clock: () => T0 }, async () => { await tfSearch(db, 'A', 'q', {}, { searches: 0 }, { env: { TINYFISH_API_KEY: 'k' }, fetchImpl: f, now: T0 }); return spendAttemptUncertain() })
  assert.equal(uncertain, true)
  const calls = await scanSpendCalls(db, id, 'A')
  assert.deepEqual(calls.map(c => [c.kind, c.status, c.reserve_usd]), [['tinyfish.search', 'reserved', 0]])
  assert.equal((db.prepare('SELECT reason FROM scan_spend_calls WHERE scan_job_id = ?').get(id) as { reason: string | null }).reason, 'maybe_billed')
  // the process dies here; the reaper finds the scan stale: it must end closed, not be re-queued
  db.prepare('UPDATE scan_jobs SET claimed_at = 1 WHERE id = ?').run(id)
  Legacy.reapStaleRunningJobs(db)
  assert.deepEqual(db.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(id), { status: 'failed', error: 'accounting_uncertain' })
})

bothEngines('#1157 a free row marked maybe_billed stays reserved and ends the scan closed in the Db reaper and the queue-mode reaper', async ({ db }) => {
  await seedUsers(db)
  const mark = async (id: string) => db.run("UPDATE scan_spend_calls SET reason = 'maybe_billed' WHERE scan_job_id = ?", [id])
  const a = await stale(db, A, 1, [MARKED]); await mark(a)
  await S.reapStaleJobs(db, T0 + 10 * 3600)
  assert.deepEqual(await row(db, a), { status: 'failed', error: 'accounting_uncertain' })
  assert.equal((await spend(db, a))[0].status, 'reserved')
  const c = await stale(db, A, 1, [MARKED]); await mark(c)
  await reapStaleScans(db, 60, T0 + 3600)
  assert.deepEqual(await row(db, c), { status: 'failed', error: 'accounting_uncertain' })
})

test('#1157 shutdown hand-back: a free row marked maybe_billed still ends the scan closed', () => {
  const h = new Database(':memory:'); migrateScan(h); const now = Math.floor(Date.now() / 1000)
  h.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, attempts, claimed_at, created_at) VALUES ('m', ?, 'Biz', 'manufacturing', 'Bangalore', 'running', 1, ?, ?)").run(A, now, T0)
  h.prepare("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, reason, created_at) VALUES ('m-c', ?, 'm', 1, 'tinyfish.search', 0, 'reserved', 'maybe_billed', ?)").run(A, T0)
  const untrack = trackInFlight({ id: 'm', user_id: A, attempts: 1 } as never)
  requeueInFlightForShutdown(h); untrack()
  assert.deepEqual(h.prepare("SELECT status, error FROM scan_jobs WHERE id = 'm'").get(), { status: 'failed', error: 'accounting_uncertain' })
})

// the SQLite queue runner binds a stale running scan itself (it never calls the reaper): SETTLE_FREE_ORPHANS_BIND_SQL
function queueSetup() {
  const db = new Database(':memory:'); migrateScan(db); migrateScanSpendCap(db); migrateKeys(db)
  const id = createJobSync(db, 'A', { business_name: 'Biz', industry: 'manufacturing', location: 'Bangalore' })
  db.prepare("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ?, funded_by = 'trial' WHERE id = ?").run(Math.floor(Date.now() / 1000) - 100000, id)
  const call = (job: string, tenant: string, kind: string, usd: number, reason: string | null = null) => db.prepare("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, reason, created_at) VALUES (?, ?, ?, 1, ?, ?, 'reserved', ?, 1)").run(`${job}-${kind}-${usd}`, tenant, job, kind, usd, reason)
  return { db, id, call }
}
const st = (db: Database.Database, id: string) => db.prepare('SELECT status, error, attempts FROM scan_jobs WHERE id = ?').get(id)
const neverRun: ScanExecutor = async () => { throw new Error('executor must not run: a possibly-billed attempt is never re-run') }

test('#1157 queue-runner bind: a stale scan with a free call reserved is bound and re-run (row settled); another scan is untouched', async () => {
  const { db, id, call } = queueSetup(); call(id, 'A', 'tinyfish.fetch', 0)
  // tenant B's LIVE scan (claimed now) with its own free call in flight: the bind of A's scan must not settle it
  const other = createJobSync(db, 'B', { business_name: 'Other', industry: 'software', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ?, funded_by = 'trial' WHERE id = ?").run(Math.floor(Date.now() / 1000), other)
  call(other, 'B', 'tinyfish.fetch', 0)
  let ran = 0
  const run: ScanExecutor = async (d, job) => { ran++; d.prepare("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), job.id); return 'done' }
  await kickQueueRunner(db, {} as never, run, { leaseSeconds: 1000 })
  assert.equal(ran, 1, 'the scan was bound and ran again')
  assert.deepEqual(st(db, id), { status: 'done', error: null, attempts: 2 })
  assert.deepEqual(db.prepare('SELECT status, actual_usd, reason FROM scan_spend_calls WHERE scan_job_id = ?').get(id), { status: 'settled', actual_usd: 0, reason: 'interrupted_free' })
  assert.deepEqual(db.prepare('SELECT status, reason FROM scan_spend_calls WHERE scan_job_id = ?').get(other), { status: 'reserved', reason: null }, "another tenant's live call is untouched")
  assert.deepEqual(st(db, other), { status: 'running', error: null, attempts: 1 })
})
for (const [name, kind, usd, reason] of [['a priced TinyFish call', 'tinyfish.fetch', 0.002, null], ['a model call beside it', 'llm.anthropic', 0.05, null], ['a free call marked maybe_billed', 'tinyfish.search', 0, 'maybe_billed']] as const) {
  test(`#1157 queue-runner bind: ${name} still ends the scan accounting_uncertain, never re-run`, async () => {
    const { db, id, call } = queueSetup(); call(id, 'A', kind, usd, reason)
    if (kind === 'llm.anthropic') call(id, 'A', 'tinyfish.fetch', 0) // the free row beside a priced one does not open the scan
    await kickQueueRunner(db, {} as never, neverRun, { leaseSeconds: 1000 })
    assert.deepEqual(st(db, id), { status: 'failed', error: 'accounting_uncertain', attempts: 1 })
  })
}

test('#1157 Postgres read-path reaper (pg-mem): a free call reserved is settled and the scan re-queued; a priced or marked one ends it closed', async () => {
  const { newDb, DataType } = await import('pg-mem')
  const { readFileSync } = await import('node:fs')
  const mem = newDb()
  mem.public.registerFunction({ name: 'char_length', args: [DataType.text], returns: DataType.integer, implementation: (x: string) => x.length, impure: false })
  mem.public.registerFunction({ name: 'btrim', args: [DataType.text], returns: DataType.text, implementation: (x: string) => x.trim(), impure: false })
  mem.public.registerFunction({ name: 'floor', args: [DataType.float], returns: DataType.float, implementation: (x: number) => Math.floor(x), impure: false })
  mem.public.none(readFileSync(new URL('../scripts/pg-migrate/schema.sql', import.meta.url), 'utf8'))
  const { Pool } = mem.adapters.createPg(); const pool = new Pool()
  const { pgLeadsRead } = await import('../lib/db/leads-read-pg.ts')
  const old = Math.floor(Date.now() / 1000) - 100000, fresh = Math.floor(Date.now() / 1000)
  const job = (id: string, claimed = old) => pool.query("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, created_at, attempts, claimed_at) VALUES ($1, 'u1', 'running', 'B', 'i', 'l', $2, 1, $3)", [id, old, claimed])
  const reserve = (id: string, kind: string, usd: number, reason: string | null = null) => pool.query("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, reason, created_at) VALUES ($1, 'u1', $2, 1, $3, $4, 'reserved', $5, 1)", [`c-${id}`, id, kind, usd, reason])
  await job('free'); await reserve('free', 'tinyfish.fetch', 0)
  await job('priced'); await reserve('priced', 'tinyfish.fetch', 0.002)
  await job('marked'); await reserve('marked', 'tinyfish.search', 0, 'maybe_billed')
  await job('live', fresh); await reserve('live', 'tinyfish.fetch', 0)
  const pg = pgLeadsRead(pool as never)
  await pg.getJob('u1', 'free')
  const s = async (id: string) => (await pool.query('SELECT status, error FROM scan_jobs WHERE id = $1', [id])).rows[0]
  const c = async (id: string) => (await pool.query('SELECT status, reason FROM scan_spend_calls WHERE scan_job_id = $1', [id])).rows[0]
  assert.deepEqual(await s('free'), { status: 'pending', error: null })
  assert.deepEqual(await c('free'), { status: 'settled', reason: 'interrupted_free' })
  assert.deepEqual(await s('priced'), { status: 'failed', error: 'accounting_uncertain' })
  assert.deepEqual(await s('marked'), { status: 'failed', error: 'accounting_uncertain' })
  assert.deepEqual(await c('marked'), { status: 'reserved', reason: 'maybe_billed' })
  assert.deepEqual(await s('live'), { status: 'running', error: null })
  assert.deepEqual(await c('live'), { status: 'reserved', reason: null }, 'a live attempt keeps its reservation')
})
