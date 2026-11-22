// Launch blockers from the staging check (#1571): a discovery lead's person shows on its row and card, and a person can approve it
// (a draft email to review; nothing is sent) when a public page prints an email for it. Autopilot keeps every older check.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { addEnrichment } from '../lib/connectors/store.ts'
import { leadPerson } from '../lib/people/lead-person.ts'
import { leadCardSummary } from '../lib/scan/lead-card.ts'
import { createDraft, OutreachError } from '../lib/outreach/service.ts'

const person = { connector: 'discover', kind: 'person', value: 'Dana Ruiz, Practice Owner', label: 'named on a public page', source_url: 'https://northwind-dental.example/team' }
const email = { connector: 'discover', kind: 'email', value: 'dana@northwind-dental.example', label: 'published on a public page', source_url: 'https://northwind-dental.example/contact' }
const linkedin = { connector: 'discover', kind: 'linkedin', value: 'https://www.linkedin.com/in/dana-ruiz/', label: 'linked from a public page', source_url: 'https://northwind-dental.example/team' }
const lead = (enrichments: unknown[], o: Record<string, unknown> = {}) => ({ id: 'a'.repeat(24), company: 'Northwind Dental', name: 'Dana Ruiz', signal: 'Opening a second clinic', source_url: 'https://news.example/northwind', evidence_excerpt: 'Northwind Dental will open its second clinic', event_date: '2026-10-14', date_status: 'verified', review_reason: null, fit: 4, intent: 4, why: 'expanding', icp_match: null, company_domain: 'northwind-dental.example', contact: null, confidence: 85, source_kind: 'discover', enrichments, ...o })

test('the row names the person the run found, with their LinkedIn and the page that names them', () => {
  const p = leadPerson([person, linkedin, email], '')
  assert.deepEqual(p && [p.name, p.title, p.linkedin, p.source], ['Dana Ruiz', 'Practice Owner', 'https://www.linkedin.com/in/dana-ruiz/', 'https://northwind-dental.example/team'])
  assert.equal(leadPerson([{ ...person, value: 'Dana, Owner' }], ''), null, 'a bare first name is not a named person')
  assert.equal(leadPerson([{ ...person, connector: 'apollo' }], ''), null, 'only the discovery run\'s own rows take this path')
})

test('the card shows the person and the email, and Approve is on when a public page prints an email', () => {
  const c = leadCardSummary(lead([person, linkedin, email]) as never)
  assert.equal(c.contact, 'Dana Ruiz, Practice Owner - dana@northwind-dental.example')
  assert.deepEqual(c.approve, { ok: true })
  const noEmail = leadCardSummary(lead([person, linkedin]) as never)
  assert.equal(noEmail.contact, 'Dana Ruiz, Practice Owner')
  assert.deepEqual(noEmail.approve, { ok: false, reason: 'No email address is published for this lead. Reach them through their LinkedIn profile.' })
  assert.equal(leadCardSummary(lead([person, email], { review_reason: 'source_review_required' }) as never).approve.ok, false, 'an unconfirmed proof page is reviewed first')
  assert.equal(leadCardSummary(lead([person, email], { quarantined_at: 1 }) as never).approve.ok, false)
})

test('Approve creates a draft for the published address; autopilot and calibration still get every older check', () => {
  process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller) VALUES ('j1', 'T', 'b', 'i', 'l', 'running', 'Dental clinics opening a new location', 'Clinic fit-out contractor')").run()
  const id = 'b'.repeat(24)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, evidence_excerpt, event_date, date_status, confidence, fit, intent, why, source_kind, company_domain) VALUES (?, 'j1', 'Dana Ruiz', 'Northwind Dental', 'Opening a second clinic', 'https://news.example/northwind', 85, 'Northwind Dental will open its second clinic', '2026-10-14', 'verified', 85, 4, 4, 'expanding', 'discover', 'northwind-dental.example')").run(id)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j1'").run()
  const now = Math.floor(Date.now() / 1000)
  const code = (fn: () => unknown) => { try { fn(); return 'created' } catch (e) { if (e instanceof OutreachError) return e.code; throw e } }
  assert.equal(code(() => createDraft(db, 'T', id, 'Fit-out Co', { manual: true })), 'no_email_contact', 'no published email yet: nothing to draft to')
  addEnrichment(db, 'T', id, { ...person, confidence: null, source_date: '2026-11-22', retrieved_at: now })
  addEnrichment(db, 'T', id, { ...email, confidence: null, source_date: '2026-11-22', retrieved_at: now })
  assert.notEqual(code(() => createDraft(db, 'T', id, 'Fit-out Co')), 'created', 'without a person asking, the older checks decide')
  assert.equal(code(() => createDraft(db, 'T', id, 'Fit-out Co', { manual: true })), 'created')
  const draft = db.prepare("SELECT to_email, status FROM outreach_messages WHERE tenant_id = 'T' AND lead_id = ?").get(id) as { to_email: string; status: string }
  assert.equal(draft.to_email, 'dana@northwind-dental.example')
  assert.equal(code(() => createDraft(db, 'OTHER', id, 'x', { manual: true })), 'not_found', 'another workspace cannot draft to this lead')
})

test('the scheduler enrols a first search into a repeat only when the operator switch is on', () => {
  const src = readFileSync(new URL('../app/api/internal/tick/route.ts', import.meta.url), 'utf8')
  assert.ok(src.includes("if (process.env.DAZL_FIRST_PLAY_REPEAT === '1') try { firstPlayRepeats = (await repeatFirstPlays("))
})
