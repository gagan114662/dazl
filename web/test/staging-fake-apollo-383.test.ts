// #383 TEST-ONLY staging fake Apollo (Hermes-PC live check 2026-11-13: "Criteria 1-2 need a test-only Apollo answer on staging
// (same pattern as the #1131 test PDL), including a former employee, an assistant-to-buyer, a buyer beyond the first five, and a
// record date inside and outside 90 days"). Plus the export-side proof of Hermes' role-label finding (fixed by #1195).
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { apolloPeopleSearch, apolloOrgEnrich, stagingFakeApollo, STAGING_APOLLO_ROSTER } from '../lib/enrich/apollo.ts'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, enrichmentsForLeads, addEnrichment } from '../lib/connectors/store.ts'
import { contactsFromEnrichments } from '../lib/people/rank.ts'
import { bestPeople } from '../lib/people/best-person.ts'
import { sqliteDb } from '../lib/db/client.ts'

const STAGING = { DAZL_ENV: 'staging', DAZL_STAGING_FAKE_APOLLO: '1' }
const master = randomBytes(32)
const DAY = 86_400_000
const recording = (calls: string[]) => (async (u: RequestInfo | URL) => { calls.push(String(u)); return new Response(JSON.stringify({ people: [] }), { status: 200 }) }) as typeof fetch

test('#383 the staging fake Apollo is inert outside staging: the real request goes out (here a recording stub)', async () => {
  assert.equal(stagingFakeApollo({ DAZL_STAGING_FAKE_APOLLO: '1' }), false)
  assert.equal(stagingFakeApollo({ DAZL_ENV: 'production', DAZL_STAGING_FAKE_APOLLO: '1' }), false)
  assert.equal(stagingFakeApollo({ DAZL_ENV: 'staging' }), false)
  assert.equal(stagingFakeApollo(STAGING), true)
  const calls: string[] = []
  await apolloPeopleSearch('k', { domain: 'acme.example', name: 'Acme' }, recording(calls), 5, { titles: ['VP of Sales'] }, { DAZL_ENV: 'production', DAZL_STAGING_FAKE_APOLLO: '1' })
  assert.equal(calls.length, 1)
})

test('#383 criterion 1 on the fake: the buyer is beyond the first five unfiltered employees; the role filter returns it, no network call', async () => {
  const calls: string[] = []
  assert.ok(STAGING_APOLLO_ROSTER.findIndex(p => p.title === 'VP of Sales') >= 5, 'fixture shape: the buyer sits beyond the first five')
  const unfiltered = await apolloPeopleSearch('k', { domain: 'acme.example', name: 'Acme' }, recording(calls), 5, undefined, STAGING)
  assert.equal(unfiltered.length, 5)
  assert.ok(!unfiltered.some(p => /VP|Sales/.test(p.title ?? '')), 'the first unfiltered page has no buyer')
  const filtered = await apolloPeopleSearch('k', { domain: 'acme.example', name: 'Acme' }, recording(calls), 5, { titles: ['VP of Sales'] }, STAGING)
  assert.ok(filtered.some(p => p.name === 'Staging Buyer' && p.title === 'VP of Sales'), JSON.stringify(filtered))
  assert.ok(filtered.every(p => p.name.startsWith('Staging ') && p.organization?.domain === 'acme.example'), 'clearly synthetic, on the lead\'s own domain')
  assert.deepEqual(await apolloPeopleSearch('k', { domain: null, name: 'No Domain' }, recording(calls), 5, { titles: ['VP of Sales'] }, STAGING), [], 'no domain: no match, never an invented one')
  const org = await apolloOrgEnrich('k', { domain: 'acme.example' }, recording(calls), STAGING)
  assert.equal(org?.website, 'https://acme.example')
  assert.equal(calls.length, 0)
})

