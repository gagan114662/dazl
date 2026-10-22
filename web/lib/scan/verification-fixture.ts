import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { fixtureAvailable, FixtureError } from '../outreach/test-fixture.ts'
import { TEST_INBOX } from '../outreach/service.ts'
import { migrateWarm } from '../warm/connections.ts'

// Test-only VERIFICATION fixture for the operator-designated test tenant. Lets the
// populated rendering of the right-people block (#135), source-quality metrics (#136)
// and warm paths (#137) be checked live without a paid scan, real contacts, network
// calls or any email. Same gating as the other test fixtures: OUTREACH_TEST_TENANT_ID
// plus the allowlisted test inbox.
//
// Every row is visibly test-only: names carry "(test only)", the signal and source URLs
// state dazl found and verified nothing. The fixture sequence is addressed to the
// allowlisted test inbox, is created already 'replied', and sends nothing. Idempotent.
// DELETE removes every row it created and nothing else.

export const VERIFICATION_FIXTURE_JOB = 'dazl verification fixture (test only)'
export const VERIFICATION_FIXTURE_LEAD = 'dazl verification fixture A (test only)'
const SRC = 'https://dazl.ai/test-only-verification-fixture'
const SIGNAL = 'Test-only fixture for verifying populated UI. Not a real company or person. dazl did not find, scrape or verify anything and claims no evidence.'

export const FIXTURE_CONTACTS = [
  { name: 'Ada Lovelace', title: 'Head of Sales Operations', linkedin: 'https://www.linkedin.com/in/dazl-test-ada' },
  { name: 'Grace Hopper', title: 'CRM Administrator', linkedin: 'https://www.linkedin.com/in/dazl-test-grace' },
  { name: 'Alan Turing', title: 'Staff Software Engineer', linkedin: null as string | null },
]

function fixtureIds(db: Database.Database, tenantId: string): { jobId: string; leadId: string } | null {
  const job = db.prepare('SELECT id FROM scan_jobs WHERE user_id = ? AND business_name = ? ORDER BY created_at DESC LIMIT 1').get(tenantId, VERIFICATION_FIXTURE_JOB) as { id: string } | undefined
  if (!job) return null
  const lead = db.prepare('SELECT id FROM leads WHERE scan_job_id = ? AND company = ? LIMIT 1').get(job.id, VERIFICATION_FIXTURE_LEAD) as { id: string } | undefined
  return lead ? { jobId: job.id, leadId: lead.id } : { jobId: job.id, leadId: '' }
}

export function createVerificationFixture(db: Database.Database, tenantId: string, now = Math.floor(Date.now() / 1000)): { jobId: string; leadId: string; created: boolean } {
  if (!fixtureAvailable(db, tenantId)) throw new FixtureError('test_tenant_only')
  const existing = fixtureIds(db, tenantId)
  if (existing?.leadId) return { ...existing, created: false } as { jobId: string; leadId: string; created: boolean }

  const jobId = randomBytes(12).toString('hex')
  const leadId = randomBytes(12).toString('hex')
  const today = new Date(now * 1000).toISOString().slice(0, 10)
  db.transaction(() => {
    db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, ?, 'test only', 'test only', 'running')").run(jobId, tenantId, VERIFICATION_FIXTURE_JOB)
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, fit, intent, action, source_kind, created_at) VALUES (?, ?, '', ?, NULL, ?, ?, 90, 4, 3, 3, 'test', ?)")
      .run(leadId, jobId, VERIFICATION_FIXTURE_LEAD, SIGNAL, SRC, now - 10 * 86400) // old enough to be outside the reply window
    const enr = db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, ?, 'apollo', 'contact', ?, 'Test fixture', 70, ?, ?, ?)")
    FIXTURE_CONTACTS.forEach((c, i) => enr.run(randomBytes(12).toString('hex'), leadId, tenantId, `${c.name} - ${c.title}`, c.linkedin ?? `${SRC}/team`, today, now))
    const run = db.prepare('INSERT INTO scan_source_runs (job_id, attempt, collector, status, evidence_count, candidate_count, verified_count, review_count, inserted_count) VALUES (?, 1, ?, ?, ?, ?, ?, 0, ?)')
    run.run(jobId, 'search:tinyfish', 'ok', 12, 12, 5, 1)
    run.run(jobId, 'adapter:reddit', 'ok', 4, 4, 2, 1)
    run.run(jobId, 'adapter:github', 'ok', 3, null, null, 0) // unobserved counters stay NULL -> '-'
    const ls = db.prepare('INSERT INTO lead_sources (lead_id, collector, attempt) VALUES (?, ?, 1)')
    ls.run(leadId, 'search:tinyfish'); ls.run(leadId, 'adapter:reddit')
    db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status, created_at) VALUES (?, ?, ?, ?, ?, 'replied', ?)")
      .run(randomBytes(12).toString('hex'), tenantId, leadId, `dazl-test-${randomBytes(6).toString('hex')}`, TEST_INBOX, now - 9 * 86400)
    db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(jobId)
  })()
  return { jobId, leadId, created: true }
}

export function deleteVerificationFixture(db: Database.Database, tenantId: string): { deleted: boolean } {
  if (!fixtureAvailable(db, tenantId)) throw new FixtureError('test_tenant_only')
  const ids = fixtureIds(db, tenantId)
  if (!ids) return { deleted: false }
  db.transaction(() => {
    if (ids.leadId) {
      db.prepare('DELETE FROM lead_enrichments WHERE lead_id = ?').run(ids.leadId)
      db.prepare('DELETE FROM lead_sources WHERE lead_id = ?').run(ids.leadId)
      db.prepare('DELETE FROM sequences WHERE tenant_id = ? AND lead_id = ?').run(tenantId, ids.leadId)
      migrateWarm(db)
      db.prepare('DELETE FROM warm_user_paths WHERE tenant_id = ? AND lead_id = ?').run(tenantId, ids.leadId)
      db.prepare('DELETE FROM leads WHERE id = ?').run(ids.leadId)
    }
    db.prepare('DELETE FROM scan_source_runs WHERE job_id = ?').run(ids.jobId)
    db.prepare('DELETE FROM scan_jobs WHERE id = ? AND user_id = ?').run(ids.jobId, tenantId)
  })()
  return { deleted: true }
}
