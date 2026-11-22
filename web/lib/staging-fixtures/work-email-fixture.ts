import type Database from 'better-sqlite3'
import { fixtureAvailable, FixtureError } from './test-fixture.ts'
import { migrateWorkEmail, PENDING_STALE_S } from '../people/work-email.ts'
import { migrateWarm } from '../warm/connections.ts'
import { WORK_EMAIL_FIXTURE_COMPANY } from '../people/work-email-eligible.ts'

// Clean-up for the TEST-ONLY "Find work email" fixture lead earlier releases could create on the staging test tenant (#1036): it was
// clicked through against the staging fake People Data Labs and fake ZeroBounce. Find work email now gives only an address the company
// prints on its own site (#1036 / #1250), so no fixture is created any more; an existing one is found and removed with every row it had.
export const WORK_EMAIL_FIXTURE_JOB = 'dazl work-email fixture (test only)'

function fixtureLead(db: Database.Database, tenantId: string): { jobId: string; leadId: string } | null {
  const r = db.prepare(`SELECT j.id AS job_id, l.id AS lead_id FROM scan_jobs j JOIN leads l ON l.scan_job_id = j.id
    WHERE j.user_id = ? AND j.business_name = ? AND j.industry = 'test only' AND j.location = 'test only'
      AND l.company = ? AND l.source_kind = 'test' ORDER BY j.created_at, j.id LIMIT 1`)
    .get(tenantId, WORK_EMAIL_FIXTURE_JOB, WORK_EMAIL_FIXTURE_COMPANY) as { job_id: string; lead_id: string } | undefined
  return r ? { jobId: r.job_id, leadId: r.lead_id } : null
}

export function workEmailFixtureExists(db: Database.Database, tenantId: string): boolean {
  return !!fixtureLead(db, tenantId)
}

// Removes the fixture's job, lead and enrichments and the lookups stored for its lead. Only the test tenant may; nothing else is touched.
export function deleteWorkEmailFixture(db: Database.Database, tenantId: string): { deleted: boolean } {
  if (!fixtureAvailable(db, tenantId)) throw new FixtureError('test_tenant_only')
  const ids = fixtureLead(db, tenantId)
  if (!ids) return { deleted: false }
  migrateWorkEmail(db); migrateWarm(db)
  // A lookup still running on this lead (a fresh 'pending' row, or a mailbox check in flight) would finish against deleted rows:
  // refuse until it ends (xhawk review). A stale pending row (past PENDING_STALE_S) belongs to a lookup that died.
  const now = Math.floor(Date.now() / 1000)
  const inFlight = db.prepare("SELECT 1 FROM work_email_lookups WHERE tenant_id = ? AND lead_id = ? AND ((status = 'pending' AND updated_at >= ?) OR (mailbox_check = 'pending' AND COALESCE(mailbox_checked_at, 0) >= ?)) LIMIT 1")
    .get(tenantId, ids.leadId, now - PENDING_STALE_S, now - PENDING_STALE_S)
  if (inFlight) throw new FixtureError('lookup_in_flight')
  db.transaction(() => {
    db.prepare('DELETE FROM work_email_lookups WHERE tenant_id = ? AND lead_id = ?').run(tenantId, ids.leadId)
    // Rows the real panels next to it may have attached to this lead (warm paths, source credits).
    db.prepare('DELETE FROM warm_user_paths WHERE tenant_id = ? AND lead_id = ?').run(tenantId, ids.leadId)
    db.prepare('DELETE FROM lead_sources WHERE lead_id = ?').run(ids.leadId)
    db.prepare('DELETE FROM lead_enrichments WHERE tenant_id = ? AND lead_id = ?').run(tenantId, ids.leadId)
    db.prepare('DELETE FROM leads WHERE id = ? AND scan_job_id = ?').run(ids.leadId, ids.jobId)
    db.prepare('DELETE FROM scan_jobs WHERE id = ? AND user_id = ?').run(ids.jobId, tenantId)
  })()
  return { deleted: true }
}
