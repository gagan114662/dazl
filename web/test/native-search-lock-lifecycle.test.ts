import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { reserveScanSpend, runWithScanSpend, scanCapConfig, type ScanSpendCtx } from '../lib/scan/spend-cap.ts'

test('only the owned running search blocks other jobs, but interrupted spend stays fully reserved', async () => {
  const db = new Database(':memory:')
  try {
    migrateAllSqlite(db)
    for (const [id, tenant] of [['old', 'a'], ['new', 'a'], ['foreign', 'b']]) {
      db.prepare("INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status,attempts) VALUES (?,?,'Fixture','Test','Test','running',1)").run(id, tenant)
    }
    const reserve = (jobId: string, tenantId: string, usd: number) => {
      const ctx: ScanSpendCtx = { db, jobId, tenantId, attempt: 1, cap: scanCapConfig({}), claudeOnly: true, accountLimits: { day: 0.5, month: 0.5 }, clock: () => 1_800_000_000 }
      return runWithScanSpend(ctx, () => reserveScanSpend('llm.anthropic.web_search', () => usd))
    }
    assert.ok(await reserve('old', 'a', 0.4))
    await assert.rejects(reserve('new', 'a', 0.05), { reason: 'native_search_accounting_pending' })
    assert.ok(await reserve('foreign', 'b', 0.1))
    db.prepare("UPDATE scan_jobs SET status='failed',error='accounting_uncertain' WHERE id='old'").run()
    await assert.rejects(reserve('old', 'a', 0.05), { reason: 'native_search_accounting_pending' })
    await assert.rejects(reserve('new', 'a', 0.2), { reason: 'owner_pool_limit' })
    assert.ok(await reserve('new', 'a', 0.05))
    assert.deepEqual(db.prepare("SELECT status,reserve_usd,actual_usd FROM scan_spend_calls WHERE scan_job_id='old' AND status='reserved'").all(), [{ status: 'reserved', reserve_usd: 0.4, actual_usd: null }])
    const pools = db.prepare("SELECT reserved_usd,reported_usd FROM tenant_spend_pools WHERE tenant_id='a'").all() as { reserved_usd: number; reported_usd: number }[]
    assert.equal(pools.length, 2)
    for (const p of pools) { assert.ok(Math.abs(p.reserved_usd - 0.45) < 1e-9); assert.equal(p.reported_usd, 0) }
  } finally { db.close() }
})
