// Child #993: production whole-payload reader on one injected domain store, not a PG cutover or runner port.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { bothEngines } from './helpers/engines.ts'
import { createJob } from '../lib/scan/store-db.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb, setDb } from '../lib/db/client.ts'
import { modelUsage } from '../lib/scan/model-usage.ts'
import { sourceStats } from '../lib/search/trace.ts'
import { sourceRuns } from '../lib/scan/source-runs.ts'
import { runReportFor } from '../lib/scan/run-report.ts'
import { estimateRun } from '../lib/scan/price-estimate.ts'

bothEngines('whole scan status: tenant scope, same-id poison other store, recorded-zero vs unknown, held/provisional and legacy parity', async ({ db, raw }) => {
  const job = await createJob(db, 'A', { business_name: 'real', industry: 'software', location: 'Toronto' }, '{"first5":true}')
  await db.run("UPDATE scan_jobs SET status = 'running', query = 'real query', icp = '{}', icp_inferred = 0, candidates = 2, verified = 2, needs_review = 0, dropped = 0 WHERE id = ?", [job])
  for (const id of ['ok', 'held']) await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, fit) VALUES (?, ?, 'Co', 's', 'https://example.test', 80, 4)", [id, job])
  await db.run("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('m', 'held', 'A', 'scan:gate', 'gate_failed', 'sales_hiring_check_failed', 'held', 'https://invalid.example/', '2026-11-07', 1)")
  const unknown = await readScanStatus(db, 'A', job)
  assert.equal(unknown?.model_usage.recorded, false); assert.equal(unknown?.model_usage.input_tokens, null)
  assert.deepEqual(unknown?.source_stats, []); assert.equal(unknown?.run_report, null); assert.equal(unknown?.cost, null)
  assert.equal(await readScanStatus(db, 'B', job), undefined)
  assert.equal(await readScanStatus(db, 'A', 'f'.repeat(24)), undefined)
  assert.equal(await readScanStatus(db, 'A', 'invalid'), undefined)
  await db.run("INSERT INTO scan_source_runs (job_id, attempt, collector, status, evidence_count, candidate_count, verified_count, review_count, inserted_count) VALUES (?, 1, 'search:news', 'ok', 0, NULL, 0, NULL, 0)", [job])
  await db.run("INSERT INTO scan_source_stats (job_id, attempt, collector, queries, searches_attempted, searches_ok, hits_raw, searches_failed, searches_not_attempted, per_query) VALUES (?, 1, 'search:news', '[]', 0, 0, 0, '{}', '{}', '[]')", [job])
  await db.run("INSERT INTO scan_model_calls (tenant_id, job_id, attempt, seq, stage, method, model_requested, model_served, input_tokens, output_tokens, outcome, prompt_chars) VALUES ('A', ?, 1, 0, 'extraction', 'complete', 'test', 'test', 0, 0, 'ok', 0)", [job])
  await db.run("INSERT INTO connector_audit (id, tenant_id, connector, scan_job_id, lookup, status, results, created_at) VALUES ('real-audit', 'A', 'enrich:apollo', ?, 'not disclosed', 'auth', 0, 1)", [job])
  // A separately selected Db has same tenant/job id but contradictory data. The service must never consult it.
  const poisonRaw = new Database(':memory:'); migrateAllSqlite(poisonRaw)
  poisonRaw.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query) VALUES (?, 'A', 'poison', 'x', 'x', 'POISON')").run(job)
  poisonRaw.prepare("INSERT INTO connector_audit (id, tenant_id, connector, scan_job_id, lookup, status, results) VALUES ('poison-audit', 'A', 'enrich:pdl', ?, 'poison', 'rate_limited', 0)").run(job)
  setDb(sqliteDb(poisonRaw))
  try {
    const active = await readScanStatus(db, 'A', job)
    assert.equal(active?.query, 'real query')
    assert.deepEqual(active?.provider_issues?.map(i => [i.connector, i.status, i.lookups_affected]), [['enrich:apollo', 'auth', 1]])
    assert.equal(active?.model_usage.input_tokens, 0); assert.equal(active?.model_usage.tokens_complete, true)
    assert.equal(active?.source_stats?.[0].searches_attempted, 0)
    assert.equal(active?.source_runs[0].candidate_count, null)
    assert.equal(typeof active?.source_runs[0].attempt, 'number')
    assert.equal(active?.first5?.leads.length, 1)
    if (raw) {
      assert.deepEqual(active?.model_usage, modelUsage(raw, 'A', job))
      assert.deepEqual(active?.source_stats, sourceStats(raw, 'A', job))
      assert.deepEqual(active?.source_runs, (sourceRuns(raw, 'A', job) as Record<string, unknown>[]).map(({ job_id: omit, ...r }) => { void omit; return r }))
      assert.deepEqual(active?.run_report, runReportFor(raw, 'A', job))
    }
    const report = { resolution: { candidates: 2, resolved: 1, unresolved: 1, by_reason: { held: 1 } } }
    await db.run('INSERT INTO scan_run_report (job_id, attempt, report) VALUES (?, 1, ?)', [job, JSON.stringify(report)])
    const estimate = estimateRun({ budget: { first5: true, paid_fallback: false, credit_enrichment: false }, payer: 'you' })
    await db.run('UPDATE scan_jobs SET estimate = ?, spend_reserved_usd = 0 WHERE id = ?', [JSON.stringify(estimate), job])
    const now = Math.floor(Date.now() / 1000)
    await db.run("UPDATE scan_jobs SET status = 'done', enrich_started_at = ? WHERE id = ?", [now, job])
    const provisional = await readScanStatus(db, 'A', job)
    assert.deepEqual([provisional?.status, provisional?.first5?.verified, provisional?.first5?.leads[0].provisional], ['enriching', 0, true])
    assert.deepEqual(provisional?.enrichment, { state: 'running', started_at: now, finished_at: null })
    await db.run('UPDATE scan_jobs SET enrich_finished_at = ? WHERE id = ?', [now + 1, job])
    const terminal = await readScanStatus(db, 'A', job)
    assert.deepEqual([terminal?.status, terminal?.first5?.verified, terminal?.first5?.leads[0].id], ['done', 1, 'ok'])
    assert.deepEqual(terminal?.enrichment, { state: 'finished', started_at: now, finished_at: now + 1 })
    assert.equal(await readScanStatus(db, 'B', job), undefined)
    assert.deepEqual(terminal?.run_report, [report]); assert.deepEqual(terminal?.resolution, report.resolution)
    assert.ok(terminal?.cost); assert.ok(!terminal?.not_recorded.includes('per_url_fetch_outcomes'))
    await db.run("UPDATE scan_run_report SET report = 'invalid-json' WHERE job_id = ?", [job])
    await db.run("UPDATE scan_jobs SET estimate = 'invalid-json' WHERE id = ?", [job])
    const invalid = await readScanStatus(db, 'A', job)
    assert.equal(invalid?.run_report, null); assert.equal(invalid?.cost, null)
  } finally { setDb(null); poisonRaw.close() }
})

