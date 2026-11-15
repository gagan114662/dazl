// #1037: a scan whose workspace has no Apollo or People Data Labs key used to make no contact lookup and record NOTHING, so the scan
// looked like a run where PDL "produced 0 rows" (Hermes's prod matrix, 14 Nov: named 0%, email 0%, and the reason was only visible on a
// lead card's Find work email text). Now the pass records one 'no_key' row; the scan view says it in words; the enrichment trace
// says "no key" rather than "no key, or no eligible lead"; and it is never counted as a failed pass.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, audit } from '../lib/connectors/store.ts'
import { readProviderIssues, providerIssueText } from '../lib/scan/provider-issues.ts'
import { EnrichmentTrace, notePaidEnrichment, paidEnrichmentOutcomes } from '../lib/scan/enrichment-trace.ts'
import { sqliteDb } from '../lib/db/client.ts'

const master = randomBytes(32)
function seed(tenant = 'u1') {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, tenant, { business_name: 'B', industry: 'dental', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('lead1', ?, '', 'Acme Dental', 'acmedental.ca', 'hiring', 'https://acmedental.ca/careers')").run(jobId)
  return { db, jobId, lead: { id: 'lead1', company: 'Acme Dental', company_domain: 'acmedental.ca' } }
}
const never = (async () => { throw new Error('no outbound call is allowed') }) as unknown as typeof fetch

test('#1037 a keyless scan: the scan view lists why nothing was looked up, in words', async () => {
  const { db, jobId, lead } = seed()
  await enrichLeadContacts(db, 'u1', jobId, [lead], { fetchImpl: never, master })
  const issues = await readProviderIssues(sqliteDb(db), 'u1', jobId)
  assert.deepEqual(issues?.map(i => [i.connector, i.status, i.lookups_affected]), [['enrich', 'no_key', 1]])
  const text = providerIssueText(issues![0])
  assert.match(text, /^No contacts were looked up in this scan: no Apollo or People Data Labs key is saved for this workspace/)
  assert.match(text, /Settings > Enrichment/)
  // another tenant's scan view never shows it
  assert.deepEqual(await readProviderIssues(sqliteDb(db), 'someone-else', jobId), [])
})

test('#1037 the enrichment trace says "no key" (not "no key, or no eligible lead") and does not count it as a failed pass', async () => {
  const { db, jobId, lead } = seed()
  await enrichLeadContacts(db, 'u1', jobId, [lead], { fetchImpl: never, master })
  const o = paidEnrichmentOutcomes(db, 'u1', jobId)
  assert.deepEqual([o.passFailed, o.failed, o.total], [0, 0, 0], 'nothing was tried, so nothing failed')
  const t = new EnrichmentTrace(); notePaidEnrichment(t, db, 'u1', jobId)
  assert.deepEqual(t.stages.map(s => [s.stage, s.status, s.reason]), [['paid_enrichment', 'unavailable', 'no Apollo / People Data Labs key is saved for this workspace, so no contact lookup was made']])
  // a real pass failure on the same connector is still a failure
  audit(db, { tenantId: 'u1', connector: 'enrich', jobId, lookup: 'pass setup', status: 'setup failed: x', results: 0 })
  assert.equal(paidEnrichmentOutcomes(db, 'u1', jobId).passFailed, 1)
})

test('#1037 no row when there is no lead to look up, and none when a key is saved (the ordinary pass runs)', async () => {
  const a = seed()
  await enrichLeadContacts(a.db, 'u1', a.jobId, [], { fetchImpl: never, master })
  assert.equal((a.db.prepare("SELECT count(*) AS n FROM connector_audit WHERE status = 'no_key'").get() as { n: number }).n, 0)
  const t = new EnrichmentTrace(); notePaidEnrichment(t, a.db, 'u1', a.jobId)
  assert.equal(t.stages[0].reason, 'no Apollo / People Data Labs key configured for this tenant, or no eligible lead', 'the old wording stays where it is still true')
  const b = seed()
  saveCredential(b.db, 'u1', 'enrich:pdl', 'test-pdl-key-1234', master)
  await enrichLeadContacts(b.db, 'u1', b.jobId, [b.lead], { fetchImpl: (async () => new Response(JSON.stringify({ status: 404 }), { status: 404 })) as unknown as typeof fetch, master })
  assert.equal((b.db.prepare("SELECT count(*) AS n FROM connector_audit WHERE status = 'no_key'").get() as { n: number }).n, 0)
})
