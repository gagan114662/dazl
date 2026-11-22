// #1036: the TEST-ONLY staging Find work email fixture is no longer created (Find work email gives only an address the company publishes
// on its own site, #1036 / #1250). A fixture an earlier release left behind is never looked up and its clean-up still removes it.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { setTestAddresses } from '../lib/outreach/sequences.ts'
import { TEST_INBOX } from '../lib/outreach/service.ts'
import { FixtureError } from '../lib/outreach/test-fixture.ts'
import { findWorkEmail, workEmailPageRead } from '../lib/people/work-email.ts'
import { deleteWorkEmailFixture, workEmailFixtureExists } from '../lib/scan/work-email-fixture.ts'
import { insertLegacyWorkEmailFixture, LEGACY_FIXTURE_TARGET } from './helpers/legacy-work-email-fixture.ts'

const T = 'work-email-fixture-tenant'
const STAGING = { DAZL_ENV: 'staging', DAZL_STAGING_FAKE_PDL: '1', DAZL_STAGING_FAKE_ZEROBOUNCE: '1', EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '5' }
const noNetwork = (calls: string[]) => (async (u: RequestInfo | URL) => { calls.push(String(u)); throw new Error(`no network in this test: ${String(u)}`) }) as typeof fetch

function setup() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  process.env.OUTREACH_TEST_TENANT_ID = T
  setTestAddresses(db, T, [TEST_INBOX])
  return db
}

test('#1036 a left-behind fixture lead is never looked up, even with the staging fakes on, and its stored fake answer is not shown', async () => {
  const db = setup(); const f = insertLegacyWorkEmailFixture(db, T); const calls: string[] = []
  const r = await findWorkEmail(db, T, f.leadId, LEGACY_FIXTURE_TARGET, { fetchImpl: noNetwork(calls), master: randomBytes(32), env: STAGING })
  assert.equal(r.status, 'not_eligible'); assert.equal('row' in r, false)
  assert.deepEqual(workEmailPageRead(db, T, [{ id: f.leadId }]).lookups[f.leadId], [])
  assert.equal(calls.length, 0)
  delete process.env.OUTREACH_TEST_TENANT_ID
})

test('#1036 fixture delete removes its job, lead, enrichments and the lookups stored for it, and nothing else', () => {
  const db = setup(); const f = insertLegacyWorkEmailFixture(db, T)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('keepjob', ?, 'Real play', 'software', 'US', 'done')").run(T)
  assert.equal(workEmailFixtureExists(db, T), true)
  assert.deepEqual(deleteWorkEmailFixture(db, T), { deleted: true })
  assert.equal(workEmailFixtureExists(db, T), false)
  const n = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n
  assert.equal(n('SELECT COUNT(*) AS n FROM leads WHERE id = ?', f.leadId), 0)
  assert.equal(n('SELECT COUNT(*) AS n FROM lead_enrichments WHERE lead_id = ?', f.leadId), 0)
  assert.equal(n('SELECT COUNT(*) AS n FROM work_email_lookups WHERE lead_id = ?', f.leadId), 0)
  assert.equal(n("SELECT COUNT(*) AS n FROM scan_jobs WHERE id = 'keepjob'"), 1, 'a real play is untouched')
  assert.deepEqual(deleteWorkEmailFixture(db, T), { deleted: false })
  delete process.env.OUTREACH_TEST_TENANT_ID
  assert.throws(() => deleteWorkEmailFixture(db, T), (e: unknown) => e instanceof FixtureError && e.code === 'test_tenant_only')
})

test('#1036 xhawk: removing the fixture while a lookup on it is still running is refused; a stale pending row does not block', () => {
  const db = setup(); const f = insertLegacyWorkEmailFixture(db, T)
  const now = Math.floor(Date.now() / 1000)
  db.prepare("UPDATE work_email_lookups SET status = 'pending', provider = NULL, address = NULL, updated_at = ? WHERE lead_id = ?").run(now, f.leadId)
  assert.throws(() => deleteWorkEmailFixture(db, T), (e: unknown) => e instanceof FixtureError && e.code === 'lookup_in_flight')
  assert.equal(workEmailFixtureExists(db, T), true, 'nothing was removed')
  db.prepare("UPDATE work_email_lookups SET mailbox_check = 'pending', mailbox_checked_at = ?, status = 'unverified', provider = 'pdl', address = 'staging-valid.testbuyer@x.test' WHERE lead_id = ?").run(now, f.leadId)
  assert.throws(() => deleteWorkEmailFixture(db, T), (e: unknown) => e instanceof FixtureError && e.code === 'lookup_in_flight', 'a mailbox check in flight blocks too')
  db.prepare('UPDATE work_email_lookups SET mailbox_checked_at = ?, updated_at = ? WHERE lead_id = ?').run(now - 10_000, now - 10_000, f.leadId)
  assert.deepEqual(deleteWorkEmailFixture(db, T), { deleted: true }, 'a stale in-flight row belongs to a lookup that died')
  delete process.env.OUTREACH_TEST_TENANT_ID
})
