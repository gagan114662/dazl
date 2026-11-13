// TEST-ONLY staging fake PDL (Hermes 2026-11-12: live checks without signing up for any service). Refs #382 #1036.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { pdlPeopleSearch, pdlPersonEnrich, stagingFakePdl } from '../lib/enrich/pdl.ts'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, enrichmentsForLeads } from '../lib/connectors/store.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { findWorkEmail } from '../lib/people/work-email.ts'

const STAGING = { DAZL_ENV: 'staging', DAZL_STAGING_FAKE_PDL: '1' }
const master = randomBytes(32)
const recording = (calls: string[]) => (async (u: RequestInfo | URL) => { calls.push(String(u)); return new Response(JSON.stringify({ data: [] }), { status: 200 }) }) as typeof fetch

test('#382 #1036 the staging fake PDL is inert outside staging: the real request goes out (here a recording stub)', async () => {
  assert.equal(stagingFakePdl({ DAZL_STAGING_FAKE_PDL: '1' }), false)
  assert.equal(stagingFakePdl({ DAZL_ENV: 'production', DAZL_STAGING_FAKE_PDL: '1' }), false)
  assert.equal(stagingFakePdl({ DAZL_ENV: 'staging' }), false)
  const calls: string[] = []
  await pdlPeopleSearch('k', 'Harbor Dental', recording(calls), 5, { env: { DAZL_ENV: 'production', DAZL_STAGING_FAKE_PDL: '1' } })
  await pdlPersonEnrich('k', { first: 'dana', last: 'lee', domain: 'harbordental.example' }, recording(calls), { env: { DAZL_STAGING_FAKE_PDL: '1' } })
  assert.equal(calls.length, 2)
})

test('#382 #1036 on staging with the flag: no network call, a clearly synthetic person on the lead\'s own domain', async () => {
  const calls: string[] = []
  const found = await pdlPeopleSearch('k', 'Harbor Dental', recording(calls), 5, { env: STAGING, hints: { domain: 'harbordental.example' } })
  assert.equal(calls.length, 0)
  assert.deepEqual(found.map(p => [p.name, p.title, p.domain]), [['Staging Testperson', 'Head of Sales', 'harbordental.example']])
  const e = await pdlPersonEnrich('k', { first: 'dana', last: 'lee', domain: 'harbordental.example' }, recording(calls), { env: STAGING, hints: { title: 'Practice Manager' } })
  assert.equal(calls.length, 0)
  assert.deepEqual([e.billed, e.match?.email, e.match?.country, e.match?.title], [true, 'staging-dana.lee@harbordental.example', 'united states', 'Practice Manager'], 'the address is self-evidently synthetic')
  assert.deepEqual(await pdlPeopleSearch('k', 'No Domain Co', recording(calls), 5, { env: STAGING }), [], 'no domain known: no match, never an invented domain')
  assert.deepEqual(await pdlPersonEnrich('k', { first: 'a', last: 'b', domain: '' }, recording(calls), { env: STAGING }), { billed: false, match: null })
})

test('#382 staging live-check path: Apollo rejects its key, the fake PDL is called through every real gate and its person is attached', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: [], who: [], signals: [] }), jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('lead1', ?, '', 'Harbor Dental', 'harbordental.example', 'opened', 'https://x.example/1')").run(jobId)
  saveCredential(db, 'u1', 'enrich:pdl', 'any-staging-string', master) // only PDL saved: it is the provider
  const calls: string[] = []
  const r = await enrichLeadContacts(db, 'u1', jobId, [{ id: 'lead1', company: 'Harbor Dental', company_domain: 'harbordental.example' }], { fetchImpl: recording(calls), master, env: STAGING })
  assert.equal(calls.length, 0, 'no real request')
  const contacts = (enrichmentsForLeads(db, 'u1', ['lead1']).lead1 ?? []).filter(e => e.kind === 'contact').map(e => e.value)
  assert.deepEqual(contacts, ['Staging Testperson - Head of Sales'], JSON.stringify(r.outcomes))
})

test('#1036 staging live-check path: Find work email with only a PDL key returns the fake US address, still labelled as PDL\'s, unchecked', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'software', location: 'New York' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 'x', where: ['New York, NY'], who: ['Practice manager'], signals: [] }), job)
  const lead = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, confidence) VALUES (?, ?, '', 'Harbor Dental', 'harbordental.example', 'hiring', 'https://harbordental.example/careers', 80)").run(lead, job)
  const add = (connector: string, kind: string, value: string, url: string, label: string | null = null) => db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', ?, ?, ?, ?, 70, ?, '2026-11-01', 1799999900)").run(randomBytes(12).toString('hex'), lead, connector, kind, value, label, url)
  add('sitecrawl', 'domain', 'harbordental.example|evidence_own_domain', 'https://harbordental.example/', 'domain-basis-v1:evidence_own_domain')
  add('enrich:apollo', 'contact', 'Dana Lee - Practice Manager', 'https://www.linkedin.com/in/dana-lee-invented')
  saveCredential(db, 'A', 'enrich:pdl', 'any-staging-string', master)
  const calls: string[] = []
  const r = await findWorkEmail(db, 'A', lead, 'Dana Lee|Practice Manager', { fetchImpl: recording(calls), master, now: 1_800_000_000, env: STAGING })
  assert.equal(calls.length, 0)
  assert.equal(r.status, 'unverified')
  assert.deepEqual([(r as { row: { provider: string; address: string } }).row.provider, (r as { row: { address: string } }).row.address], ['pdl', 'staging-dana.lee@harbordental.example'])
})

test('#382 #1036 through the real callers, a production env with the flag set makes the real request and attaches no synthetic person', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: [], who: [], signals: [] }), jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('lead1', ?, '', 'Harbor Dental', 'harbordental.example', 'opened', 'https://x.example/1')").run(jobId)
  saveCredential(db, 'u1', 'enrich:pdl', 'k', master)
  const calls: string[] = []
  await enrichLeadContacts(db, 'u1', jobId, [{ id: 'lead1', company: 'Harbor Dental', company_domain: 'harbordental.example' }], { fetchImpl: recording(calls), master, env: { DAZL_ENV: 'production', DAZL_STAGING_FAKE_PDL: '1' } })
  assert.equal(calls.length, 1, 'the real request')
  assert.ok(!(enrichmentsForLeads(db, 'u1', ['lead1']).lead1 ?? []).some(e => /Staging Testperson/.test(e.value)))
})
