import { test } from 'node:test'
import { sqliteDb } from '../lib/db/client.ts'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createVerificationFixture, deleteVerificationFixture, FIXTURE_CONTACTS, FIXTURE_REPLY, VERIFICATION_FIXTURE_LEAD } from '../lib/scan/verification-fixture.ts'
import { sourceMetrics } from '../lib/scan/source-metrics.ts'
import { warmPathsForLead, importConnectionsCsv } from '../lib/warm/connections.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateSourceRuns } from '../lib/scan/source-runs.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateWarm } from '../lib/warm/connections.ts'
import { migrateReplies, classifyReply } from '../lib/outreach/replies.ts'
import { FixtureError } from '../lib/outreach/test-fixture.ts'
import { setTestAddresses } from '../lib/outreach/sequences.ts'
import { TEST_INBOX } from '../lib/outreach/service.ts'

const TEST_TENANT = 'dazl-verification-fixture-test-tenant'
process.env.OUTREACH_TEST_TENANT_ID = TEST_TENANT

function db(): Database.Database {
  const d = new Database(':memory:')
  migrateScan(d); migrateSourceRuns(d); migrateConnectors(d); migrateSequences(d); migrateWarm(d); migrateOutreach(d); migrateReplies(d)
  setTestAddresses(d, TEST_TENANT, [TEST_INBOX])
  return d
}

test('fixture is gated to the designated test tenant', async () => {
  const d = db()
  assert.throws(() => createVerificationFixture(d, 'someone-else'), FixtureError)
})

test('fixture populates source metrics and warm paths, is idempotent, cleanup removes it', async () => {
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

  // reply -> meeting handoff: one positive synthetic inbound reply on a full thread
  const ib = d.prepare("SELECT thread_id, classification, excerpt FROM inbound_messages WHERE tenant_id = ? AND gmail_id LIKE 'dazl-test-in-%'").all(TEST_TENANT) as { thread_id: string; classification: string; excerpt: string }[]
  assert.equal(ib.length, 1)
  assert.equal(ib[0].classification, 'positive')
  assert.equal(classifyReply(FIXTURE_REPLY), 'positive') // the fixture reply classifies positive by the real rules
  assert.ok(ib[0].excerpt.length <= 200)
  const th = d.prepare("SELECT root_message_id, stopped FROM followup_threads WHERE tenant_id = ? AND thread_id = ?").get(TEST_TENANT, ib[0].thread_id) as { root_message_id: string; stopped: string | null }
  assert.ok(th.root_message_id.startsWith('dazl-test-om-'))
  const om = d.prepare("SELECT status, subject FROM outreach_messages WHERE tenant_id = ? AND id = ?").get(TEST_TENANT, th.root_message_id) as { status: string; subject: string }
  assert.equal(om.status, 'sent')

  // #137 warm path via the REAL import path
  await importConnectionsCsv(sqliteDb(d), TEST_TENANT, 'First Name,Last Name,URL\nAda,Lovelace,https://www.linkedin.com/in/dazl-test-ada\n')
  const w = await warmPathsForLead(sqliteDb(d), TEST_TENANT, a.leadId)
  assert.equal(w.first_degree.length, 1)
  assert.equal(w.manual_check.length, 1) // grace; alan has no linkedin URL

  // #148 review-lane row: job_closed present, test-only, not in the visible lead list
  const rev = d.prepare("SELECT company, review_reason FROM leads WHERE scan_job_id = ? AND review_reason IS NOT NULL").all(a.jobId) as { company: string; review_reason: string }[]
  assert.deepEqual(rev, [{ company: 'dazl verification fixture closed job (test only)', review_reason: 'job_closed' }])
  assert.ok(rev[0].company.includes('(test only)'))

  // cleanup removes the fixture, leaves the user's own import and unrelated rows
  const del = deleteVerificationFixture(d, TEST_TENANT)
  assert.equal(del.deleted, true)
  assert.equal(sourceMetrics(d, TEST_TENANT).rows.length, 0)
  assert.equal((d.prepare('SELECT COUNT(*) c FROM leads WHERE company = ?').get(VERIFICATION_FIXTURE_LEAD) as { c: number }).c, 0)
  assert.equal((d.prepare("SELECT COUNT(*) c FROM leads WHERE review_reason = 'job_closed'").get() as { c: number }).c, 0)
  assert.equal((await warmPathsForLead(sqliteDb(d), TEST_TENANT, a.leadId)).imported_connections, 1) // import untouched
  // cleanup removes the synthetic thread rows too
  for (const q of ["SELECT COUNT(*) c FROM inbound_messages WHERE gmail_id LIKE 'dazl-test-in-%'",
                   "SELECT COUNT(*) c FROM followup_threads WHERE thread_id LIKE 'dazl-test-thread-%'",
                   "SELECT COUNT(*) c FROM outreach_messages WHERE id LIKE 'dazl-test-om-%'"])
    assert.equal((d.prepare(q).get() as { c: number }).c, 0)
})
