// The real tick route (app/api/internal/tick/route.ts) and captured-trace retention (lib/evals/capture.ts
// purgeExpiredTraces), run by test/trace-purge-tick.test.ts through the tenant-route loader. PR #463 review: the tick must
// delete zero trace rows unless a retention policy was chosen - capture on (its retention, 14 days by default) or an explicit
// DAZL_TRACE_RETENTION_DAYS. Unset, off, or on with an invalid retention: nothing is deleted. Council review: at most
// PURGE_LIMIT (500) rows per tick, oldest first, under the tick lease's fence.
// The trace store is the shared Db layer: SQLite (the same connection as the raw handle, as in the app), or with
// TRACE_PURGE_TICK_ENGINE=pg a fresh Postgres schema with every PG migration (the scheduler's own rows stay on raw SQLite,
// as in the app before cutover). Every row here is synthetic; no tenant has autopilot, sequences, watches or monitors.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { getDb, pgDb, setDb, type Db } from '../../lib/db/client.ts'
import { runPgMigrations } from '../../lib/db/migrate-pg.ts'
import { PG_URL, freshSchema } from './pg-test.ts'
import { PURGE_LIMIT } from '../../lib/evals/capture.ts'
import { POST as tick } from '../../app/api/internal/tick/route.ts'

process.env.DAZL_ENV = 'staging'
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
process.env.AUTOPILOT_TICK_SECRET = 'test-tick-secret'
delete process.env.DAZL_TRACE_CAPTURE; delete process.env.DAZL_TRACE_RETENTION_DAYS; delete process.env.ACCOUNT_RETENTION_ENABLED

const raw = new Database(':memory:')
migrateAllSqlite(raw)
setScanDb(raw)
let drop: (() => Promise<void>) | null = null
if (process.env.TRACE_PURGE_TICK_ENGINE === 'pg') {
  if (!PG_URL) throw new Error('TRACE_PURGE_TICK_ENGINE=pg needs DAZL_TEST_PG_URL')
  const s = await freshSchema()
  const pg = pgDb({ connectionString: PG_URL, searchPath: s.schema })
  await runPgMigrations(pg.pool)
  setDb(pg)
  drop = async () => { await pg.close(); await s.drop() }
}
const shared: Db = await getDb()
after(async () => { await drop?.() })
console.log(`engine ${shared.kind}`)

