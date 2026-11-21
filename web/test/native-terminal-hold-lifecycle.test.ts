import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { markCompanyFirstBudget } from '../lib/company-first/product-discovery.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { PooledGuard, SpendGuard, reserveAllUsd, settleAll } from '../lib/llm/spend-guard.ts'
import { PENDING_STALE_S, poolRows, scanPoolRows, sharedPool } from '../lib/llm/spend-pool.ts'
import { estimateForBody } from '../lib/scan/estimate-request.ts'
import { reserveNativeSearch } from '../lib/scan/native-search-reserve.ts'
import { reapStaleRunningJobs } from '../lib/scan/store.ts'
import { qaClaudeOnlyBudget } from '../lib/scan/qa-provider-policy.ts'
import { reserveScanSpend, runWithScanSpend, scanCapConfig } from '../lib/scan/spend-cap.ts'

const NOW = 1_700_400_000
const FLOOR = 0.4
const LIMIT = 0.5
const owner = 'fixture-a'
const initial = 'old'
const ready = 'new'
const nativeBudget = JSON.stringify({ ...JSON.parse(qaClaudeOnlyBudget('{"first5":true}', true)), execution: 'local_once_v1' })

const companyFirstBudget = markCompanyFirstBudget('{"first5":true,"paid_fallback":false,"credit_enrichment":false}')

function fixture(booked = NOW, initialBudget = nativeBudget) {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  let now = booked
  const insert = (id: string, tenant: string, runBudget = nativeBudget) => db.prepare(
    "INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status,attempts,run_budget,query) VALUES (?,?,'Fixture','Test','Test','running',1,?,'Find example companies')"
  ).run(id, tenant, runBudget)
  insert(initial, owner, initialBudget); insert(ready, owner); insert('other', 'fixture-b')
  const pool = (id: string | undefined, tenant = owner) => sharedPool(db, tenant, { day: LIMIT, month: LIMIT }, () => now, 0, id)
  const inJob = <T>(id: string, tenant: string, fn: () => Promise<T>) => runWithScanSpend({
    db, jobId: id, tenantId: tenant, attempt: 1, claudeOnly: true,
    cap: scanCapConfig({}), requestMaxUsd: 1, accountLimits: null, clock: () => now,
  }, fn)
  const reserve = (id: string, usd: number, tenant = owner, transportAt?: number) => inJob(id, tenant, () => {
    const guard = new SpendGuard(1)
    guard.persist = next => { db.prepare('UPDATE scan_jobs SET spend_reserved_usd=? WHERE id=? AND user_id=?').run(next, id, tenant) }
    let checks = 0
    return reserveNativeSearch([guard, new PooledGuard(pool(id, tenant))], usd, () => {
      if (++checks === 2 && transportAt !== undefined) now = transportAt
    })
  })
  const estimate = () => estimateForBody({ query: 'Find example companies' }, { db: sqliteDb(db), tenantId: owner, hasOwnKey: true, model: 'claude-sonnet-4-5', enrichmentVendors: [] })
  const expireAt = booked + PENDING_STALE_S + 2
  const fail = (id = initial, finished = booked + 2) => db.prepare(
    "UPDATE scan_jobs SET status='failed', error='accounting_uncertain', claimed_at=NULL, finished_at=? WHERE id=?"
  ).run(finished, id)
  const holdRows = () => poolRows(db, owner)
  const pending = async () => (await scanPoolRows(db, owner, now)).filter(r => r.period.startsWith('p:'))
  const call = () => db.prepare("SELECT id, status, reserve_usd, actual_usd FROM scan_spend_calls WHERE scan_job_id=? AND kind='llm.anthropic.web_search' AND status='reserved'").get(initial) as { id: string; status: string; reserve_usd: number; actual_usd: number | null }
  return { db, pool, reserve, fail, pending, call, holdRows, estimate, inJob, expireAt, time: (n: number) => { now = n } }
}