// Same reviewed-persona seed as test/issue-383-acceptance.test.ts.
function seed() {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ?, icp_inferred = 0 WHERE id = ?").run(JSON.stringify({ who: ['VP of Sales'], research: { v: 1, site: 'https://seller-site.com', offers: [{ i: 'o1', n: 'Flags' }], hyps: [], q: null, ans: null } }), jobId)
  db.prepare('INSERT INTO seller_decisions (id,tenant_id,actor_id,job_id,site,offer_id,hypothesis_id,kind,text,action,source_url,source_quote,source_checked_at,created_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)')
    .run(randomBytes(8).toString('hex'), 'u1', 'actor1', jobId, 'seller-site.com', 'o1', 'h-1', 'persona', 'VP of Sales', 'confirm', null, null, null, 1000)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, score) VALUES ('lead1', ?, '', 'Acme', 'acme.example', 'hiring', 'https://x.example/1', 50)").run(jobId)
  saveCredential(db, 'u1', 'enrich:apollo', 'any-staging-string', master)
  return { db, jobId, leads: [{ id: 'lead1', company: 'Acme', company_domain: 'acme.example', score: 50 }] }
}

test('#383 criteria 1, 2, 4 through the real enrichment path on the fake: buyer attached, former and assistant-to rejected, record dates inside/outside 90 days', async () => {
  const s = seed(), calls: string[] = []
  const saved = { a: process.env.DAZL_ENV, b: process.env.DAZL_STAGING_FAKE_APOLLO }
  process.env.DAZL_ENV = 'staging'; process.env.DAZL_STAGING_FAKE_APOLLO = '1'
  try { await enrichLeadContacts(s.db, 'u1', s.jobId, s.leads, { fetchImpl: recording(calls), master, env: STAGING }) }
  finally { if (saved.a === undefined) delete process.env.DAZL_ENV; else process.env.DAZL_ENV = saved.a; if (saved.b === undefined) delete process.env.DAZL_STAGING_FAKE_APOLLO; else process.env.DAZL_STAGING_FAKE_APOLLO = saved.b }
  assert.equal(calls.length, 0, 'no network call')
  const rows = enrichmentsForLeads(s.db, 'u1', ['lead1']).lead1 ?? []
  assert.deepEqual(rows.filter(r => r.kind === 'contact').map(r => r.value).sort(), ['Staging Buyer - VP of Sales', 'Staging Stalebuyer - VP of Sales, EMEA'])
  const rejected = rows.filter(r => r.kind === 'contact_rejected').map(r => r.value).join(' | ')
  assert.ok(!rows.some(r => r.kind === 'contact' && /Formerbuyer|Assistant/.test(r.value)), 'former employee and assistant-to-buyer are never attached')
  assert.equal(rows.filter(r => r.kind === 'contact_rejected').length, 2, rejected)
  const ranked = contactsFromEnrichments(rows, 'VP of Sales', Date.now())
  assert.equal(ranked.find(p => p.name === 'Staging Buyer')?.currency, 'verified_current', 'record dated 10 days ago')
  assert.equal(ranked.find(p => p.name === 'Staging Stalebuyer')?.currency, 'search_only', 'record dated 200 days ago')
  void DAY
})

test('#383 Hermes 2026-11-13 finding: a stored crawl row "Litigation Specialist, Managing Partner" is never the export\'s best person (fixed by #1195; export path)', async () => {
  const s = seed()
  addEnrichment(s.db, 'u1', 'lead1', { connector: 'sitecrawl', kind: 'person', value: 'Litigation Specialist, Managing Partner', label: null, confidence: 70, source_url: 'https://www.armstrongteasdale.com/people/', source_date: new Date().toISOString().slice(0, 10), retrieved_at: Math.floor(Date.now() / 1000) })
  const best = await bestPeople(sqliteDb(s.db), 'u1', [{ lead_id: 'lead1', job_id: s.jobId }])
  assert.deepEqual(best.get('lead1'), { best_person: '', best_person_title: '', best_person_link: '', best_person_found_via: '' })
})