const now = Math.floor(Date.now() / 1000), DAY = 86400
type Env = Record<string, string | undefined>
const withEnv = async <T,>(vars: Env, fn: () => Promise<T>): Promise<T> => {
  const saved: Env = Object.fromEntries(['DAZL_TRACE_CAPTURE', 'DAZL_TRACE_RETENTION_DAYS'].map(k => [k, process.env[k]]))
  for (const k of Object.keys(saved)) delete process.env[k]
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v
  try { return await fn() } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const INSERT = 'INSERT INTO scan_traces (id, tenant_id, job_id, attempt, created_at, bytes, trace) VALUES (?, ?, ?, 1, ?, 2, ?)'
// Five synthetic rows across three tenants: 20 days old (A, B), 13 days old (B), new (A), 400 days old (C).
const ROWS: [string, string, number][] = [['tenant-A', 'old-a', 20 * DAY], ['tenant-B', 'old-b', 20 * DAY], ['tenant-B', 'edge-b', 13 * DAY], ['tenant-A', 'new-a', 0], ['tenant-C', 'ancient-c', 400 * DAY]]
const seed = async () => {
  await shared.run('DELETE FROM scan_traces')
  for (const [tenant, job, ago] of ROWS) await shared.run(INSERT, [`${tenant}-${job}`, tenant, job, now - ago, '{}'])
}
const jobsLeft = async () => (await shared.all<{ job_id: string }>('SELECT job_id FROM scan_traces ORDER BY job_id')).map(r => r.job_id)
const count = async () => Number((await shared.get<{ n: number | string }>('SELECT count(*) AS n FROM scan_traces'))!.n)
const call = async () => (await tick(new NextRequest('http://localhost/api/internal/tick', { method: 'POST', headers: { authorization: 'Bearer test-tick-secret' } }))).json() as Promise<{ ok: boolean; traces_purged: number }>

test('tick: with capture unset, off, or on with an invalid retention, the tick deletes zero trace rows', async () => {
  const noPolicy: Env[] = [{}, { DAZL_TRACE_CAPTURE: '0' }, { DAZL_TRACE_CAPTURE: 'true' }, { DAZL_TRACE_CAPTURE: '1', DAZL_TRACE_RETENTION_DAYS: 'nonsense' }, { DAZL_TRACE_CAPTURE: '1', DAZL_TRACE_RETENTION_DAYS: '0' }, { DAZL_TRACE_CAPTURE: '1', DAZL_TRACE_RETENTION_DAYS: '366' }, { DAZL_TRACE_CAPTURE: '1', DAZL_TRACE_RETENTION_DAYS: '1e1' }, { DAZL_TRACE_RETENTION_DAYS: 'abc' }]
  for (const env of noPolicy) {
    await seed()
    const r = await withEnv(env, call)
    assert.equal(r.ok, true, JSON.stringify(env))
    assert.equal(r.traces_purged, 0, JSON.stringify(env))
    assert.deepEqual(await jobsLeft(), ['ancient-c', 'edge-b', 'new-a', 'old-a', 'old-b'], JSON.stringify(env))
  }
})

test('tick: capture on purges every tenant\'s rows past the retention (default 14, then an explicit 7); an explicit retention with capture off purges too; a second tick is idempotent', async () => {
  await seed()
  const r1 = await withEnv({ DAZL_TRACE_CAPTURE: '1' }, call)
  assert.deepEqual([r1.ok, r1.traces_purged], [true, 3]); assert.deepEqual(await jobsLeft(), ['edge-b', 'new-a'])
  await seed()
  const r2 = await withEnv({ DAZL_TRACE_CAPTURE: '1', DAZL_TRACE_RETENTION_DAYS: '7' }, call)
  assert.deepEqual([r2.ok, r2.traces_purged], [true, 4]); assert.deepEqual(await jobsLeft(), ['new-a'])
  await seed()
  const r3 = await withEnv({ DAZL_TRACE_RETENTION_DAYS: '7' }, call)
  assert.deepEqual([r3.ok, r3.traces_purged], [true, 4]); assert.deepEqual(await jobsLeft(), ['new-a'])
  const r4 = await withEnv({ DAZL_TRACE_RETENTION_DAYS: '7' }, call)
  assert.deepEqual([r4.ok, r4.traces_purged], [true, 0]); assert.deepEqual(await jobsLeft(), ['new-a'])
  // and turning the policy off again after a purge deletes nothing more
  await seed()
  assert.equal((await withEnv({}, call)).traces_purged, 0); assert.equal(await count(), 5)
})

test('tick: the purge is bounded to PURGE_LIMIT rows per tick, oldest first: 1200 expired rows go 500/500/200/0 across ticks; a fresh row survives', async () => {
  assert.equal(PURGE_LIMIT, 500)
  await shared.run('DELETE FROM scan_traces')
  await shared.tx(function* (t) {
    for (let i = 0; i < 1200; i++) yield* t.run(INSERT, [`e${i}`, `tenant-${i % 3}`, `job-${i}`, now - 20 * DAY - i, '{}'])
    yield* t.run(INSERT, ['fresh', 'tenant-0', 'fresh', now, '{}'])
  })
  const purged: number[] = []
  for (let i = 0; i < 4; i++) purged.push((await withEnv({ DAZL_TRACE_CAPTURE: '1' }, call)).traces_purged)
  assert.deepEqual(purged, [500, 500, 200, 0])
  assert.deepEqual(await jobsLeft(), ['fresh'])
})
