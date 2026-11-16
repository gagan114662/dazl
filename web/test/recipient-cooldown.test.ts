// #855 (part of #727): a recipient contacted by play A is blocked in play B within the cooldown.
import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { approveBlockReason, createDraft, draftBlockReason } from '../lib/outreach/service.ts'

const DAY = 86400
const now = () => Math.floor(Date.now() / 1000)
function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); seedOffers(db); migrateConnectors(db)
  return db
}
// One lead in its own play (scan job), addressed to `contact`.
function playLead(db: Database.Database, tenant: string, contact: string, industry: string) {
  const job = createJob(db, tenant, { business_name: 'Acme', industry, location: 'Toronto' })
  const id = randomBytes(12).toString('hex')
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, fit, intent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, job, 'Northside Builders', contact, 'Hiring five roofers', 'https://news.example/a', 'Northside Builders is hiring five roofers', 85, null, null)
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE id=?").run(id)
  return id
}
const markSent = (db: Database.Database, msgId: string, at: number) =>
  db.prepare("UPDATE outreach_messages SET status = 'sent', sent_at = ? WHERE id = ?").run(at, msgId)

test('#855 AC-1: a recipient play A emailed yesterday cannot be drafted to from play B (recipient_cooldown)', () => {
  const db = setup()
  const a = playLead(db, 'A', 'info@northside.example', 'roofing')
  const b = playLead(db, 'A', 'INFO@northside.example', 'dental')
  markSent(db, createDraft(db, 'A', a, 'Acme'), now() - DAY)
  assert.equal(draftBlockReason(db, 'A', b), 'recipient_cooldown')
  assert.throws(() => createDraft(db, 'A', b, 'Acme'), /recipient_cooldown/)
})

test('#855 AC-2: a draft play B made before play A sent cannot be approved within the cooldown', () => {
  const db = setup()
  const a = playLead(db, 'A', 'info@northside.example', 'roofing')
  const b = playLead(db, 'A', 'info@northside.example', 'dental')
  const ma = createDraft(db, 'A', a, 'Acme')
  const mb = createDraft(db, 'A', b, 'Acme')
  assert.notEqual(approveBlockReason(db, 'A', mb, { skipAccount: true }), 'recipient_cooldown')
  markSent(db, ma, now() - 60)
  assert.equal(approveBlockReason(db, 'A', mb, { skipAccount: true }), 'recipient_cooldown')
})

test('#855 AC-3: outside the cooldown, another tenant, or a different recipient is not blocked', () => {
  const db = setup()
  const a = playLead(db, 'A', 'info@northside.example', 'roofing')
  markSent(db, createDraft(db, 'A', a, 'Acme'), now() - 31 * DAY)
  const b = playLead(db, 'A', 'info@northside.example', 'dental')
  assert.equal(draftBlockReason(db, 'A', b), null)
  const other = playLead(db, 'A', 'sales@southside.example', 'dental')
  assert.equal(draftBlockReason(db, 'A', other), null)
  const db2 = setup()
  const a2 = playLead(db2, 'A', 'info@northside.example', 'roofing')
  markSent(db2, createDraft(db2, 'A', a2, 'Acme'), now() - 60)
  const t2 = playLead(db2, 'B', 'info@northside.example', 'dental')
  assert.equal(draftBlockReason(db2, 'B', t2), null)
})
