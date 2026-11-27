import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { addEnrichment } from '../../lib/connectors/store.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { discoverJobCounts } from '../../lib/discover/state-db.ts'
import { homeReady } from '../../lib/outreach/home-ready.ts'
import { setScanDb } from './tenant-route-db.ts'

const now = Math.floor(Date.now() / 1000)
const day = new Date((now - 86_400) * 1000).toISOString().slice(0, 10)
const tenant = 'contact-channels-fixture'
const job = 'a'.repeat(24)
const profile = 'https://www.linkedin.com/in/lee-rivera/'
const db = new Database(':memory:')

try {
  migrateAllSqlite(db)
  setScanDb(db)
  db.prepare(`INSERT INTO scan_jobs
    (id, user_id, business_name, industry, location, query, status)
    VALUES (?, ?, 'Workspace', 'services', '-', 'Companies opening another site', 'running')`).run(job, tenant)
  const insert = db.prepare(`INSERT INTO leads
    (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, event_date,
      event_date_proof, source_kind, score, confidence, fit, intent, created_at)
    VALUES (?, ?, 'Lee Rivera', ?, ?, 'Opening another site', ?, 'Opening another site', ?, ?, 'discover', 85, 85, 4, 4, ?)`)
  for (const [id, company, dated, linkedin] of [
    ['personal', 'Personal profile fixture', true, profile],
    ['work-email', 'Warehouse expansion fixture', true, profile],
    ['company', 'Shared contact fixture', true, 'https://www.linkedin.com/company/shared-fixture/'],
    ['undated', 'Undated signal fixture', false, profile],
  ] as const) {
    const domain = `${id}.example`
    insert.run(id, job, company, domain, `https://${domain}/news`, dated ? day : null, dated ? 'page_bound' : null, now)
    const add = (kind: string, value: string) => addEnrichment(db, tenant, id, {
      kind, value, connector: 'discover', label: kind === 'email' && id === 'work-email' ? 'published on a public page' : null, confidence: null,
      source_url: `https://${domain}/team`, source_date: day, retrieved_at: now,
    })
    add('person', 'Lee Rivera, Owner')
    add('linkedin', linkedin)
    if (id === 'work-email') add('email', `lee.rivera@${domain}`)
    if (id === 'company') add('email', `info@${domain}`)
  }
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)

  assert.deepEqual(await discoverJobCounts(sqliteDb(db), tenant, job), {
    found: 4, ready: 1, ready_email: 1, ready_linkedin: 0,
    no_contact: 2, review: 0, research: 1, rejected: 0,
  })
  const home = await homeReady(tenant, now)
  assert.equal(home.judged, 4)
  assert.equal(home.ready, 1)
  assert.deepEqual(home.scans, [{ job_id: job, ready: 1 }])
  const ready = home.companies.filter(company => company.ready)
  assert.deepEqual(ready.map(company => company.lead_id), ['work-email'])
  assert.equal(ready[0].details?.contact_name, 'Lee Rivera')
  assert.equal(ready[0].details?.email, 'lee.rivera@work-email.example')
  assert.equal(home.companies.find(company => company.lead_id === 'personal')?.reason, 'no contact found yet')
  assert.equal(home.companies.find(company => company.lead_id === 'company')?.reason, 'no contact found yet')
  assert.equal(home.companies.find(company => company.lead_id === 'undated')?.reason, 'the signal has no date, so its timing is unknown')
} finally {
  db.close()
}
