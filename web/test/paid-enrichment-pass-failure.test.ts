// #923 residual after #961: the paid contact pass records its own failures under the SHARED connector 'enrich'
// (lib/enrich/index.ts setupFailed: 'pass setup'; lib/signals/index.ts: 'contact pass'). The run report read only
// 'enrich:apollo' / 'enrich:pdl', so a pass that failed was reported "unavailable: no key configured". And when no claim
// rows exist (every lead held, or the key could not be read), held / setup rows were counted as provider lookups.
// These tests drive the real enrichLeadContacts writer (synthetic keys, .example companies, injected fetch that is
// never reached unless stated, no network, no credits) and then the real notePaidEnrichment + mergeIntoRunReport path.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateRunReport } from '../lib/scan/run-report.ts'
import { migrateConnectors, saveCredential, audit } from '../lib/connectors/store.ts'
import { EnrichmentTrace, notePaidEnrichment, mergeIntoRunReport, paidEnrichmentOutcomes } from '../lib/scan/enrichment-trace.ts'

const master = randomBytes(32)
const ICP = JSON.stringify({ summary: 'x', where: ['New York City'], who: ['Practice manager'], signals: [] })
const L1 = { id: 'l1', company: 'Harbor Dental', company_domain: 'harbordental.example' }
const L2 = { id: 'l2', company: 'Ridge Vision', company_domain: 'ridgevision.example' }
const noFetch = { n: 0 }
const neverCalled = (async () => { noFetch.n++; throw new Error('provider must not be called') }) as unknown as typeof fetch
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })

function seed(provs: ('apollo' | 'pdl')[], icp: string = ICP, keyMaster = master) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateRunReport(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(icp, jobId)
  for (const l of [L1, L2]) db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES (?, ?, '', ?, ?, 'opened', 'https://x.example/1')").run(l.id, jobId, l.company, l.company_domain)
  if (provs.includes('apollo')) saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', keyMaster)
  if (provs.includes('pdl')) saveCredential(db, 'u1', 'enrich:pdl', 'test-pdl-key-5678', keyMaster)
  return { db, jobId }
}
function report(db: Database.Database, jobId: string, tenant = 'u1') {
  const tr = new EnrichmentTrace(); notePaidEnrichment(tr, db, tenant, jobId)
  db.prepare("INSERT OR REPLACE INTO scan_run_report (job_id, attempt, report) VALUES (?, 1, '{}')").run(jobId)
  assert.equal(mergeIntoRunReport(db, jobId, 1, { enrichment: tr.stages }), true)
  const stored = JSON.parse((db.prepare('SELECT report FROM scan_run_report WHERE job_id = ? AND attempt = 1').get(jobId) as { report: string }).report) as { enrichment: { stage: string; status: string; reason: string | null; detail?: Record<string, number | string> }[] }
  return stored.enrichment.find(s => s.stage === 'paid_enrichment')!
}
const contacts = (db: Database.Database) => (db.prepare("SELECT COUNT(*) n FROM lead_enrichments WHERE kind = 'contact'").get() as { n: number }).n

for (const prov of ['apollo', 'pdl'] as const) {
  test(`${prov}: a pass whose setup failed (unreadable scan ICP) is failed, never "unavailable: no key configured"`, async () => {
    const { db, jobId } = seed([prov], '{not json'); noFetch.n = 0
    await enrichLeadContacts(db, 'u1', jobId, [L1, L2], { fetchImpl: neverCalled, master })
    assert.equal(noFetch.n, 0, 'no provider request was made')
    const row = db.prepare("SELECT lookup, status FROM connector_audit WHERE connector = 'enrich'").get() as { lookup: string; status: string }
    assert.equal(row.lookup, 'pass setup'); assert.match(row.status, /^setup failed: /) // the real writer's shape
    const s = report(db, jobId)
    assert.equal(s.status, 'failed'); assert.notEqual(s.status, 'unavailable')
    assert.match(s.reason ?? '', /pass failed/); assert.doesNotMatch(s.reason ?? '', /no Apollo/)
    assert.equal(s.detail?.pass_failed, 1); assert.equal(s.detail?.lookups, 0, 'no provider lookup happened'); assert.equal(s.detail?.with_results, 0)
  })
}

test('master key missing: the real writer records a pass setup failure and the report says failed, lookups 0', async () => {
  const { db, jobId } = seed(['apollo'])
  const saved = process.env.DAZL_MASTER_KEY; delete process.env.DAZL_MASTER_KEY
  try { await enrichLeadContacts(db, 'u1', jobId, [L1], { fetchImpl: neverCalled }) } finally { if (saved !== undefined) process.env.DAZL_MASTER_KEY = saved }
  const s = report(db, jobId)
  assert.equal(s.status, 'failed'); assert.equal(s.detail?.pass_failed, 1); assert.equal(s.detail?.lookups, 0)
})

