import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { CLAUDE_SEARCH_MODEL, claudeSearchEstimate } from '../lib/llm/claude-web-search-estimate.ts'
import { periodOf, poolRows, scanPoolRows, sharedPool } from '../lib/llm/spend-pool.ts'
import { estimateForBody } from '../lib/scan/estimate-request.ts'
import { qaClaudeOnlyBudget } from '../lib/scan/qa-provider-policy.ts'
import { reserveScanSpend, runWithScanSpend, scanCapConfig } from '../lib/scan/spend-cap.ts'
import { SourceRunLedger } from '../lib/scan/source-runs.ts'
import { reapStaleRunningJobs } from '../lib/scan/store.ts'

const TENANT = 'legacy-test-owner'
const CREATED = 1_795_124_879
const CALL = CREATED + 10, FINISH = CREATED + 30
const MARKER = '7a90dead00'
const EST = claudeSearchEstimate(138)
const OLD = 'old-native-search', NEW = 'new-scan'
const LIMIT = 0.3

async function fixture({ owner = TENANT, oldId = OLD, newId = NEW, tokens = 138, query = 'Businesses in a fictional market' } = {}) {
  const quote = claudeSearchEstimate(tokens)
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  const cap = { day: LIMIT, month: LIMIT }
  const budget = JSON.stringify({ ...JSON.parse(qaClaudeOnlyBudget('{"first5":true}', true)), execution: 'local_once_v1' })
  raw.prepare(`INSERT INTO scan_jobs
   (id,user_id,business_name,industry,location,status,attempts,created_at,run_budget,estimate,query) VALUES
   (?,?,'Fixture','Test','Test','running',1,?,?,?,?)`).run(
    oldId, owner, CREATED, budget, JSON.stringify({ payer: 'you', cap: { month_cap_usd: LIMIT } }), query)
  const oldPool = sharedPool(db, owner, cap, () => CALL, 0)
  await oldPool.reserve(quote.estimatedUsd, CALL, MARKER)
  raw.prepare('UPDATE scan_jobs SET spend_reserved_usd=? WHERE id=?').run(quote.estimatedUsd, oldId)
  const inOld = <T>(fn: () => Promise<T>) => runWithScanSpend({
    db, tenantId: owner, jobId: oldId, attempt: 1, cap: scanCapConfig({}), requestMaxUsd: 1, claudeOnly: true,
    accountLimits: null, clock: () => CALL,
  }, fn)
  const old = await inOld(async () => (await reserveScanSpend('llm.anthropic.web_search', () => quote.estimatedUsd))!)
  await oldPool.markFailed(MARKER)
  const report = ({ actualUsd = null, literalUnknown = true }: { actualUsd?: number | null; literalUnknown?: boolean } = {}) => {
    const l = new SourceRunLedger()
    l.attach(raw, oldId, 1)
    l.record('search:anthropic_web', 'error')
    l.model({ stage: 'native_web_search', method: 'research', model_requested: CLAUDE_SEARCH_MODEL, model_served: null,
      input_tokens: null, output_tokens: null, outcome: 'error', max_tokens: null, prompt_chars: 900 })
    l.report({ native_web_search: {
      estimated_usd: quote.estimatedUsd, actual_usd: actualUsd, counted_prompt_tokens: quote.countedInputTokens,
      assumed_result_tokens: quote.assumedSearchInputTokens, assumed_tool_overhead_tokens: quote.assumedToolOverheadTokens,
      reported_input_tokens: null, reported_output_tokens: null, searches: null, max_searches: quote.maxSearches,
      max_output_tokens: quote.maxOutputTokens, expected_model: quote.model, estimate_exceeded: null, soft_estimate: true,
    } })
    l.write(raw, oldId, 1, null, null, new Set()); l.flushModelCalls(raw, oldId, 1)
    if (!literalUnknown) raw.prepare("UPDATE scan_run_report SET report=json_remove(report,'$.native_web_search.actual_usd') WHERE job_id=?").run(oldId)
  }
  const finish = () => raw.prepare("UPDATE scan_jobs SET status='failed',error='accounting_uncertain',finished_at=?,claimed_at=NULL WHERE id=?").run(FINISH, oldId)
  const pool = (job: string | undefined = newId, at = FINISH + 300, tenant = owner) => sharedPool(db, tenant, cap, () => at, 0, job)
  const estimate = () => estimateForBody({ query: 'Find example companies' },
    { db, tenantId: owner, hasOwnKey: true, model: 'claude-sonnet-4-5', enrichmentVendors: [] })
  return { raw, db, report, finish, pool, estimate, old, inOld }
}