for (const [lane, budget] of [['pinned QA', nativeBudget], ['ordinary Company First', companyFirstBudget]] as const) {
test(`identified expired terminal native hold permits a distinct scan, not replay or releasing any dollars (${lane})`, async () => {
  const x = fixture(NOW, budget)
  try {
    const h = await x.reserve(initial, FLOOR)
    assert.match(x.call().id, /^n[0-9a-z]{9}$/)
    assert.equal((await x.pending())[0]?.period, 'p:' + x.call().id)
    await h.uncertain()
    x.time(x.expireAt)
    assert.equal((await x.pending()).length, 1, 'still active even if its marker was failed and its call is old')
    await assert.rejects(x.reserve(ready, 0.05), { reason: 'accounting_unsettled' })
    await (await x.reserve('other', 0.05, 'fixture-b')).settle(0.02)

    x.fail()
    x.time(x.expireAt - 1)
    assert.equal((await x.pending()).length, 1, 'terminal grace period still open')
    await assert.rejects(x.reserve(ready, 0.05), { reason: 'accounting_unsettled' })
    x.time(x.expireAt)
    assert.deepEqual(await x.pending(), [])
    const preview = await x.estimate(); assert.ok(preview.ok); assert.notEqual(preview.estimate.verdict.reason, 'accounting_unsettled')
    await assert.rejects(x.pool(initial).reserve(0.05), { reason: 'accounting_unsettled' })
    await assert.rejects(x.pool(undefined).reserve(0.05), { reason: 'accounting_unsettled' }, 'non-scan path remains fenced')
    await assert.rejects(x.inJob(initial, owner, () => reserveScanSpend('llm.anthropic.web_search', () => 0.05)), { reason: 'native_search_accounting_pending' })
    await assert.rejects(x.reserve(ready, 0.2), { reason: 'over_limit' }, 'the full old charge still binds the new spend')
    const original = (await x.holdRows()).map(r => [r.period, r.reserved_usd, r.reported_usd])
    assert.deepEqual(original.map(r => r.slice(1)), [[FLOOR, 0], [FLOOR, 0], [FLOOR, 0]])
    const next = await x.reserve(ready, 0.05)
    // This independent guard would fit financially; the live new marker must still serialize calls.
    await assert.rejects(x.pool('yet-another').reserve(0.02), { reason: 'busy' })
    await next.settle(0.02)
    const rows = await x.holdRows()
    assert.deepEqual(rows.filter(r => r.period.startsWith('p:')).map(r => [r.period, r.reserved_usd, r.reported_usd]), [['p:' + x.call().id, FLOOR, 0]])
    for (const p of rows.filter(r => !r.period.startsWith('p:'))) {
      assert.ok(Math.abs(p.reserved_usd - 0.42) < 1e-9)
      assert.equal(p.reported_usd, 0.02)
    }
    assert.deepEqual([x.call().status, x.call().reserve_usd, x.call().actual_usd], ['reserved', FLOOR, null])
    assert.deepEqual(x.db.prepare('SELECT spend_reserved_usd,spend_cap_reserved_usd FROM scan_jobs WHERE id=?').get(initial), { spend_reserved_usd: FLOOR, spend_cap_reserved_usd: FLOOR })
  } finally { x.db.close() }
})

test(`unknown, cross-tenant, underfunded, fresh and legacy markers are never inferred from matching amounts (${lane})`, async () => {
  const x = fixture(NOW, budget)
  try {
    await (await x.reserve(initial, FLOOR)).uncertain()
    x.fail(); x.time(x.expireAt)
    const period = 'p:' + x.call().id
    const lose = x.db.prepare('UPDATE tenant_spend_pools SET period=? WHERE tenant_id=? AND period=?')
    const hold = x.db.prepare('UPDATE tenant_spend_pools SET reserved_usd=? WHERE tenant_id=? AND period LIKE ?')
    const ownerOf = x.db.prepare('UPDATE tenant_spend_pools SET tenant_id=? WHERE tenant_id=? AND period=?')
    const assertBlocked = async () => {
      assert.equal((await x.pending()).length, 1)
      await assert.rejects(x.reserve(ready, 0.05), { reason: 'accounting_unsettled' })
    }
    lose.run('p:deadbeef01', owner, period)
    await assertBlocked()
    const estimate = await x.estimate()
    assert.ok(estimate.ok)
    assert.equal(estimate.estimate.verdict.reason, 'accounting_unsettled')
    lose.run(period, owner, 'p:deadbeef01')
    if (lane === 'ordinary Company First') {
      // Even a reason string resembling a legacy seal cannot link a different typed marker.
      const mismatched = period === 'p:n123456789' ? 'p:n123456788' : 'p:n123456789'
      const setReason = x.db.prepare('UPDATE scan_spend_calls SET reason=? WHERE id=?')
      lose.run(mismatched, owner, period)
      setReason.run('native_legacy_link:' + mismatched, x.call().id)
      await assertBlocked()
      setReason.run(null, x.call().id)
      lose.run(period, owner, mismatched)
    }
    hold.run(0.39, owner, 'd:%')
    await assertBlocked()
    hold.run(FLOOR, owner, 'd:%')
    ownerOf.run('fixture-b', owner, period)
    assert.equal((await scanPoolRows(x.db, 'fixture-b', x.expireAt)).filter(r => r.period === period).length, 1, 'a marker cannot link to another tenant call')
    await assert.rejects(x.pool('other', 'fixture-b').reserve(0.05), { reason: 'accounting_unsettled' })
    ownerOf.run(owner, 'fixture-b', period)
    await x.pool(ready).reserve(0, x.expireAt, '1234567890')
    const markers = await x.pending()
    assert.deepEqual(markers.map(r => r.period), ['p:1234567890'])
    await assert.rejects(x.reserve(ready, 0.05), { reason: 'busy' })
  } finally { x.db.close() }
})


}

