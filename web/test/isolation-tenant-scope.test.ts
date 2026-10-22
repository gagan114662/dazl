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
