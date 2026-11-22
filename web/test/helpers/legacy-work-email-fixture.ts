// The rows an earlier release's staging Find work email fixture left on the test tenant (#1036): a labelled test-only job and lead on a
// settled site with buyer-role people, and a lookup the staging fake People Data Labs answered. No fixture is created any more; these
// tests prove an existing one is refused a lookup and removed by its clean-up. Synthetic rows only.
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { WORK_EMAIL_FIXTURE_JOB } from '../../lib/scan/work-email-fixture.ts'
import { WORK_EMAIL_FIXTURE_COMPANY } from '../../lib/people/work-email-eligible.ts'

export const LEGACY_FIXTURE_TARGET = 'Valid Testbuyer|Owner'
export function insertLegacyWorkEmailFixture(db: Database.Database, tenantId: string, now = Math.floor(Date.now() / 1000)): { jobId: string; leadId: string } {
  const jobId = randomBytes(12).toString('hex'), leadId = randomBytes(12).toString('hex'), site = 'workemail-fixture.test'
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, ?, 'test only', 'test only', 'running')").run(jobId, tenantId, WORK_EMAIL_FIXTURE_JOB)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, source_kind, created_at) VALUES (?, ?, '', ?, 'test only', ?, 'test', ?)")
    .run(leadId, jobId, WORK_EMAIL_FIXTURE_COMPANY, `https://${site}/`, now)
  const enr = db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, ?, 'sitecrawl', ?, ?, ?, 70, ?, '2026-11-13', ?)")
  enr.run(randomBytes(12).toString('hex'), leadId, tenantId, 'domain', `${site}|evidence_own_domain`, 'domain-basis-v1:evidence_own_domain', `https://${site}/`, now)
  enr.run(randomBytes(12).toString('hex'), leadId, tenantId, 'person', 'Valid Testbuyer, Owner', 'Test fixture', `https://${site}/team`, now)
  db.prepare("INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, updated_at) VALUES (?, ?, ?, 'unverified', 'pdl', ?, ?)")
    .run(tenantId, leadId, LEGACY_FIXTURE_TARGET, `staging-valid.testbuyer@${site}`, now)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(jobId)
  return { jobId, leadId }
}
