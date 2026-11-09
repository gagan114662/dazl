// Child #992 of #920: actual route reader, both engines. No cutover or PG gate-writer claim. Review-write rejection and
// marker persistence are fault fixtures; legacy gate-writer integration is tested separately in first5-gate-held-920.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { bothEngines } from './helpers/engines.ts'
import { createJob, listLeads } from '../lib/scan/store-db.ts'
import { readFirst5, verifiedLeads, isFirst5 } from '../lib/scan/first5-db.ts'
import { verifiedLeads as legacyLeads, isFirst5 as legacyMode } from '../lib/scan/first5.ts'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'

const outcome = scanOutcome({ id: 'j', status: 'done', error: null })
const input = { status: 'done', progress: [], outcome }
bothEngines('first5 production reader: rejected review write + durable marker never counts held rows; tenant/job/gates/provisional stay honest', async ({ db, kind, raw }) => {
  const job = await createJob(db, 'A', { business_name: 'test', industry: 'test', location: 'test' }, '{"first5":true}')
  const other = await createJob(db, 'A', { business_name: 'other', industry: 'test', location: 'test' }, '{"first5":true}')
  for (const id of [job, other]) await db.run("UPDATE scan_jobs SET status = 'running' WHERE id = ?", [id])
  for (const [id, fit, quarantine, review, j] of [
    ['ok', 4, null, null, job], ['held', 5, null, null, job], ['low', 1, null, null, job],
    ['quarantined', 5, 1, null, job], ['reviewed', 5, null, 'review', job], ['other', 5, null, null, other],
  ] as const) await db.run(`INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, fit, quarantined_at, review_reason) VALUES (?, ?, 'Co', 'signal', 'https://example.test', 80, ?, ?, ?)`, [id, j, fit, quarantine, review])
  if (kind === 'sqlite') await db.run("CREATE TRIGGER reject_review_992 BEFORE UPDATE OF review_reason ON leads WHEN NEW.review_reason IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected review write rejection'); END")
  else {
    await db.run("CREATE FUNCTION reject_review_992() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.review_reason IS NOT NULL THEN RAISE EXCEPTION 'injected review write rejection'; END IF; RETURN NEW; END $$")
    await db.run('CREATE TRIGGER reject_review_992 BEFORE UPDATE OF review_reason ON leads FOR EACH ROW EXECUTE FUNCTION reject_review_992()')
  }
  await assert.rejects(db.run("UPDATE leads SET review_reason = 'sales_hiring_check_failed', confidence = NULL WHERE id = 'held'"), /injected review write rejection/)
  assert.deepEqual(await db.get("SELECT review_reason, confidence FROM leads WHERE id = 'held'"), { review_reason: null, confidence: 80 })
  await db.run("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('marker', 'held', 'A', 'scan:gate', 'gate_failed', 'sales_hiring_check_failed', 'gate failed', 'https://invalid.example/', '2026-11-07', 1)")
  // Finish via legal job transitions, then exercise the exact reader called by the status route.
  await db.run("UPDATE scan_jobs SET status = 'done', enrich_started_at = 1, enrich_finished_at = 2 WHERE id = ?", [job])
  assert.deepEqual((await listLeads(db, 'A', job, 200, true)).filter(l => l.id === 'held').map(l => [l.review_reason, l.confidence]), [['sales_hiring_check_failed', null]])
  const rows = await verifiedLeads(db, 'A', job)
  assert.deepEqual(rows.map(l => [l.id, l.fit_pct, l.provisional]), [['ok', 80, false]])
  const terminal = await readFirst5(db, 'A', job, input)
  assert.equal(terminal?.verified, 1); assert.equal(terminal?.state, 'partial')
  const active = await readFirst5(db, 'A', job, { ...input, status: 'enriching' })
  assert.deepEqual([active?.verified, active?.enriching, active?.can_continue, active?.leads[0].provisional], [0, true, false, true])
  assert.equal(await readFirst5(db, 'B', job, input), undefined)
  assert.deepEqual(await verifiedLeads(db, 'B', job), [])
  assert.deepEqual((await verifiedLeads(db, 'A', other)).map(l => l.id), ['other'])
  assert.equal(await isFirst5(db, 'A', job), true)
  if (raw) { assert.deepEqual(rows, legacyLeads(raw, 'A', job)); assert.equal(await isFirst5(db, 'A', job), legacyMode(raw, 'A', job)) }
  for (const budget of [null, '{broken', '{"first5":false}', '{"first5":"true"}']) {
    await db.run('UPDATE scan_jobs SET run_budget = ? WHERE id = ?', [budget, job])
    assert.equal(await readFirst5(db, 'A', job, input), undefined)
  }
})

test('status route uses the production first5 reader on the same scan handle, not independent DATABASE_URL selection', () => {
  const route = readFileSync(new URL('../app/api/scan/status/route.ts', import.meta.url), 'utf8')
  assert.match(route, /await readScanStatus\(sqliteDb\(raw\), user\.tenantId, jobId\)/)
  const service = readFileSync(new URL('../lib/scan/status-read-service.ts', import.meta.url), 'utf8')
  assert.match(service, /await readFirst5\(db, tenantId, job\.id,/)
  const reader = readFileSync(new URL('../lib/scan/first5-db.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(reader, /\bgetDb\s*\(/)
})

bothEngines('first5 production reader: known fit before unknown, stable insertion ties, unknown dates/fit unchanged', async ({ db, raw }) => {
  const job = await createJob(db, 'A', { business_name: 'test', industry: 'test', location: 'test' }, '{"first5":true}')
  await db.run("UPDATE scan_jobs SET status = 'running' WHERE id = ?", [job])
  for (const [id, fit] of [['unknown', null], ['tie-first', 4], ['tie-second', 4]] as const) {
    await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, fit, created_at, published_at) VALUES (?, ?, 'Co', 'signal', 'https://example.test', ?, 1, '2026-10-01')", [id, job, fit])
  }
  const rows = await verifiedLeads(db, 'A', job)
  assert.deepEqual(rows.map(l => [l.id, l.fit_pct, l.event_date, l.published_at]), [
    ['tie-first', 80, null, '2026-10-01'], ['tie-second', 80, null, '2026-10-01'], ['unknown', null, null, '2026-10-01'],
  ])
  if (raw) assert.deepEqual(rows, legacyLeads(raw, 'A', job))
})