test('a paused old process cannot settle late after another scan is admitted past its terminal hold', async () => {
  for (const actual of [0.01, 0.49]) {
    const x = fixture()
    try {
      // Keep the old closure active: no uncertain() call and no failed-marker flag simulates a lost lease while suspended.
      const paused = await x.reserve(initial, FLOOR)
      x.fail(); x.time(x.expireAt)
      assert.deepEqual(await x.pending(), [])
      const admitted = await x.reserve(ready, 0.05)
      const beforeLate = await x.holdRows()
      await assert.rejects(paused.settle(actual), /accounting_failed/)
      const after = await x.holdRows()
      assert.deepEqual(after.map(r => [r.period, r.reserved_usd, r.reported_usd]), beforeLate.map(r => [r.period, r.reserved_usd, r.reported_usd]), 'neither refund nor new estimate moves')
      assert.deepEqual([x.call().status, x.call().reserve_usd, x.call().actual_usd], ['reserved', FLOOR, null])
      await admitted.settle(0.02)
      assert.ok((await x.holdRows()).every(r => r.period.startsWith('p:') ? r.reserved_usd === FLOOR : Math.abs(r.reserved_usd - 0.42) < 1e-9))
    } finally { x.db.close() }
  }
})


test('hold proof uses the original UTC owner booking across both a day and month rollover', async () => {
  const midnight = Date.parse('2025-02-01T00:00:00Z') / 1000
  const x = fixture(midnight - 1)
  try {
    const hold = await x.reserve(initial, FLOOR, owner, midnight)
    assert.equal((x.db.prepare("SELECT created_at FROM scan_spend_calls WHERE scan_job_id=?").get(initial) as { created_at: number }).created_at, midnight - 1)
    await hold.uncertain(); x.fail(); x.time(x.expireAt)
    assert.deepEqual(await x.pending(), [])
    await (await x.reserve(ready, 0.2)).settle(0.1)
    const balances = Object.fromEntries((await x.holdRows()).filter(r => !r.period.startsWith('p:')).map(r => [r.period, r.reserved_usd]))
    assert.deepEqual(balances, { 'd:2025-01-31': FLOOR, 'd:2025-02-01': 0.1, 'm:2025-01': FLOOR, 'm:2025-02': 0.1 })
  } finally { x.db.close() }
})