test('legacy finance metadata stops blocking distinct new scans only with the durable unknown-native receipt', async () => {
  const x = await fixture()
  try {
    x.report(); x.finish()
    const visible = await x.estimate()
    assert.ok(visible.ok)
    assert.notEqual(visible.estimate.verdict.reason, 'accounting_unsettled')
    await assert.rejects(x.pool(OLD).reserve(0.01), { reason: 'accounting_unsettled' })
    await assert.rejects(x.inOld(() => reserveScanSpend('llm.anthropic.web_search', () => 0.01)), { reason: 'native_search_accounting_pending' })
    await assert.rejects(sharedPool(x.db, TENANT, { day: LIMIT, month: LIMIT }, () => FINISH + 300, 0).reserve(0.01), { reason: 'accounting_unsettled' })
    await assert.rejects(x.pool(NEW, FINISH + 299).reserve(0.01), { reason: 'accounting_unsettled' })
    await assert.rejects(x.pool().reserve(0.09), { reason: 'over_limit' }, 'old reserve still binds')
    const original = await poolRows(x.db, TENANT)
    assert.equal(original.find(r => r.period === 'p:' + MARKER)?.reserved_usd, EST.estimatedUsd)
    await x.pool().reserve(0.03, FINISH + 300, 'n123456789')
    const both = await poolRows(x.db, TENANT)
    assert.equal(both.find(r => r.period === 'p:' + MARKER)?.reserved_usd, EST.estimatedUsd)
    assert.equal(both.find(r => r.period === periodOf('day', CALL))?.reserved_usd, EST.estimatedUsd + 0.03)
    assert.equal(both.find(r => r.period === periodOf('month', CALL))?.reserved_usd, EST.estimatedUsd + 0.03)
    await assert.rejects(x.pool('independent-third').reserve(0.01), { reason: 'busy' })
    for (const bill of [0.01, 0.24]) {
      await assert.rejects(x.pool(OLD).settle(bill - EST.estimatedUsd, bill, CALL, MARKER), { reason: 'ownership_lost' })
    }
    await assert.rejects(x.pool(OLD).exhaust(CALL, MARKER), { reason: 'ownership_lost' })
    await assert.rejects(x.old.settle(0.01), { reason: 'ownership_lost' })
    assert.deepEqual(await poolRows(x.db, TENANT), both)
    assert.deepEqual(x.raw.prepare('SELECT status,reserve_usd,actual_usd FROM scan_spend_calls WHERE id=?').get(x.old.id),
      { status: 'reserved', reserve_usd: EST.estimatedUsd, actual_usd: null })
  } finally { x.raw.close() }
})

test('a real naked stale reaper stays fenced even with identical owner, cap, amount and time', async () => {
  const x = await fixture()
  try {
    x.raw.prepare('UPDATE scan_jobs SET claimed_at=0 WHERE id=?').run(OLD)
    reapStaleRunningJobs(x.raw)
    const old = x.raw.prepare('SELECT status,error,finished_at FROM scan_jobs WHERE id=?').get(OLD) as { status: string; error: string; finished_at: number }
    assert.equal(old.status, 'failed'); assert.equal(old.error, 'accounting_uncertain')
    await assert.rejects(x.pool(NEW, old.finished_at + 300).reserve(0.01), { reason: 'accounting_unsettled' })
  } finally { x.raw.close() }
})

