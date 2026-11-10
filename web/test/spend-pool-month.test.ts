// #847: the workspace MONTH budget is atomic and survives restarts and concurrent workers (lib/llm/spend-pool.ts, #363). The day-window race and
// restart cases are in spend-pool.test.ts; the existing two-instance races there are bound by the DAY limit (the month is never the binding window), and
// the month's own restart / roll-over behaviour is only touched by one combined day+month case. These tests make the MONTH the window that decides,
// on both engines and across separate connections. They are a regression guard on code that already holds: no source file changes in this PR.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bothEngines } from './helpers/engines.ts'
import { sharedPool, poolRows } from '../lib/llm/spend-pool.ts'
import { SpendRefused } from '../lib/llm/spend-guard.ts'
import { pgDb, sqliteDb, type Db } from '../lib/db/client.ts'
import { migrateScan } from '../lib/scan/store.ts'

const DAY = 86400
const T0 = Date.UTC(2026, 9, 5, 12) / 1000 // 2026-10-05 12:00 UTC
const refused = (e: unknown) => e instanceof SpendRefused && e.reason === 'over_limit'
const rows = async (db: Db, owner: string) => Object.fromEntries((await poolRows(db, owner)).map(r => [r.period, Math.round(r.reserved_usd * 1e6) / 1e6]))

bothEngines('month limit: spread over several days the month refuses at its limit while every day is far under its own', async ({ db }) => {
  let now = T0
  const p = sharedPool(db, 'A', { day: 100, month: 2 }, () => now)
  for (let d = 0; d < 4; d++) { await p.reserve(0.5); now += DAY }   // 4 x 0.5 on four different days: the month is full, no day is
  await assert.rejects(p.reserve(0.01), refused)
  const got = await rows(db, 'A')
  assert.equal(got['m:2026-10'], 2); assert.ok(Object.entries(got).filter(([k]) => k.startsWith('d:')).every(([, v]) => v <= 0.5))
  assert.equal(Object.keys(got).filter(k => k.startsWith('d:')).length, 4, 'a refused reservation raised no window, not even a new day row\'s amount')
})

bothEngines('a restart cannot reset the month: a fresh pool object on a later day still sees what the month already holds', async ({ db }) => {
  await sharedPool(db, 'A', { day: 100, month: 1.5 }, () => T0).reserve(1.0)
  const afterRestart = sharedPool(db, 'A', { day: 100, month: 1.5 }, () => T0 + 9 * DAY)   // new process, nine days later, same month
  await assert.rejects(afterRestart.reserve(0.6), refused)
  await afterRestart.reserve(0.5)
  await assert.rejects(afterRestart.reserve(0.01), refused)
  assert.equal((await rows(db, 'A'))['m:2026-10'], 1.5)
})

bothEngines('the month turns at UTC midnight on the 1st: the next month is a fresh window, the old one is untouched, and the month limit applies afresh', async ({ db }) => {
  const LAST = Date.UTC(2026, 9, 31, 23, 59, 50) / 1000, FIRST = LAST + 20   // 2026-10-31 23:59:50 -> 2026-11-01 00:00:10
  await sharedPool(db, 'A', { month: 1 }, () => LAST).reserve(1)
  await assert.rejects(sharedPool(db, 'A', { month: 1 }, () => LAST + 5).reserve(0.01), refused)
  await sharedPool(db, 'A', { month: 1 }, () => FIRST).reserve(1)
  await assert.rejects(sharedPool(db, 'A', { month: 1 }, () => FIRST).reserve(0.01), refused)
  assert.deepEqual(await rows(db, 'A'), { 'm:2026-10': 1, 'm:2026-11': 1 })
})

bothEngines('the month is per owner, and an owner with no month limit is not stopped by another owner\'s full month', async ({ db }) => {
  await sharedPool(db, 'A', { month: 1 }, () => T0).reserve(1)
  await assert.rejects(sharedPool(db, 'A', { month: 1 }, () => T0).reserve(0.01), refused)
  await sharedPool(db, 'B', { month: 1 }, () => T0).reserve(1)
  await sharedPool(db, 'C', { day: 5 }, () => T0).reserve(3)
  assert.equal((await rows(db, 'C'))['m:2026-10'], undefined, 'no month limit configured: no month row is written or checked')
})

test('[sqlite] two handles on one file racing one owner, MONTH-bound: exactly the month limit is admitted across different days', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spend-pool-month-'))
  try {
    const f = join(dir, 'app.db')
    const h1 = new Database(f), h2 = new Database(f)
    h1.pragma('busy_timeout = 5000'); h2.pragma('busy_timeout = 5000')
    migrateScan(h1)
    // Each reservation lands on one of 10 different days (a day limit of 100 never binds); the month limit of 3 does.
    const at = (i: number) => sharedPool(sqliteDb(i % 2 ? h1 : h2), 'A', { day: 100, month: 3 }, () => T0 + (i % 10) * DAY)
    const results = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => at(i).reserve(0.25)))
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 12)
    assert.ok(results.filter(r => r.status === 'rejected').every(r => refused((r as PromiseRejectedResult).reason)))
    assert.equal((await rows(sqliteDb(h1), 'A'))['m:2026-10'], 3)
    h1.close(); h2.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('[pg] two instances racing one owner, MONTH-bound: exactly the month limit is admitted across separate connection pools', { skip: !process.env.DAZL_TEST_PG_URL }, async () => {
  const { PG_URL, freshSchema } = await import('./helpers/pg-test.ts')
  const { runPgMigrations } = await import('../lib/db/migrate-pg.ts')
  const s = await freshSchema()
  const a = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 8 }), b = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 8 })
  try {
    await runPgMigrations(a.pool)
    const at = (i: number) => sharedPool(i % 2 ? a : b, 'A', { day: 100, month: 10 }, () => T0 + (i % 12) * DAY)
    const results = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => at(i).reserve(0.5)))
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 20)
    assert.ok(results.filter(r => r.status === 'rejected').every(r => refused((r as PromiseRejectedResult).reason)))
    assert.equal((await rows(a, 'A'))['m:2026-10'], 10)
  } finally { await a.close(); await b.close(); await s.drop() }
})
