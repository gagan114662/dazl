// #2020 gate G3 (lane C): the PAID path, pinned at the seams production reads.
// There is no Stripe usage-record / meter call anywhere in the codebase (no createUsageRecord): a paid scan is
// "metered" by the plan quota count over scan_jobs (lib/plans.ts SCANS_THIS_MONTH_SQL, read by /api/usage via
// readScanQuota and by the scan route via lib/billing/plans-sqlite.ts scansThisMonth/scanQuota). So exactly-once
// stands or falls on the job row: one row per job (id is the primary key), counted by a read that never writes.
// These tests assert the required properties at those reads, on both engines:
//   1. one paid job counts exactly once, at every point of its lifecycle, however often it is re-read or retried;
//   2. a genuine failure (any error but 'cancelled') does not consume paid usage;
//   3. the implemented rule for the other endings: a cancelled scan keeps its count, an empty completed scan
//      counts as the scan it was. (Whether the cancelled rule is stated on screen is a copy question, reported
//      on #2020 - it is not asserted here.)
// Amounts and counts use the real plan shape (free plan limit from PLAN_LIMITS); tenants are synthetic.
import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { readScanQuota, PLAN_LIMITS } from '../lib/plans.ts'
import { scansThisMonth, scanQuota } from '../lib/billing/plans-sqlite.ts'
import { sqliteDb } from '../lib/db/client.ts'
import type { Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { bothEngines } from './helpers/engines.ts'

// A fixed mid-month instant, so the month boundary can never flake the run.
const NOW = new Date(Date.UTC(2026, 10, 15, 12, 0, 0))
const NOW_S = Math.floor(NOW.getTime() / 1000)
const THIS_MONTH = NOW_S - 3600
const LAST_MONTH = Math.floor(Date.UTC(2026, 9, 31, 23, 0, 0) / 1000)

interface Seed { id: string; user: string; status: string; error?: string | null; funded?: string; at?: number; candidates?: number | null }
const seed = (db: Db, r: Seed) => db.run(
  'INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, error, funded_by, created_at, candidates) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  [r.id, r.user, 'Bakery', 'Food', 'Austin', r.status, r.error ?? null, r.funded ?? 'user', r.at ?? THIS_MONTH, r.candidates ?? null])

bothEngines('G3: a paid job is metered exactly once across its whole lifecycle', async ({ db }) => {
  await seed(db, { id: 'g3-life', user: 'g3-a', status: 'pending' })
  assert.equal((await readScanQuota(db, 'g3-a', NOW)).used, 1, 'a started scan holds its slot from the start')
  await db.run("UPDATE scan_jobs SET status = 'running' WHERE id = 'g3-life'")
  assert.equal((await readScanQuota(db, 'g3-a', NOW)).used, 1, 'claiming the job does not count it again')
  await db.run("UPDATE scan_jobs SET attempts = attempts + 1 WHERE id = 'g3-life'")
  assert.equal((await readScanQuota(db, 'g3-a', NOW)).used, 1, 'a retry of the same job (attempts + 1, same id) does not count it again')
  await db.run("UPDATE scan_jobs SET status = 'done' WHERE id = 'g3-life'")
  const q = await readScanQuota(db, 'g3-a', NOW)
  assert.equal(q.used, 1, 'settling the job does not count it again')
  assert.equal((await readScanQuota(db, 'g3-a', NOW)).used, 1, 're-reading the quota never moves it')
  assert.deepEqual({ plan: q.plan, limit: q.limit, allowed: q.allowed }, { plan: 'free', limit: PLAN_LIMITS.free.scansPerMonth, allowed: true })
})

bothEngines('G3: the job id is the idempotency key - the same job can never exist twice', async ({ db }) => {
  await seed(db, { id: 'g3-dupe', user: 'g3-a', status: 'done' })
  await assert.rejects(seed(db, { id: 'g3-dupe', user: 'g3-a', status: 'done' }), 'a second row with the same job id is refused by the primary key')
  assert.equal((await readScanQuota(db, 'g3-a', NOW)).used, 1)
  // Control: a genuinely different job is a second scan, so the count above is not vacuous.
  await seed(db, { id: 'g3-dupe-2', user: 'g3-a', status: 'done' })
  assert.equal((await readScanQuota(db, 'g3-a', NOW)).used, 2)
})

bothEngines('G3: genuine failures do not consume paid usage', async ({ db }) => {
  const errors = ['provider_rejected', 'accounting_uncertain', 'timeout', 'provider_error', null]
  for (const [i, error] of errors.entries()) await seed(db, { id: `g3-fail-${i}`, user: 'g3-a', status: 'failed', error })
  assert.equal((await readScanQuota(db, 'g3-a', NOW)).used, 0, 'failed scans give the slot back, whatever the failure')
})

bothEngines('G3: a cancelled paid scan keeps its monthly count (the implemented rule)', async ({ db }) => {
  await seed(db, { id: 'g3-cancel', user: 'g3-a', status: 'failed', error: 'cancelled' })
  assert.equal((await readScanQuota(db, 'g3-a', NOW)).used, 1, 'cancelled is the one failure that keeps the charge: provider work may already have run')
})

bothEngines('G3: an empty completed scan counts as the scan it was', async ({ db }) => {
  await seed(db, { id: 'g3-empty', user: 'g3-a', status: 'done', candidates: 0 })
  assert.equal((await readScanQuota(db, 'g3-a', NOW)).used, 1)
})

bothEngines('G3: trial-funded scans never touch the paid quota, and other tenants do not leak in', async ({ db }) => {
  await seed(db, { id: 'g3-trial', user: 'g3-a', status: 'done', funded: 'trial' })
  await seed(db, { id: 'g3-other-1', user: 'g3-b', status: 'done' })
  await seed(db, { id: 'g3-other-2', user: 'g3-b', status: 'done' })
  assert.equal((await readScanQuota(db, 'g3-a', NOW)).used, 0)
  assert.equal((await readScanQuota(db, 'g3-b', NOW)).used, 2, 'control: the other tenant sees its own two')
})

bothEngines('G3: only scans started this month count', async ({ db }) => {
  await seed(db, { id: 'g3-old', user: 'g3-a', status: 'done', at: LAST_MONTH })
  assert.equal((await readScanQuota(db, 'g3-a', NOW)).used, 0)
  await seed(db, { id: 'g3-new', user: 'g3-a', status: 'done', at: Math.floor(Date.UTC(2026, 10, 1, 0, 0, 1) / 1000) })
  assert.equal((await readScanQuota(db, 'g3-a', NOW)).used, 1)
})

bothEngines('G3: the free-plan quota gate closes exactly at the plan limit', async ({ db }) => {
  const limit = PLAN_LIMITS.free.scansPerMonth!
  for (let i = 0; i < limit - 1; i++) await seed(db, { id: `g3-q-${i}`, user: 'g3-a', status: 'done' })
  let q = await readScanQuota(db, 'g3-a', NOW)
  assert.deepEqual({ used: q.used, allowed: q.allowed }, { used: limit - 1, allowed: true })
  await seed(db, { id: 'g3-q-last', user: 'g3-a', status: 'done' })
  q = await readScanQuota(db, 'g3-a', NOW)
  assert.deepEqual({ used: q.used, allowed: q.allowed }, { used: limit, allowed: false }, 'at the limit the next paid scan is refused, not double-counted past it')
})

// The scan route reads the quota through the raw-handle twin (lib/billing/plans-sqlite.ts) while /api/usage reads
// it through the Db layer: the two readers must agree on every shape above, or the gate and the meter would differ.
test('G3: the raw-handle quota reader (scan route) and the Db reader (usage) agree', async () => {
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  try {
    await seed(db, { id: 'g3-p-done', user: 'g3-a', status: 'done' })
    await seed(db, { id: 'g3-p-run', user: 'g3-a', status: 'running' })
    await seed(db, { id: 'g3-p-fail', user: 'g3-a', status: 'failed', error: 'provider_rejected' })
    await seed(db, { id: 'g3-p-cancel', user: 'g3-a', status: 'failed', error: 'cancelled' })
    await seed(db, { id: 'g3-p-trial', user: 'g3-a', status: 'done', funded: 'trial' })
    await seed(db, { id: 'g3-p-old', user: 'g3-a', status: 'done', at: LAST_MONTH })
    const viaDb = await readScanQuota(db, 'g3-a', NOW)
    assert.equal(viaDb.used, 3, 'done + running + cancelled count; failed, trial and last month do not')
    assert.equal(scansThisMonth(raw, 'g3-a', NOW), viaDb.used)
    assert.deepEqual(scanQuota(raw, 'g3-a', NOW), { plan: viaDb.plan, used: viaDb.used, limit: viaDb.limit, allowed: viaDb.allowed })
  } finally { await db.close() }
})
