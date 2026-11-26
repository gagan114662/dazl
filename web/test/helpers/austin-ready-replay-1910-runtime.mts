import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { homeReady } from '../../lib/outreach/home-ready.ts'
import { AUSTIN_JOB_ID, AUSTIN_LEADS, seedAustinJob } from '../fixtures/austin-0e6a919e.ts'
import { setScanDb, setUser } from './tenant-route-db.ts'

const tenant = 'A'
const now = Date.parse('2026-11-26T15:00:00Z') / 1000
const target = AUSTIN_LEADS.find(lead => lead.company_domain && lead.name && !lead.event_date)
assert.ok(target, 'the baseline has a named buyer whose hiring date was unverified')

const db = new Database(':memory:')
try {
  migrateAllSqlite(db)
  setScanDb(db)
  setUser({ id: tenant, business_name: 'Acme' })
  seedAustinJob(db, tenant, now)
  const before = await homeReady(tenant, now)
  assert.equal(before.ready, 0)
  assert.equal(before.judged, AUSTIN_LEADS.length)

  // Simulate only the persisted proof for an exact, dated first-party posting.
  // The replay does not assert that this posting was recovered in production.
  db.prepare(`UPDATE leads
    SET source_url = ?, event_date = '2026-11-25', date_status = 'verified',
      event_date_proof = 'page_bound', review_reason = NULL
    WHERE id = ? AND scan_job_id = ?`)
    .run(`https://${target.company_domain}/careers/fixture-posting`, target.id, AUSTIN_JOB_ID)

  const after = await homeReady(tenant, now)
  const ready = after.companies.filter(lead => lead.ready)
  assert.deepEqual(ready.map(lead => lead.lead_id), [target.id])
  assert.equal(after.ready, 1)
  assert.deepEqual(after.scans, [{ job_id: AUSTIN_JOB_ID, ready: 1 }])
  assert.equal(ready[0]?.details?.contact_name, target.name)
  assert.equal(ready[0]?.details?.day_verified, true)
  assert.deepEqual(after.companies.filter(lead => lead.lead_id !== target.id),
    before.companies.filter(lead => lead.lead_id !== target.id))
} finally {
  db.close()
}
