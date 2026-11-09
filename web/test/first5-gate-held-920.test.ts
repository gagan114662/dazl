// #920: first5's verified read must exclude a lead held by a FAILED required gate whose review write was rejected (the durable scan:gate / gate_failed marker), exactly as the canonical
// lead reads do. Real fail-closed gate + persistence, fault-injected review write (a trigger rejects it), in-memory SQLite, no network, no provider, no send.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob, listLeads } from '../lib/scan/store.ts'
import { listLeads as listLeadsDb } from '../lib/scan/store-db.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { failClosedSalesHiring, persistHeldState } from '../lib/scan/sales-hiring-gate.ts'
import { verifiedLeads, first5Of } from '../lib/scan/first5.ts'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'

const QUERY = 'Find London UK B2B SaaS startups that announced seed funding and are hiring sales staff.'
const ICP = JSON.stringify({ summary: 's', where: ['London, UK'], who: ['Founder'], signals: ['announced seed funding', 'hiring sales staff'], exclude: [] })
const BUDGET = JSON.stringify({ first5: true, paid_fallback: false, credit_enrichment: false })
const noOutcome = scanOutcome({ id: 'j', status: 'done', error: null })

function setup(tenant = 'A') {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, tenant, { business_name: 'Acme', industry: 'SaaS', location: 'London' }, BUDGET)
  db.prepare("UPDATE scan_jobs SET status = 'running', query = ?, icp = ?, verified = 2 WHERE id = ?").run(QUERY, ICP, job)
  const add = (id: string, fit: number | null) => db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, evidence_excerpt, confidence, review_reason, score, fit) VALUES (?, ?, ?, 'raised a seed round', 'https://news.example/a', 'raised a seed round', 80, NULL, 80, ?)").run(id, job, `Co ${id}`, fit)
  return { db, job, add }
}
// The fault: the gate's review write (UPDATE leads SET review_reason = ...) is rejected, so the row keeps reading verified.
const rejectReviewWrite = (db: Database.Database) => db.exec("CREATE TRIGGER reject_review BEFORE UPDATE OF review_reason ON leads WHEN NEW.review_reason IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected: review write rejected'); END")
function failGate(db: Database.Database, job: string, tenant = 'A') {
  const j = { id: job, user_id: tenant, query: QUERY, icp: ICP }
  const held = failClosedSalesHiring(db, j, 'injected gate failure')
  persistHeldState(db, j, held.filter(h => !h.written), 'injected gate failure')
  return held
}

test('CONTROL: with no gate failure, first5 reads the valid leads as verified, unchanged', () => {
  const { db, job, add } = setup(); add('a', 5); add('b', null)
  const leads = verifiedLeads(db, 'A', job)
  assert.deepEqual(leads.map(l => [l.id, l.fit_pct, l.provisional]), [['a', 100, false], ['b', null, false]])
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  assert.equal(first5Of({ status: 'done', leads, progress: [], outcome: noOutcome }).verified, 2)
})

test('FAULT-INJECTED: review write rejected, marker persists, enrichment finishes - first5 neither counts nor calls the held lead verified, agreeing with listLeads', async () => {
  const { db, job, add } = setup(); add('held', 5)
  rejectReviewWrite(db)
  const held = failGate(db, job)
  assert.deepEqual(held.map(h => [h.id, h.written]), [['held', false]], 'the review write really was rejected')
  assert.equal((db.prepare('SELECT review_reason FROM leads WHERE id = ?').get('held') as { review_reason: string | null }).review_reason, null, 'the row still reads verified')
  assert.ok(db.prepare("SELECT 1 FROM lead_enrichments WHERE lead_id = 'held' AND connector = 'scan:gate' AND kind = 'gate_failed'").get(), 'the durable marker persisted')
  db.prepare("UPDATE scan_jobs SET status = 'done', enrich_finished_at = 1 WHERE id = ?").run(job)
  // Canonical reads (raw SQLite store and the Db-layer store) show it held.
  const canon = listLeads(db, 'A', job, 200, true) as { id: string; review_reason: string | null; confidence: number | null }[]
  assert.deepEqual(canon.filter(r => r.id === 'held').map(r => [r.review_reason, r.confidence]), [['sales_hiring_check_failed', null]])
  const canonDb = await listLeadsDb(sqliteDb(db), 'A', job, 200, true) as { id: string; review_reason: string | null }[]
  assert.deepEqual(canonDb.filter(r => r.id === 'held').map(r => r.review_reason), ['sales_hiring_check_failed'])
  // first5 agrees.
  const leads = verifiedLeads(db, 'A', job)
  assert.deepEqual(leads, [], 'the held lead is not a first5 verified lead')
  const v = first5Of({ status: 'done', leads, progress: [], outcome: noOutcome })
  assert.equal(v.verified, 0); assert.notEqual(v.state, 'ready'); assert.notEqual(v.state, 'partial')
})

test('only the held lead is excluded: a valid sibling in the same job stays verified; while enriching it stays provisional', () => {
  const { db, job, add } = setup(); add('ok', 4); add('held', 5)
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('m1', 'held', 'A', 'scan:gate', 'gate_failed', 'sales_hiring_check_failed', 'x', NULL, 'https://invalid.example/', '2026-11-06', 1)").run()
  const leads = verifiedLeads(db, 'A', job)
  assert.deepEqual(leads.map(l => l.id), ['ok'])
  assert.deepEqual(first5Of({ status: 'enriching', leads, progress: [], outcome: noOutcome }).leads.map(l => l.provisional), [true], 'honest provisional state kept')
  assert.equal(first5Of({ status: 'done', leads, progress: [], outcome: noOutcome }).state, 'partial')
})

test('tenant / job scope and existing filters are kept: another tenant reads nothing, quarantine and low fit still exclude', () => {
  const { db, job, add } = setup(); add('q', 5); add('low', 1); add('ok', 5)
  db.prepare("UPDATE leads SET quarantined_at = 1 WHERE id = 'q'").run()
  assert.deepEqual(verifiedLeads(db, 'A', job).map(l => l.id), ['ok'])
  assert.deepEqual(verifiedLeads(db, 'B', job), [])
})

test('a store without the enrichments table reads the row as stored (same fallback as the canonical reads)', () => {
  const { db, job, add } = setup(); add('a', 5)
  db.exec('DROP TABLE lead_enrichments')
  assert.deepEqual(verifiedLeads(db, 'A', job).map(l => l.id), ['a'])
})
