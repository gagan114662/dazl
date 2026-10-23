// Cross-tenant isolation invariants, pinned so a refactor (e.g. the async data-layer
// port or a new store module) cannot silently drop a tenant filter. Every assertion
// here passes on the audited commit; a failure means tenant A can see or touch
// tenant B's data. See docs/security/tenant-isolation-assessment.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { countHiddenLeads, createJob, exportLeads, getJob, latestJobId, listJobs, listLeads, migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { approve, createDraft, editDraft, isSuppressed, OutreachError, readUnsubToken, skip, suppress, unsubscribeByToken, unsubToken } from '../lib/outreach/service.ts'
import { createMonitor, deleteMonitor, migrateMonitors, setMonitorEnabled } from '../lib/monitors.ts'
import { getKey, hasKey, keyStatus, migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migratePlans } from '../lib/plans.ts'

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const master = randomBytes(32)

const setup = () => {
  const db = new Database(':memory:')
  migrateScan(db)
  migratePlans(db)
  migrateOutreach(db)
  migrateMonitors(db)
  migrateKeys(db)
  return db
}

// A finished job for tenant A carrying one verified lead with a business contact.
const jobWithLead = (db: Database.Database) => {
  const jobId = createJob(db, A, { business_name: 'Acme', industry: 'saas', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare(
    "INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence, fit, intent) VALUES (?, ?, 'Pat', 'Acme', 'pat@acme-corp.com', 'hiring', 'https://acme-corp.com/jobs', 'we are hiring', 80, 4, 4)",
  ).run('cccccccccccccccccccccccc', jobId)
  // Test baseline is explicitly human-reviewed; no machine timing inference.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(jobId)
  return jobId
}

const code = (fn: () => unknown): string | null => {
  try { fn(); return null } catch (e) { return e instanceof OutreachError ? e.code : 'other' }
}

test('scan jobs, leads, hidden counts and exports are invisible across tenants', () => {
  const db = setup()
  const jobId = jobWithLead(db)
  assert.equal(getJob(db, A, jobId)?.id, jobId)
  assert.equal(getJob(db, B, jobId), undefined)
  assert.equal(listLeads(db, B, jobId).length, 0)
  assert.equal(countHiddenLeads(db, B, jobId), 0)
  assert.equal(exportLeads(db, B, jobId).length, 0)
  assert.equal(exportLeads(db, B).length, 0)
  assert.equal(latestJobId(db, B), undefined)
  assert.equal(listJobs(db, B).length, 0)
  assert.equal(listJobs(db, A).some(j => j.id === jobId), true)
})

test('outreach drafts cannot be read, approved, edited or skipped across tenants', () => {
  const db = setup()
  jobWithLead(db)
  const msgId = createDraft(db, A, 'cccccccccccccccccccccccc', 'Acme')
  // Tenant B gets the same not_found as a message that never existed.
  assert.equal(code(() => approve(db, B, msgId)), 'not_found')
  assert.equal(code(() => skip(db, B, msgId)), 'not_found')
  assert.equal(code(() => editDraft(db, B, msgId, { subject: 'hi there', body: 'this body is long enough to pass validation' })), 'not_found')
  // And the draft is untouched for tenant A after B's attempts.
  const row = db.prepare("SELECT status, subject FROM outreach_messages WHERE id = ? AND tenant_id = ?").get(msgId, A) as { status: string; subject: string }
  assert.equal(row.status, 'draft')
})

test('unsubscribe tokens are unforgeable and act only on the message tenant', () => {
  const db = setup()
  jobWithLead(db)
  const msgId = createDraft(db, A, 'cccccccccccccccccccccccc', 'Acme')
  const token = unsubToken(msgId, master)
  assert.equal(readUnsubToken(token, master), msgId)
  // Tampered id or signature, or a different master key, never resolves.
  assert.equal(readUnsubToken(`${'dddddddddddddddddddddddd'}.${token.split('.')[1]}`, master), null)
  assert.equal(readUnsubToken(`${msgId}.${'0'.repeat(32)}`, master), null)
  assert.equal(readUnsubToken(token, randomBytes(32)), null)
  assert.equal(unsubscribeByToken(db, token, randomBytes(32)), false)
  // The real token suppresses the recipient for tenant A only.
  assert.equal(unsubscribeByToken(db, token, master), true)
  assert.equal(isSuppressed(db, A, 'pat@acme-corp.com'), true)
  assert.equal(isSuppressed(db, B, 'pat@acme-corp.com'), false)
})

test('suppression lists are per-tenant', () => {
  const db = setup()
  suppress(db, A, 'someone@example.com', 'manual')
  assert.equal(isSuppressed(db, A, 'someone@example.com'), true)
  assert.equal(isSuppressed(db, B, 'someone@example.com'), false)
})

test('monitors cannot be enabled, disabled or deleted across tenants', () => {
  const db = setup()
  const r = createMonitor(db, A, { query: 'robotics companies hiring sales' })
  assert.ok('id' in r)
  assert.equal(setMonitorEnabled(db, B, r.id, false), false)
  assert.equal(deleteMonitor(db, B, r.id), false)
  // Tenant A's monitor is still there and still enabled.
  const m = db.prepare('SELECT enabled FROM monitors WHERE id = ? AND user_id = ?').get(r.id, A) as { enabled: number }
  assert.equal(m.enabled, 1)
})

test('LLM keys are invisible and unreadable across tenants', () => {
  const db = setup()
  saveKey(db, A, 'anthropic', 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', master)
  assert.deepEqual(keyStatus(db, B), [])
  assert.equal(hasKey(db, B), false)
  assert.equal(getKey(db, B, 'anthropic', master), null)
  assert.equal(getKey(db, A, 'anthropic', master), 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
})

test('export defaults to real rows, fixture rows require the explicit opt-in, and nothing is deleted', () => {
  const db = setup()
  jobWithLead(db)
  // A genuine business whose name happens to contain the fixture marker text: a
  // normal job (real industry/location), so its rows are real and must survive.
  const legitJob = createJob(db, A, { business_name: 'Legit (test only) Co', industry: 'saas', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(legitJob)
  db.prepare(
    "INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, confidence, fit, intent) VALUES (?, ?, 'Pat', 'Legit (test only) Co', null, 'Hiring AEs', 'https://news.com/legit', 80, 4, 4)",
  ).run('eeeeeeeeeeeeeeeeeeeeeeee', legitJob)
  // Test baseline is explicitly human-reviewed; no machine timing inference.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(legitJob)
  // A fixture job, using the fixture inserters' own job-level marker
  // (industry/location 'test only'); new fixture rows carry source_kind 'test'.
  const fixtureJob = createJob(db, A, { business_name: 'dazl verification fixture (test only)', industry: 'test only', location: 'test only' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(fixtureJob)
  db.prepare(
    "INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, confidence, fit, intent, source_kind) VALUES (?, ?, 'Fixture A (test only)', 'dazl fixture', null, 'dazl found and verified nothing (test only)', 'https://example.invalid/fixture', 0, 4, 4, 'test')",
  ).run('dddddddddddddddddddddddd', fixtureJob)
  // Test baseline is explicitly human-reviewed; no machine timing inference.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run()
  // An OLD fixture row, inserted before source_kind existed: untagged, and only
  // the migration's job-level provenance backfill can classify it.
  db.prepare(
    "INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, confidence, fit, intent) VALUES (?, ?, 'Fixture B (test only)', 'dazl fixture old', null, 'old fixture row', 'https://example.invalid/old', 0, 4, 4)",
  ).run('ffffffffffffffffffffffff', fixtureJob)
  // Test baseline is explicitly human-reviewed; no machine timing inference.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(fixtureJob)
  migrateScan(db) // idempotent re-run: the backfill classifies the old row

  const all = () => (db.prepare('SELECT count(*) AS n FROM leads').get() as { n: number }).n
  assert.equal(all(), 4, 'every row exists')
  assert.equal((db.prepare("SELECT source_kind FROM leads WHERE id = 'ffffffffffffffffffffffff'").get() as { source_kind: string }).source_kind, 'test', 'backfill marks the old fixture row by job provenance')

  const real = exportLeads(db, A) as { company: string }[]
  assert.deepEqual(real.map(r => r.company).sort(), ['Acme', 'Legit (test only) Co'], 'default export is real rows only - a genuine name containing the marker text is preserved')

  const withFixtures = exportLeads(db, A, undefined, 5000, true) as { company: string }[]
  assert.equal(withFixtures.length, 4, 'explicit opt-in includes the fixture rows')
  assert.ok(withFixtures.some(r => r.company === 'dazl fixture'))
  assert.ok(withFixtures.some(r => r.company === 'dazl fixture old'))

  const fixtureOnly = exportLeads(db, A, fixtureJob) as { company: string }[]
  assert.equal(fixtureOnly.length, 0, 'a fixture job id alone still defaults to real-only')
  assert.equal((exportLeads(db, A, fixtureJob, 5000, true) as { company: string }[]).length, 2, 'opt-in works per job too')

  assert.equal(all(), 4, 'every row is preserved - filtering is export-only, never deletion')
  db.close()
})
