// Owner spend pools in the shared store (lib/llm/spend-pool.ts, #363), on both engines. Synthetic owners and amounts; no
// provider is called anywhere in this file.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bothEngines } from './helpers/engines.ts'
import { sharedPool, poolRows, periodOf, ownerLimits } from '../lib/llm/spend-pool.ts'
import { PooledGuard, SpendGuard, SpendRefused, reserveAllUsd, settleAll } from '../lib/llm/spend-guard.ts'
import { pgDb, sqliteDb, type Db } from '../lib/db/client.ts'
import { migrateScan } from '../lib/scan/store.ts'

const T0 = Date.UTC(2026, 9, 29, 12) / 1000 // 2026-10-29 12:00 UTC
const refused = (reason: string) => (e: unknown) => e instanceof SpendRefused && e.reason === reason
const reserved = async (db: Db, owner: string) => Object.fromEntries((await poolRows(db, owner)).map(r => [r.period, Math.round(r.reserved_usd * 1e6) / 1e6]))

bothEngines('a reservation fits or is refused whole; a refusal writes nothing; another owner is untouched', async ({ db }) => {
  const p = sharedPool(db, 'A', { day: 1 }, () => T0)
  for (let i = 0; i < 4; i++) await p.reserve(0.25)
  await assert.rejects(p.reserve(0.01), refused('over_limit'))
  assert.deepEqual(await reserved(db, 'A'), { 'd:2026-10-29': 1 })
  assert.equal((await poolRows(db, 'A'))[0].calls, 4, 'a refused reservation is not counted')
  await sharedPool(db, 'B', { day: 1 }, () => T0).reserve(0.5)
  assert.deepEqual(await reserved(db, 'B'), { 'd:2026-10-29': 0.5 })
  assert.deepEqual(await reserved(db, 'A'), { 'd:2026-10-29': 1 })
  // The next UTC day is a fresh day window.
  await sharedPool(db, 'A', { day: 1 }, () => T0 + 86400).reserve(0.5)
  assert.deepEqual(await reserved(db, 'A'), { 'd:2026-10-29': 1, 'd:2026-10-30': 0.5 })
})

bothEngines('day and month together: the month refuses even when the day fits, and then neither window is raised', async ({ db }) => {
  let now = T0
  const p = sharedPool(db, 'A', { day: 1, month: 1.5 }, () => now)
  await p.reserve(0.9)
  now = T0 + 86400
  await p.reserve(0.5)
  await assert.rejects(p.reserve(0.2), refused('over_limit'))
  assert.deepEqual(await reserved(db, 'A'), { 'd:2026-10-29': 0.9, 'd:2026-10-30': 0.5, 'm:2026-10': 1.4 })
  assert.deepEqual(periodOf('month', Date.UTC(2026, 10, 1) / 1000), 'm:2026-11')
})

bothEngines('a restart cannot reset the pool: a fresh pool object (a new process) sees what was reserved', async ({ db }) => {
  await sharedPool(db, 'A', { day: 1 }, () => T0).reserve(0.8)
  const afterRestart = sharedPool(db, 'A', { day: 1 }, () => T0 + 60)
  await assert.rejects(afterRestart.reserve(0.3), refused('over_limit'))
  await afterRestart.reserve(0.2)
})

bothEngines('settle moves the reservation to the reported cost, in the windows it was reserved in, never below zero', async ({ db }) => {
  const MIDNIGHT = Date.UTC(2026, 9, 30) / 1000
  let now = MIDNIGHT - 10 // 2026-10-29 23:59:50 UTC
  const p = sharedPool(db, 'A', { day: 1, month: 5 }, () => now)
  await p.reserve(0.6)
  now = MIDNIGHT + 10 // the call returns after midnight
  await p.settle(0.1 - 0.6, 0.1, MIDNIGHT - 10)
  const rows = Object.fromEntries((await poolRows(db, 'A')).map(r => [r.period, [Math.round(r.reserved_usd * 1e6) / 1e6, Math.round(r.reported_usd * 1e6) / 1e6]]))
  assert.deepEqual(rows, { 'd:2026-10-29': [0.1, 0.1], 'm:2026-10': [0.1, 0.1] }, 'settled on the reserving day; the reported figure kept apart')
  await p.settle(-5, null, MIDNIGHT - 10)
  assert.deepEqual(await reserved(db, 'A'), { 'd:2026-10-29': 0, 'm:2026-10': 0 })
})

