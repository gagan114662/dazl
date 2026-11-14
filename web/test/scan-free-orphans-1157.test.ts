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
