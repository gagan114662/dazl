import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateCommenterImport, commenterBatchStatus, deleteCommenterBatch, deriveName, enrichCommenters, importCommenters, normalizeProfileUrl, parseImport, MAX_PROFILES } from '../lib/scan/commenter-import.ts'
import { createJob } from '../lib/scan/store.ts'
import { saveCredential } from '../lib/connectors/store.ts'
import { randomBytes } from 'node:crypto'

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateConnectors(db); migrateCommenterImport(db) // connectors store carries lead_enrichments
  return db
}

test('normalizeProfileUrl: accepts only linkedin.com/in profiles; posts, companies and other paths rejected; non-linkedin rejected', () => {
  assert.deepEqual(normalizeProfileUrl('https://www.linkedin.com/in/jane-doe-8a4b2112/'), { url: 'https://www.linkedin.com/in/jane-doe-8a4b2112', slug: 'jane-doe-8a4b2112' })
  assert.deepEqual(normalizeProfileUrl('linkedin.com/in/janedoe'), { url: 'https://www.linkedin.com/in/janedoe', slug: 'janedoe' })
  for (const bad of [
    'https://www.linkedin.com/posts/jane-doe_great-post-123',
    'https://www.linkedin.com/company/acme',
    'https://www.linkedin.com/feed/update/urn:li:activity:1',
    'https://example.com/in/jane-doe',
    'https://notlinkedin.com/in/jane',
  ]) assert.ok('reason' in normalizeProfileUrl(bad), bad)
})

test('deriveName: slug to display name, member-id suffix dropped', () => {
  assert.equal(deriveName('jane-doe-8a4b2112'), 'Jane Doe')
  assert.equal(deriveName('janedoe'), 'Janedoe')
})

test('parseImport URL mode: dedupes, flags invalid, caps at 100, names derived', () => {
  const lines = ['https://www.linkedin.com/in/a-b', 'https://www.linkedin.com/in/a-b/', 'not a url']
    .concat(Array.from({ length: 120 }, (_, i) => `https://www.linkedin.com/in/person-${i}`))
  const p = parseImport(lines.join('\n'))
  assert.equal(p.mode, 'urls')
  assert.equal(p.valid.length, MAX_PROFILES)
  assert.equal(p.overflow, 21)
  assert.equal(p.invalid.length, 1)
  assert.equal(p.valid[0].name_source, 'derived')
  assert.equal(p.valid[0].name, 'A B')
})

test('parseImport CSV mode: header columns map, csv names win, slug name is fallback, quoted commas survive', () => {
  const csv = [
    'profile_url,name,title,company',
    'https://www.linkedin.com/in/jane-doe,"Doe, Jane",VP Sales,"Acme, Inc"',
    'https://www.linkedin.com/in/john-roe-9z,,SDR,Roe Co',
    'https://www.linkedin.com/in/no-company,Solo,,',
    'https://www.linkedin.com/company/acme,Bad Row,x,y',
  ].join('\n')
  const p = parseImport(csv)
  assert.equal(p.mode, 'csv')
  assert.equal(p.valid.length, 3)
  assert.equal(p.valid[0].name, 'Doe, Jane')
  assert.equal(p.valid[0].name_source, 'csv')
  assert.equal(p.valid[0].title, 'VP Sales')
  assert.equal(p.valid[0].company, 'Acme, Inc')
  assert.equal(p.valid[1].name, 'John Roe')
  assert.equal(p.valid[1].name_source, 'derived')
  assert.equal(p.invalid.length, 1)
  assert.match(p.invalid[0].reason, /only profile URLs/)
})

test('importCommenters: one batch, one job born done, one lead per row straight from the row, context is the signal', () => {
  const db = setup()
  const p = parseImport(['profile_url,name,title,company', 'https://www.linkedin.com/in/jane-doe,Jane Doe,VP Sales,Acme', 'https://www.linkedin.com/in/john-roe,,,'].join('\n'))
  const r = importCommenters(db, 'A', p.valid, 'Commented on my post about CRM switching costs')
  const job = db.prepare('SELECT status, candidates FROM scan_jobs WHERE id = ?').get(r.jobId) as { status: string; candidates: number }
  assert.equal(job.status, 'done')
  const leads = db.prepare('SELECT name, company, signal, source_url, contact, confidence FROM leads WHERE scan_job_id = ? ORDER BY rowid').all(r.jobId) as { name: string; company: string; signal: string; source_url: string; contact: string | null; confidence: number | null }[]
  assert.equal(leads.length, 2)
  assert.equal(leads[0].name, 'Jane Doe - VP Sales')
  assert.equal(leads[0].company, 'Acme')
  assert.equal(leads[0].signal, 'Commented on my post about CRM switching costs')
  assert.equal(leads[0].source_url, 'https://www.linkedin.com/in/jane-doe')
  assert.equal(leads[0].contact, null) // no emails stored
  assert.equal(leads[1].name, 'John Roe') // slug-derived, no title
  const st = commenterBatchStatus(db, 'A', r.batchId)!
  assert.equal(st.rows[1].name_source, 'derived')
  assert.equal(commenterBatchStatus(db, 'B', r.batchId), undefined) // tenant isolation
})