test('contact pass crash row (signals writer shape) is failed; beside a real contact success it stays visible', async () => {
  // success path through the real writer (PDL), then the 'contact pass' row exactly as lib/signals/index.ts writes it
  const { db, jobId } = seed(['pdl'])
  const fetchImpl = (async () => ok({ data: [{ full_name: 'Pat Lee', job_title: 'Practice Manager', job_company_website: L1.company_domain, job_company_location_locality: 'New York' }] })) as unknown as typeof fetch
  await enrichLeadContacts(db, 'u1', jobId, [L1], { fetchImpl, master })
  assert.equal(contacts(db), 1)
  audit(db, { tenantId: 'u1', connector: 'enrich', jobId, lookup: 'contact pass', status: 'pass failed: boom', results: 0 })
  const s = report(db, jobId)
  assert.equal(s.status, 'ok'); assert.equal(s.detail?.with_results, 1); assert.equal(s.detail?.pass_failed, 1)
  assert.match(s.reason ?? '', /pass failed/)

  const only = seed(['apollo'])
  audit(only.db, { tenantId: 'u1', connector: 'enrich', jobId: only.jobId, lookup: 'contact pass', status: 'pass failed: boom', results: 0 })
  const f = report(only.db, only.jobId)
  assert.equal(f.status, 'failed'); assert.equal(f.detail?.lookups, 0); assert.equal(f.detail?.pass_failed, 1)
})

test('every lead held by the run budget (no claims): skipped with lookups 0, not N lookups', async () => {
  const { db, jobId } = seed(['apollo']); noFetch.n = 0
  await enrichLeadContacts(db, 'u1', jobId, [L1, L2], { fetchImpl: neverCalled, master, budget: { apollo: 0 } })
  assert.equal(noFetch.n, 0)
  assert.equal((db.prepare("SELECT COUNT(*) n FROM connector_claims").get() as { n: number }).n, 0)
  const s = report(db, jobId)
  assert.equal(s.status, 'skipped'); assert.equal(s.detail?.lookups, 0); assert.equal(s.detail?.held, 1); assert.equal(s.detail?.apollo_lookups, 0)
})

test('a saved key that cannot be decrypted is failed with lookups 0 (the key load is not a provider lookup)', async () => {
  const { db, jobId } = seed(['apollo'], ICP, randomBytes(32)); noFetch.n = 0
  await enrichLeadContacts(db, 'u1', jobId, [L1], { fetchImpl: neverCalled, master })
  assert.equal(noFetch.n, 0)
  const s = report(db, jobId)
  assert.equal(s.status, 'failed'); assert.equal(s.detail?.lookups, 0); assert.equal(s.detail?.failed, 1)
})

test('negative controls: no key -> unavailable; a pass failure of another job or tenant does not leak in', async () => {
  const { db, jobId } = seed([])
  await enrichLeadContacts(db, 'u1', jobId, [L1], { fetchImpl: neverCalled, master })
  audit(db, { tenantId: 'u1', connector: 'enrich', jobId: 'other-job', lookup: 'pass setup', status: 'setup failed: x', results: 0 })
  audit(db, { tenantId: 'u2', connector: 'enrich', jobId, lookup: 'pass setup', status: 'setup failed: x', results: 0 })
  audit(db, { tenantId: 'u1', connector: 'enrichment', jobId, lookup: 'pass setup', status: 'setup failed: x', results: 0 }) // look-alike connector
  const s = report(db, jobId)
  assert.equal(s.status, 'unavailable'); assert.equal(s.detail?.pass_failed, 0); assert.equal(s.detail?.lookups, 0)
})

test('adversarial: a shared-connector row is never a success, whatever its status/results say; duplicates are counted, not merged into success', () => {
  for (const [status, results] of [['ok', 5], ['empty', 0], ['', 0], ['budget_exhausted', 0], ['\u0000\uFFFD'.repeat(500), 0]] as [string, number][]) {
    const { db, jobId } = seed([])
    audit(db, { tenantId: 'u1', connector: 'enrich', jobId, lookup: 'pass setup', status, results })
    audit(db, { tenantId: 'u1', connector: 'enrich', jobId, lookup: 'pass setup', status, results })
    const o = paidEnrichmentOutcomes(db, 'u1', jobId)
    assert.equal(o.ok, 0); assert.equal(o.passFailed, 2); assert.equal(o.total, 0)
    const s = report(db, jobId)
    assert.equal(s.status, 'failed', `status ${JSON.stringify(status).slice(0, 20)}`)
  }
})

test('adversarial: other tenant / job ids of the wrong type never match; unreadable audit table stays failed', () => {
  const { db, jobId } = seed([])
  audit(db, { tenantId: 'u1', connector: 'enrich', jobId, lookup: 'pass setup', status: 'setup failed: x', results: 0 })
  for (const bad of [null, 1, {}, [], true] as unknown[]) {
    const o = paidEnrichmentOutcomes(db, bad as string, jobId)
    assert.equal(o.ok, 0); assert.equal(o.passFailed + (o.unreadable ? 1 : 0) <= 1, true)
    if (!o.unreadable) assert.equal(o.passFailed, 0, `tenant ${JSON.stringify(bad)} must not read u1's rows`)
  }
  const bare = new Database(':memory:')
  const tr = new EnrichmentTrace(); notePaidEnrichment(tr, bare, 'u1', 'j')
  assert.equal(tr.stages[0].status, 'failed')
})
