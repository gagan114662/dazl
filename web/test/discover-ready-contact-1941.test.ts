import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import Database from 'better-sqlite3'
import { addEnrichment } from '../lib/connectors/store.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { discoverExportFields } from '../lib/discover/export.ts'
import { discoverJobCounts } from '../lib/discover/state-db.ts'
import { createDraft } from '../lib/outreach/service.ts'
import { discoverApprove, discoverContact, discoverState } from '../lib/discover/card.ts'

function published(address: string, source: string) {
  return { kind: 'email', connector: 'discover', value: address, source_url: source, label: 'published on a public page' }
}

test('a dated hiring lead selects the valid named work mailbox after an ineligible address', () => {
  const address = 'maya.chen@orchard.example'
  const source = 'https://orchard.example/team'
  const lead = {
    source_kind: 'discover',
    event_date: new Date().toISOString().slice(0, 10),
    event_date_proof: 'page_bound' as const,
    company_domain: 'orchard.example',
    name: 'Maya Chen',
    enrichments: [
      published('maya.chen@elsewhere.example', 'https://directory.example/orchard'),
      published(address, source),
    ],
  }
  assert.equal(discoverState(lead), 'ready_email')
  assert.deepEqual(discoverApprove(lead), { ok: true })
  assert.deepEqual(discoverContact(lead)?.email, { address, source })
})

test('a dated hiring lead with only a directory mailbox remains held', () => {
  const lead = {
    source_kind: 'discover',
    event_date: new Date().toISOString().slice(0, 10),
    event_date_proof: 'page_bound' as const,
    company_domain: 'harbor.example',
    name: 'Ari Flores',
    enrichments: [published('ari.flores@elsewhere.example', 'https://directory.example/harbor')],
  }
  assert.equal(discoverState(lead), 'no_contact')
  assert.equal(discoverApprove(lead).ok, false)
})

const tenant = 'ready-contact-workspace'
const jobId = 'ready-contact-scan'
const leadId = 'a'.repeat(24)
const companyDomain = 'orchard.example'
const workAddress = 'maya.chen@orchard.example'

function storedLead(t: TestContext) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  migrateAllSqlite(db)
  db.prepare(`INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller)
    VALUES (?, ?, 'Orchard', 'Services', '-', 'running', 'Companies hiring a coordinator', 'Scheduling software')`).run(jobId, tenant)
  const day = new Date().toISOString().slice(0, 10)
  db.prepare(`INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt,
    event_date, event_date_proof, date_status, source_kind, score, confidence, fit, intent)
    VALUES (?, ?, 'Maya Chen', 'Orchard', ?, 'Hiring a coordinator', 'https://orchard.example/jobs',
      'Orchard is hiring a coordinator', ?, 'page_bound', 'verified', 'discover', 85, 85, 4, 4)`)
    .run(leadId, jobId, companyDomain, day)
  for (const [index, row] of [
    published('maya.chen@elsewhere.example', 'https://directory.example/orchard'),
    published(workAddress, 'https://orchard.example/team'),
  ].entries()) addEnrichment(db, tenant, leadId, { ...row, confidence: null, source_date: day, retrieved_at: index + 1 })
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(jobId)
  return db
}

test('a stored Ready lead creates its draft for the same selected company mailbox', async t => {
  const db = storedLead(t)
  assert.equal((await discoverJobCounts(sqliteDb(db), tenant, jobId))?.ready_email, 1)
  createDraft(db, tenant, leadId, 'Scheduling software', { manual: true })
  assert.equal(db.prepare('SELECT to_email FROM outreach_messages WHERE tenant_id = ? AND lead_id = ?')
    .pluck().get(tenant, leadId), workAddress)
})

test('the Discovery export uses the same company mailbox as the Ready card', async t => {
  const db = storedLead(t)
  const fields = await discoverExportFields(sqliteDb(db), tenant, [{ lead_id: leadId, source_kind: 'discover', name: 'Maya Chen' }])
  assert.equal(fields.get(leadId)?.contact, workAddress)
})