test('two retained obligations cannot cite the same insufficient shared window balance', async () => {
  const x = fixture()
  try {
    await (await x.reserve(initial, FLOOR)).uncertain(); x.fail(); x.time(x.expireAt)
    await (await x.reserve(ready, 0.05)).uncertain(); x.fail(ready, x.expireAt + 1)
    x.time(x.expireAt + PENDING_STALE_S + 1)
    assert.deepEqual(await x.pending(), [])
    // The amount would cover either hold in isolation but not both combined.
    x.db.prepare("UPDATE tenant_spend_pools SET reserved_usd=0.42 WHERE tenant_id=? AND period LIKE 'd:%'").run(owner)
    assert.equal((await x.pending()).length, 2)
    await assert.rejects(x.pool('third').reserve(0.03), { reason: 'accounting_unsettled' })
  } finally { x.db.close() }
})

test('the production SQLite reaper stops the ordinary Company First linked search before its grace period', async () => {
  const x = fixture(NOW, companyFirstBudget)
  try {
    const paused = await x.reserve(initial, FLOOR)
    x.db.prepare('UPDATE scan_jobs SET claimed_at = 0 WHERE id = ?').run(initial)
    reapStaleRunningJobs(x.db)
    const old = x.db.prepare('SELECT status,error,finished_at FROM scan_jobs WHERE id=?').get(initial) as { status: string; error: string; finished_at: number }
    assert.deepEqual([old.status, old.error], ['failed', 'accounting_uncertain'])
    x.time(old.finished_at + PENDING_STALE_S - 1)
    assert.equal((await x.pending()).length, 1)
    x.time(old.finished_at + PENDING_STALE_S)
    assert.deepEqual(await x.pending(), [])
    await assert.rejects(x.inJob(initial, owner, () => reserveScanSpend('llm.anthropic.web_search', () => 0.01)), { reason: 'native_search_accounting_pending' })
    const next = await x.reserve(ready, 0.05)
    const oldWindows = (await x.holdRows()).map(r => [r.period, r.reserved_usd, r.reported_usd])
    await assert.rejects(paused.settle(0.01), /accounting_failed/)
    assert.deepEqual((await x.holdRows()).map(r => [r.period, r.reserved_usd, r.reported_usd]), oldWindows)
    await next.settle(0.02)
    assert.deepEqual([x.call().status, x.call().reserve_usd, x.call().actual_usd], ['reserved', FLOOR, null])
  } finally { x.db.close() }
})


test('a busy retry crossing UTC month end settles or refunds only its successful owner booking period', async () => {
  for (const actual of [0, 0.04]) {
    const midnight = Date.parse('2025-02-01T00:00:00Z') / 1000
    const x = fixture(midnight - 1)
    try {
      let clock = midnight - 1
      const pool = sharedPool(x.db, owner, { day: LIMIT, month: LIMIT }, () => clock, 1_000, ready)
      await pool.reserve(0.2)
      await pool.reserve(0.05, clock, '1234567890')
      const existing = new PooledGuard(pool, { trackPending: true })
      const clearing = setTimeout(() => { clock = midnight; void pool.settle(0, null, midnight - 1, '1234567890') }, 10)
      try {
        const held = await reserveAllUsd([existing], 0.1, 'n123456789')
        assert.equal(held.at.get(existing), midnight)
        const marker = (await x.holdRows()).find(r => r.period === 'p:n123456789')
        assert.equal(marker?.updated_at, midnight)
        await settleAll([existing], actual - 0.1, actual, held)
      } finally { clearTimeout(clearing) }
      const balances = Object.fromEntries((await x.holdRows()).map(r => [r.period, [r.reserved_usd, r.reported_usd]]))
      assert.deepEqual(balances['d:2025-01-31'], [0.25, 0])
      assert.deepEqual(balances['m:2025-01'], [0.25, 0])
      for (const w of ['d:2025-02-01', 'm:2025-02']) {
        assert.ok(Math.abs(balances[w][0] - actual) < 1e-9)
        assert.equal(balances[w][1], actual)
      }
      assert.equal(balances['p:n123456789'], undefined)
    } finally { x.db.close() }
  }
})