test('deleteCommenterBatch: removes enrichments, leads, rows, job and batch; tenant-scoped', () => {
  const db = setup()
  const p = parseImport('https://www.linkedin.com/in/jane-doe')
  const r = importCommenters(db, 'A', p.valid, 'ctx')
  const leadId = (db.prepare('SELECT id FROM leads WHERE scan_job_id = ?').get(r.jobId) as { id: string }).id
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES ('e1', ?, 'A', 'enrich:apollo', 'contact', 'Someone - CTO', 'https://acme.com', '2026-10-21', 1)").run(leadId)
  assert.equal(deleteCommenterBatch(db, 'B', r.batchId), false) // not the owner
  assert.equal((db.prepare('SELECT count(*) AS n FROM lead_enrichments').get() as { n: number }).n, 1)
  assert.equal(deleteCommenterBatch(db, 'A', r.batchId), true)
  for (const t of ['lead_enrichments', 'leads', 'commenter_rows', 'commenter_batches', 'scan_jobs']) {
    assert.equal((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n, 0, t)
  }
})

// #382: the commenter-import paid calls share the waterfall's atomic reservation primitive (this route holds no
// job lease, so a double-run must never pay twice). Stubbed providers; no network, no credits.
function seedBatch() {
  const db = setup()
  const master = randomBytes(32)
  const jobId = createJob(db, 'A', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('l1', ?, '', 'Acme', 'acme.com', 'opened', 'https://x.example/1')").run(jobId)
  db.prepare("INSERT INTO commenter_batches (id, user_id, context, total, note, created_at, job_id) VALUES ('b1', 'A', 't', 1, NULL, 1, ?)").run(jobId)
  saveCredential(db, 'A', 'enrich:apollo', 'test-apollo-key-1234', master)
  return { db, master, jobId }
}
const apolloStub = (calls: { org: number; people: number }) => (async (u: RequestInfo | URL) => {
  const s = String(u)
  if (s.includes('organizations')) { calls.org++; return new Response(JSON.stringify({ organization: { name: 'Acme', website_url: 'https://acme.com', city: 'New York', state: 'NY', country: 'United States' } }), { status: 200 }) }
  calls.people++; return new Response(JSON.stringify({ people: [{ name: 'Commenter Person', title: 'VP', linkedin_url: 'https://profiles.example/c', organization: { name: 'Acme', primary_domain: 'acme.com' } }] }), { status: 200 })
}) as typeof fetch

test('enrichCommenters: a replay (re-import / double-run) never repays - the second run makes 0 provider calls', async () => {
  const { db, master } = seedBatch()
  const calls = { org: 0, people: 0 }
  await enrichCommenters(db, 'A', 'b1', { fetchImpl: apolloStub(calls), master })
  assert.equal(calls.org, 1); assert.equal(calls.people, 1)
  await enrichCommenters(db, 'A', 'b1', { fetchImpl: apolloStub(calls), master })
  assert.equal(calls.org, 1, 'terminal org outcome replays free')
  assert.equal(calls.people, 1, 'terminal people outcome replays free')
})

test('enrichCommenters: a stale reserved org row (crashed pass) skips the paid org call but still runs the free people search', async () => {
  const { db, master, jobId } = seedBatch()
  db.prepare("INSERT INTO connector_audit (id, tenant_id, connector, scan_job_id, lookup, status, results) VALUES ('r1', 'A', 'enrich:apollo', ?, 'org Acme', 'reserved', 0)").run(jobId)
  const calls = { org: 0, people: 0 }
  await enrichCommenters(db, 'A', 'b1', { fetchImpl: apolloStub(calls), master })
  assert.equal(calls.org, 0, 'the possibly-paid org call is never repeated')
  assert.equal(calls.people, 1, 'the 0-credit people search still runs under its own gate')
})
