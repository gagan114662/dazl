import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createVerificationFixture, deleteVerificationFixture, FIXTURE_CONTACTS, VERIFICATION_FIXTURE_LEAD } from '../lib/scan/verification-fixture.ts'
import { sourceMetrics } from '../lib/scan/source-metrics.ts'
import { warmPathsForLead, importConnectionsCsv } from '../lib/warm/connections.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateSourceRuns } from '../lib/scan/source-runs.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateWarm } from '../lib/warm/connections.ts'
import { FixtureError } from '../lib/outreach/test-fixture.ts'
import { setTestAddresses } from '../lib/outreach/sequences.ts'
import { TEST_INBOX } from '../lib/outreach/service.ts'

const TEST_TENANT = 'dazl-verification-fixture-test-tenant'
process.env.OUTREACH_TEST_TENANT_ID = TEST_TENANT

function db(): Database.Database {
  const d = new Database(':memory:')
  migrateScan(d); migrateSourceRuns(d); migrateConnectors(d); migrateSequences(d); migrateWarm(d); migrateOutreach(d)
  setTestAddresses(d, TEST_TENANT, [TEST_INBOX])
  return d
}

test('fixture is gated to the designated test tenant', () => {
  const d = db()
  assert.throws(() => createVerificationFixture(d, 'someone-else'), FixtureError)
})

test('fixture populates source metrics and warm paths, is idempotent, cleanup removes it', () => {
  const d = db()
  const a = createVerificationFixture(d, TEST_TENANT)
  assert.equal(a.created, true)
  const b = createVerificationFixture(d, TEST_TENANT)
  assert.equal(b.created, false)
  assert.equal(a.leadId, b.leadId)

  // #136 source quality: collectors, NULL counters, overlap, replied sequence
  const rows = sourceMetrics(d, TEST_TENANT).rows
  const tf = rows.find(r => r.collector === 'search:tinyfish')!
  assert.deepEqual({ leads: tf.leads, graded: tf.icp_graded, strong: tf.strong_fit, outreach: tf.outreach_started, replied: tf.replied }, { leads: 1, graded: 1, strong: 1, outreach: 1, replied: 1 })
  const gh = rows.find(r => r.collector === 'adapter:github')!
  assert.equal(gh.candidates, null)
  assert.equal(gh.verified, null)

  // #135 contacts present with the expected names
  const contacts = (d.prepare("SELECT value FROM lead_enrichments WHERE lead_id = ? AND kind = 'contact'").all(a.leadId) as { value: string }[]).map(r => r.value)
  assert.equal(contacts.length, FIXTURE_CONTACTS.length)

  // #137 warm path via the REAL import path
  importConnectionsCsv(d, TEST_TENANT, 'First Name,Last Name,URL\nAda,Lovelace,https://www.linkedin.com/in/dazl-test-ada\n')
  const w = warmPathsForLead(d, TEST_TENANT, a.leadId)
  assert.equal(w.first_degree.length, 1)
  assert.equal(w.manual_check.length, 1) // grace; alan has no linkedin URL

  // cleanup removes the fixture, leaves the user's own import and unrelated rows
  const del = deleteVerificationFixture(d, TEST_TENANT)
  assert.equal(del.deleted, true)
  assert.equal(sourceMetrics(d, TEST_TENANT).rows.length, 0)
  assert.equal((d.prepare('SELECT COUNT(*) c FROM leads WHERE company = ?').get(VERIFICATION_FIXTURE_LEAD) as { c: number }).c, 0)
  assert.equal(warmPathsForLead(d, TEST_TENANT, a.leadId).imported_connections, 1) // import untouched
})
