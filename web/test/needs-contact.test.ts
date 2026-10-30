// "Needs contact": a lead whose every contact was refused says so on its card, with the refusal reason under it. Synthetic leads; Apollo is stubbed; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { needsContact } from '../lib/scan/needs-contact.ts'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, enrichmentsForLeads } from '../lib/connectors/store.ts'

const rej = (value: string) => ({ kind: 'contact_rejected', value })

test('every contact refused and nothing attached: "Needs contact" with the reasons (prefix stripped, deduped, at most 3, bounded)', () => {
  const n = needsContact({ contact: null, enrichments: [rej('contact rejected: location mismatch Pico Rivera, CA vs New York, NY'), rej('contact rejected: location mismatch Pico Rivera, CA vs New York, NY'), rej('contact rejected: domain mismatch acme.io vs acme.com')] })
  assert.deepEqual(n, { label: 'Needs contact', reasons: ['location mismatch Pico Rivera, CA vs New York, NY', 'domain mismatch acme.io vs acme.com'] })
  assert.equal(needsContact({ enrichments: ['a', 'b', 'c', 'd', 'e'].map(x => rej(`contact rejected: ${x}`)) })!.reasons.length, 3)
  assert.ok(needsContact({ enrichments: [rej('contact rejected: ' + 'x'.repeat(500))] })!.reasons[0].length <= 140)
})

test('not shown when the lead has a route, or was never refused anything', () => {
  assert.equal(needsContact({ contact: 'office@harbor.example', enrichments: [rej('contact rejected: domain mismatch a vs b')] }), null)
  for (const kind of ['contact', 'person', 'email', 'phone']) assert.equal(needsContact({ contact: null, enrichments: [{ kind, value: 'x' }, rej('contact rejected: location mismatch A vs B')] }), null, kind)
  assert.equal(needsContact({ contact: null, enrichments: [] }), null)
  assert.equal(needsContact({ contact: '  ', enrichments: undefined }), null)
  assert.equal(needsContact({ contact: null, enrichments: [{ kind: 'firmographic', value: '12 employees' }] }), null)
})

test('end to end: the Pico Rivera same-name practice is refused for a New York lead, so the card reads "Needs contact" with that reason', async () => {
  const master = randomBytes(32), db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 'NYC dental', where: ['New York City'], who: ['Practice manager'], signals: [] }), jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url) VALUES ('lead1', ?, '', 'Smile Avenue Dental', 'opened a new practice', 'https://news.example/1')").run(jobId)
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  const fetchImpl = (async (u: RequestInfo | URL) => String(u).includes('organizations/enrich')
    ? new Response(JSON.stringify({ organization: { name: 'Smile Avenue Dental Group', website_url: 'https://smileavenuedental.com', city: 'Pico Rivera', state: 'California', country: 'United States' } }), { status: 200 })
    : new Response(JSON.stringify({ people: [{ name: 'Sophia Rozov', title: 'Practice Manager' }] }), { status: 200 })) as typeof fetch
  await enrichLeadContacts(db, 'u1', jobId, [{ id: 'lead1', company: 'Smile Avenue Dental', company_domain: null }], { fetchImpl, master })
  const enrichments = enrichmentsForLeads(db, 'u1', ['lead1']).lead1 ?? []
  assert.ok(!enrichments.some(e => e.kind === 'contact' || e.kind === 'person'))
  const n = needsContact({ contact: null, enrichments })
  assert.equal(n?.label, 'Needs contact'); assert.match(n!.reasons.join(' | '), /location mismatch Pico Rivera, CA vs New York, NY/)
})