bothEngines('fail closed: a store that cannot record the reservation refuses the call', async ({ db }) => {
  await db.run('DROP TABLE tenant_spend_pools')
  await assert.rejects(sharedPool(db, 'A', { day: 10 }, () => T0).reserve(0.1), refused('reservation_not_saved'))
})

bothEngines('all-or-nothing with the job guard: a pool refusal reserves nothing on the job; a job save failure releases the pool', async ({ db }) => {
  const pool = new PooledGuard(sharedPool(db, 'A', { day: 1 }, () => T0))
  const saved: number[] = []
  const job = new SpendGuard(10); job.persist = usd => { saved.push(usd) }
  await reserveAllUsd([job, pool], 0.7)
  await assert.rejects(reserveAllUsd([job, pool], 0.7), refused('over_limit'))
  assert.deepEqual(saved, [0.7], 'the job saved only the admitted reservation')
  assert.equal(job.reservedUsd, 0.7)
  const failing = new SpendGuard(10); failing.persist = () => { throw new SpendRefused('ownership_lost') }
  await assert.rejects(reserveAllUsd([failing, new PooledGuard(sharedPool(db, 'A', { day: 1 }, () => T0))], 0.2), refused('ownership_lost'))
  assert.deepEqual(await reserved(db, 'A'), { 'd:2026-10-29': 0.7 }, 'the pool reservation was released when the job could not save')
  await settleAll([job, pool], -0.5, 0.2)
  assert.deepEqual(await reserved(db, 'A'), { 'd:2026-10-29': 0.2 })
  assert.ok(Math.abs(job.reservedUsd - 0.2) < 1e-12)
})

test('[pg] two instances racing one owner: exactly the limit is admitted, across separate connection pools', { skip: !process.env.DAZL_TEST_PG_URL }, async () => {
  const { PG_URL, freshSchema } = await import('./helpers/pg-test.ts')
  const { runPgMigrations } = await import('../lib/db/migrate-pg.ts')
  const s = await freshSchema()
  const a = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 8 }), b = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 8 })
  try {
    await runPgMigrations(a.pool)
    const pa = sharedPool(a, 'A', { day: 10, month: 100 }, () => T0), pb = sharedPool(b, 'A', { day: 10, month: 100 }, () => T0)
    const results = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => (i % 2 ? pa : pb).reserve(0.5)))
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 20)
    assert.ok(results.filter(r => r.status === 'rejected').every(r => refused('over_limit')((r as PromiseRejectedResult).reason)))
    assert.deepEqual(await reserved(a, 'A'), { 'd:2026-10-29': 10, 'm:2026-10': 10 })
  } finally { await a.close(); await b.close(); await s.drop() }
})

test('[sqlite] two handles on one file racing one owner: exactly the limit is admitted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spend-pool-'))
  try {
    const f = join(dir, 'app.db')
    const h1 = new Database(f), h2 = new Database(f)
    h1.pragma('busy_timeout = 5000'); h2.pragma('busy_timeout = 5000')
    migrateScan(h1)
    const p1 = sharedPool(sqliteDb(h1), 'A', { day: 3 }, () => T0), p2 = sharedPool(sqliteDb(h2), 'A', { day: 3 }, () => T0)
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? p1 : p2).reserve(0.25)))
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 12)
    assert.deepEqual(await reserved(sqliteDb(h1), 'A'), { 'd:2026-10-29': 3 })
    h1.close(); h2.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('operator settings: day from DAZL_RUN_MAX_USD_USERS, month from DAZL_OWNER_MONTH_MAX_USD_USERS; malformed entries ignored', () => {
  const env = { DAZL_RUN_MAX_USD_USERS: 'A:2, B:abc', DAZL_OWNER_MONTH_MAX_USD_USERS: 'A:30,C:5' }
  assert.deepEqual(ownerLimits('A', env), { day: 2, month: 30 })
  assert.equal(ownerLimits('B', env), null)
  assert.deepEqual(ownerLimits('C', env), { day: null, month: 5 })
  assert.equal(ownerLimits('A2', env), null)
})