test('known actual, missing explicit unknown, non-owner, ambiguous marker and UTC-gap cases stay fenced', async () => {
  for (const mode of ['actual', 'missing', 'no-owner', 'additional-marker', 'midnight-gap', 'cross-tenant', 'old-window-underfunded'] as const) {
    const x = await fixture()
    try {
      x.report({ actualUsd: mode === 'actual' ? EST.estimatedUsd : null, literalUnknown: mode !== 'missing' }); x.finish()
      if (mode === 'no-owner') x.raw.prepare("UPDATE scan_jobs SET estimate=json_set(estimate,'$.cap.month_cap_usd',NULL) WHERE id=?").run(OLD)
      if (mode === 'additional-marker') x.raw.prepare("INSERT INTO tenant_spend_pools VALUES (?, 'p:6666666666', ?, 0, 0, 0)").run(TENANT, EST.estimatedUsd)
      if (mode === 'midnight-gap') x.raw.prepare('UPDATE scan_jobs SET created_at=created_at-86400 WHERE id=?').run(OLD)
      if (mode === 'old-window-underfunded') x.raw.prepare("UPDATE tenant_spend_pools SET reserved_usd=0.2 WHERE tenant_id=? AND period LIKE 'm:%'").run(TENANT)
      let owner = TENANT
      if (mode === 'cross-tenant') {
        owner = 'another-tenant'
        x.raw.prepare("UPDATE tenant_spend_pools SET tenant_id=? WHERE tenant_id=?").run(owner, TENANT)
      }
      const pending = (await scanPoolRows(x.db, owner, FINISH + 300)).filter(r => r.period.startsWith('p:'))
      assert.ok(pending.length, mode)
      await assert.rejects(x.pool(NEW, FINISH + 300, owner).reserve(0.01), { reason: 'accounting_unsettled' }, mode)
    } finally { x.raw.close() }
  }
})


test('first successful independent reservation seals exact legacy proof without depending on retained run reports', async () => {
  const x = await fixture()
  try {
    x.report(); x.finish()
    await assert.rejects(x.pool().reserve(0.09), { reason: 'over_limit' })
    assert.deepEqual(x.raw.prepare('SELECT reason FROM scan_spend_calls WHERE id=?').get(x.old.id), { reason: null })
    await x.pool().reserve(0.02)
    assert.deepEqual(x.raw.prepare('SELECT reason FROM scan_spend_calls WHERE id=?').get(x.old.id), { reason: 'native_legacy_link:p:' + MARKER })
    x.raw.prepare('DELETE FROM scan_run_report WHERE job_id=?').run(OLD)
    x.raw.prepare('DELETE FROM scan_model_calls WHERE job_id=?').run(OLD)
    x.raw.prepare('DELETE FROM scan_source_runs WHERE job_id=?').run(OLD)
    const retained = await poolRows(x.db, TENANT)
    assert.deepEqual((await scanPoolRows(x.db, TENANT, FINISH + 30_000)).filter(r => r.period.startsWith('p:')), [])
    await assert.rejects(x.pool(OLD).reserve(0.01), { reason: 'accounting_unsettled' })
    await assert.rejects(x.pool().settle(-EST.estimatedUsd, 0, CALL, MARKER), { reason: 'ownership_lost' })
    assert.deepEqual(await poolRows(x.db, TENANT), retained)
    await x.pool('next-after-report-retention').reserve(0.01)
    assert.equal((await poolRows(x.db, TENANT)).find(r => r.period === 'p:' + MARKER)?.reserved_usd, EST.estimatedUsd)
    x.raw.prepare('DELETE FROM scan_jobs WHERE id=?').run(OLD)
    await assert.rejects(x.pool().reserve(0.01), { reason: 'accounting_unsettled' }, 'a missing job cannot authorize another charge')
  } finally { x.raw.close() }
})


test('legacy proof is independent of account, job identity, geography, category and price', async () => {
  const owner = 'another-owner-in-fixture', oldId = 'totally-different-old-job', newId = 'totally-different-new-job'
  const query = 'Independent payroll providers hiring in Wellington, New Zealand'
  const tokens = 7_200, quote = claudeSearchEstimate(tokens)
  assert.notEqual(quote.estimatedUsd, EST.estimatedUsd)
  const x = await fixture({ owner, oldId, newId, tokens, query })
  try {
    x.report(); x.finish()
    assert.deepEqual(x.raw.prepare('SELECT query FROM scan_jobs WHERE id=?').get(oldId), { query })
    const pools = () => poolRows(x.db, owner)
    await x.pool().reserve(0.02)
    const saved = (await pools()).find(r => r.period === 'p:' + MARKER)
    assert.equal(saved?.reserved_usd, quote.estimatedUsd)
    assert.ok((await pools()).filter(r => !r.period.startsWith('p:')).every(r => Math.abs(r.reserved_usd - quote.estimatedUsd - 0.02) < 1e-9))
    assert.deepEqual(x.raw.prepare('SELECT reason FROM scan_spend_calls WHERE id=?').get(x.old.id), { reason: 'native_legacy_link:p:' + MARKER })
    await assert.rejects(x.pool(oldId).reserve(0.01), { reason: 'accounting_unsettled' })
  } finally { x.raw.close() }
})
