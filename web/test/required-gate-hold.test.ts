// A REQUIRED gate that failed (the sales-hiring check) is a hold that lead / domain confirmation cannot clear. Real confirmation + draft-gate functions, isolated stubbed database, no
// network, no draft sent. The control (a lead in ordinary review) is unblocked by confirmation exactly as before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { seedOffers } from './helpers/seed-offer.ts'
import { confirmLeadReview } from '../lib/scan/review-confirm.ts'
import { setDomainReview } from '../lib/scan/domain-review-action.ts'
import { createDraft } from '../lib/outreach/service.ts'
import { currentnessHeld } from '../lib/outreach/currentness.ts'
import { requiredGateHeld } from '../lib/scan/held-state.ts'

function setup() { const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); seedOffers(db); return db }
function addLead(db: Database.Database, o: { reason: string | null; confidence?: number | null }) {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'SaaS', location: 'London' })
  const id = randomBytes(12).toString('hex')
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id, scan_job_id, company, company_domain, contact, signal, source_url, evidence_excerpt, confidence, review_reason, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, job, 'Northside Builders', 'northside.example', 'info@northside.example', 'Northside Builders raised a seed round', 'https://news.example/a', 'Northside Builders raised a seed round', o.confidence ?? null, o.reason, 70)
  return id
}
const mark = (db: Database.Database, leadId: string) => db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'scan:gate', 'gate_failed', 'sales_hiring_check_failed', 'x', NULL, 'https://invalid.example/', '2026-10-28', 1)").run(randomBytes(12).toString('hex'), leadId)

test('CONTROL: a lead in ordinary review becomes draftable after the user confirms it', () => {
  const db = setup(); const id = addLead(db, { reason: 'quote_unconfirmed' })
  assert.equal(requiredGateHeld(db, 'A', id), null); assert.throws(() => createDraft(db, 'A', id, 'Acme'), /lead_not_verified/)
  assert.equal(confirmLeadReview(db, 'A', id), true)
  assert.equal(typeof createDraft(db, 'A', id, 'Acme'), 'string', 'confirmation unblocks drafting when no required gate failed')
})

test('a lead held by the FAILED sales-hiring gate stays blocked through lead confirmation and domain confirmation', () => {
  const db = setup(); const id = addLead(db, { reason: 'sales_hiring_check_failed' })
  assert.throws(() => createDraft(db, 'A', id, 'Acme'), /lead_not_verified|sales_hiring_check_failed/)
  assert.equal(confirmLeadReview(db, 'A', id), true, 'the user can still confirm the lead (it moves out of review)')
  assert.equal(requiredGateHeld(db, 'A', id), 'sales_hiring_check_failed', 'the reason it was confirmed FROM still holds')
  try { setDomainReview(db, 'A', id, 'confirm') } catch { /* the website confirmation may be refused for other reasons: the hold must hold either way */ }
  assert.throws(() => createDraft(db, 'A', id, 'Acme'), /sales_hiring_check_failed/, 'drafting stays blocked with the failed gate as the reason')
  assert.equal(currentnessHeld(db, 'A', id), true, 'approve / send / sequences / follow-ups use the same hold')
})

test('WRITE-REJECTED: the row still reads verified, only the gate_failed marker holds it - confirmation (lead and domain) still cannot unblock drafting', () => {
  const db = setup(); const id = addLead(db, { reason: null, confidence: 80 })
  mark(db, id)
  assert.equal(requiredGateHeld(db, 'A', id), 'sales_hiring_check_failed')
  assert.throws(() => createDraft(db, 'A', id, 'Acme'), /sales_hiring_check_failed/, 'verified-looking row, held by the marker')
  assert.equal(confirmLeadReview(db, 'A', id), true)   // a verified row can be human-confirmed too
  try { setDomainReview(db, 'A', id, 'confirm') } catch { /* see above */ }
  assert.throws(() => createDraft(db, 'A', id, 'Acme'), /sales_hiring_check_failed/)
  assert.equal(currentnessHeld(db, 'A', id), true)
})

test('tenant scope: another tenant’s lead id is never reported held', () => {
  const db = setup(); const id = addLead(db, { reason: 'sales_hiring_check_failed' })
  assert.equal(requiredGateHeld(db, 'B', id), null)
})
