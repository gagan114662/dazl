// #363 crash class: a scan that died after reserving a paid call but before settling it may have been billed by the vendor.
// Re-pending it would run (and bill) the same calls again. The stale reaper and the graceful-shutdown handoff now fail such
// a job closed ('accounting_uncertain', the owner starts a new scan on purpose); a job with nothing unsettled is retried as before.
// Both engines, synthetic tenant, no network.
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import * as S from '../lib/scan/store-db.ts'
import * as Legacy from '../lib/scan/store.ts'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { requeueInFlightForShutdown, trackInFlight } from '../lib/scan/runner.ts'

const A = 'a'.repeat(32), T0 = 1_800_000_000
async function stale(db: Parameters<typeof S.createJob>[0], attempts: number, calls: { attempt: number; status: string }[]) {
  const id = await S.createJob(db, A, { business_name: 'Biz', industry: 'software', location: 'Toronto' }, null, T0)
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = ?, claimed_at = ? WHERE id = ?", [attempts, T0, id])
  let n = 0
  for (const c of calls) await db.run('INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, created_at) VALUES (?, ?, ?, ?, ?, 0.01, ?, ?)', [`${id}-${n++}`, A, id, c.attempt, 'llm.anthropic', c.status, T0])
  return id
}
const row = (db: Parameters<typeof S.createJob>[0], id: string) => db.get<{ status: string; error: string | null }>('SELECT status, error FROM scan_jobs WHERE id = ?', [id])

bothEngines('stale reaper: an unsettled call of the current attempt fails the job closed; nothing unsettled retries as before', async ({ db }) => {
  await db.run("INSERT INTO users (id, email, password_hash, salt) VALUES (?, 'a@example.test', 'x', 'y') ON CONFLICT DO NOTHING", [A]).catch(() => {})
  const uncertain = await stale(db, 1, [{ attempt: 1, status: 'reserved' }])
  const settled = await stale(db, 1, [{ attempt: 1, status: 'settled' }, { attempt: 1, status: 'kept' }, { attempt: 1, status: 'refused' }])
  const earlier = await stale(db, 2, [{ attempt: 1, status: 'reserved' }]) // an earlier attempt's row was already reaped as uncertain or settled: not this attempt's
  const none = await stale(db, 1, [])
  const exhausted = await stale(db, 3, [])
  assert.equal(await S.reapStaleJobs(db, T0 + 10 * 3600), 5)
  assert.deepEqual(await row(db, uncertain), { status: 'failed', error: 'accounting_uncertain' })
  assert.deepEqual(await row(db, settled), { status: 'pending', error: null })
  assert.deepEqual(await row(db, earlier), { status: 'pending', error: null })
  assert.deepEqual(await row(db, none), { status: 'pending', error: null })
  assert.deepEqual(await row(db, exhausted), { status: 'failed', error: 'timeout' })
})

test_sync()
function test_sync() {
  // the synchronous store the app still calls, and the shutdown handoff, on SQLite
  const mk = () => { const db = new Database(':memory:'); migrateScan(db); return db }
  const job = (db: Database.Database, id: string, status: string) => {
    db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, attempts, claimed_at, created_at) VALUES (?, ?, 'Biz', 'software', 'Toronto', ?, 1, ?, ?)").run(id, A, status, Math.floor(Date.now() / 1000) - 10 * 3600, T0)
    return db
  }
  const call = (db: Database.Database, id: string, status: string) => db.prepare("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, created_at) VALUES (?, ?, ?, 1, 'llm.anthropic', 0.01, ?, ?)").run(`${id}-c`, A, id, status, T0)
  const st = (db: Database.Database, id: string) => db.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(id)
  import('node:test').then(({ test }) => {
    test('sync reaper: unsettled call fails closed, otherwise pending', () => {
      const db = mk(); job(db, 'u', 'running'); call(db, 'u', 'reserved'); job(db, 'k', 'running'); call(db, 'k', 'settled')
      Legacy.reapStaleJobs(db)
      assert.deepEqual(st(db, 'u'), { status: 'failed', error: 'accounting_uncertain' })
      assert.deepEqual(st(db, 'k'), { status: 'pending', error: null })
    })
    test('shutdown handoff: a job with an unsettled call is NOT re-pended (the lease reaper then fails it closed); others are', () => {
      const db = mk(); job(db, 'u', 'running'); call(db, 'u', 'reserved'); job(db, 'k', 'running'); call(db, 'k', 'settled')
      const ju = { id: 'u', attempts: 1 }, jk = { id: 'k', attempts: 1 }
      const offU = trackInFlight(ju as never), offK = trackInFlight(jk as never)
      try { requeueInFlightForShutdown(db) } finally { offU(); offK() }
      assert.equal((st(db, 'u') as { status: string }).status, 'running')
      assert.equal((st(db, 'k') as { status: string }).status, 'pending')
    })
  })
}