test('status adapter preserves legacy same-handle reaping and dispatch; read service never selects or mutates another store', () => {
  const route = readFileSync(new URL('../app/api/scan/status/route.ts', import.meta.url), 'utf8')
  assert.match(route, /getJob\(raw, user\.tenantId, jobId\)/)
  assert.match(route, /after\(\(\) => kickRunner\(raw\)\)/)
  assert.match(route, /readScanStatus\(sqliteDb\(raw\), user\.tenantId, jobId\)/)
  for (const file of ['status-read-service.ts', 'status-reads.ts']) {
    const source = readFileSync(new URL(`../lib/scan/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\b(?:getDb|getScanDb|kickRunner|reapStaleJobs)\s*\(/)
    assert.doesNotMatch(source, /db\.(?:run|tx)\(/)
  }
})

bothEngines('status read service preserves explicit unknowns when optional recording tables are absent', async ({ db }) => {
  const job = await createJob(db, 'A', { business_name: 'old scan', industry: 'software', location: 'Toronto' })
  // These are test-only fresh schemas, never a live DB. No provider record must not be fabricated as an all-clear.
  for (const table of ['scan_source_stats', 'scan_model_calls', 'scan_run_report', 'connector_audit']) await db.run(`DROP TABLE ${table}`)
  const payload = await readScanStatus(db, 'A', job)
  assert.equal(payload?.source_stats, null); assert.equal(payload?.run_report, null)
  assert.equal(payload?.model_usage.recorded, false); assert.equal(payload?.model_usage.input_tokens, null)
  assert.equal(payload?.provider_issues, null)
  assert.equal(payload?.status, 'pending', 'read service does not reap, restart or dispatch pending work')
  assert.deepEqual(payload?.not_recorded, ['search_queries', 'raw_search_hits', 'fetched_pages'])
})
