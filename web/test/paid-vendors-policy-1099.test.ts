// Refs #1099, Gagan's rule (15 Nov 03:38): no paid third-party API in dazl's default path except Claude. DAZL_PAID_VENDORS empty = off; a control names the vendor.
// Split A of #1273: the policy module and the scan-enrichment gate. Fake fetch; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { paidVendorsAllowed, paidVendorOn, PAID_VENDOR_OFF } from '../lib/paid-vendors.ts'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { paidEnrichmentOutcomes } from '../lib/scan/enrichment-trace.ts'
import { readProviderIssues } from '../lib/scan/provider-issues.ts'
import { providerIssueText } from '../lib/scan/provider-issue-text.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential } from '../lib/connectors/store.ts'

const OFF = { DAZL_PAID_VENDORS: '' }
const master = randomBytes(32)

async function withProcessEnv<T>(v: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const had = process.env.DAZL_PAID_VENDORS
  if (v === undefined) delete process.env.DAZL_PAID_VENDORS; else process.env.DAZL_PAID_VENDORS = v
  try { return await fn() } finally { if (had === undefined) delete process.env.DAZL_PAID_VENDORS; else process.env.DAZL_PAID_VENDORS = had }
}

test('the policy: nothing is allowed by default; only the vendors the operator names, in any case and spacing', async () => {
  await withProcessEnv(undefined, () => {
    assert.deepEqual([...paidVendorsAllowed({})], [])
    for (const v of ['apollo', 'pdl', 'zerobounce', 'openai', 'jina'] as const) assert.equal(paidVendorOn(v, {}), false, v)
  })
  assert.deepEqual([...paidVendorsAllowed({ DAZL_PAID_VENDORS: ' Apollo , PDL ,bogus' })].sort(), ['apollo', 'pdl'])
  // an empty value in a call's own env is an explicit "none", not "ask the process"
  await withProcessEnv('apollo', () => { assert.equal(paidVendorOn('apollo', OFF), false); assert.equal(paidVendorOn('apollo', {}), true) })
})

function enrichSeed() {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 'NYC dental', where: ['New York City'], who: ['Owner'], signals: [] }), jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, fit, intent, action, why) VALUES ('lead1', ?, '', 'Kestrel Dental', 'kestreldental.example', 'opened a new practice', 'https://news.example/k', 4, 3, 4, 'New dental practice in New York.')").run(jobId)
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  saveCredential(db, 'u1', 'enrich:pdl', 'test-pdl-key-1234', master)
  return { db, jobId, lead: { id: 'lead1', company: 'Kestrel Dental', company_domain: 'kestreldental.example' } }
}

test('scan enrichment: with saved Apollo and PDL keys and no paid vendor named, no request is sent and the scan says why once', async () => {
  const { db, jobId, lead } = enrichSeed()
  const calls: string[] = []
  const fetchImpl = (async (u: RequestInfo | URL) => { calls.push(String(u)); return new Response('{}', { status: 200 }) }) as typeof fetch
  await enrichLeadContacts(db, 'u1', jobId, [lead], { fetchImpl, master, env: OFF })
  await enrichLeadContacts(db, 'u1', jobId, [lead], { fetchImpl, master, env: OFF })
  assert.deepEqual(calls, [], 'no Apollo or PDL request')
  const rows = db.prepare("SELECT connector, status, lookup FROM connector_audit WHERE scan_job_id = ? AND status = ?").all(jobId, PAID_VENDOR_OFF) as { connector: string; status: string; lookup: string }[]
  assert.equal(rows.length, 1, 'one note per scan, not per pass')
  assert.match(rows[0].lookup, /not called: dazl uses no paid third-party service by default/)
  assert.equal((db.prepare("SELECT count(*) AS n FROM connector_audit WHERE scan_job_id = ? AND status = 'no_key'").get(jobId) as { n: number }).n, 0, 'never reported as "no key"')
  // not a failed pass, and the scan's notices say why (council review)
  assert.equal(paidEnrichmentOutcomes(db, 'u1', jobId).passFailed, 0)
  const issues = (await readProviderIssues(sqliteDb(db), 'u1', jobId)) ?? []
  assert.deepEqual(issues.map(i => i.status), ['paid_vendor_off'])
  assert.match(providerIssueText(issues[0]), /dazl uses no paid third-party service \(Apollo, People Data Labs\) by default/)
  // control: the operator names Apollo, and the same pass asks Apollo
  const c = enrichSeed()
  await enrichLeadContacts(c.db, 'u1', c.jobId, [c.lead], { fetchImpl, master, env: { DAZL_PAID_VENDORS: 'apollo' } })
  assert.ok((calls as string[]).some(u => u.includes('apollo')), JSON.stringify(calls))
  // only PDL named: the saved Apollo key is never read or called
  const p = enrichSeed(); calls.length = 0
  await enrichLeadContacts(p.db, 'u1', p.jobId, [p.lead], { fetchImpl, master, env: { DAZL_PAID_VENDORS: 'pdl' } })
  assert.ok(!(calls as string[]).some(u => u.includes('apollo')), JSON.stringify(calls))
  assert.ok((calls as string[]).some(u => u.includes('peopledatalabs')), JSON.stringify(calls))
})
