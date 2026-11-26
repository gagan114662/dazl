import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { POST as draft } from '../../app/api/outreach/route.ts'
import { POST as act } from '../../app/api/outreach/[id]/route.ts'
import { addEnrichment } from '../../lib/connectors/store.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { saveSettings } from '../../lib/outreach/service.ts'
import { setScanDb } from './sequence-route-db.ts'

const tenant = 'A'
const job = 'a'.repeat(24)
const indexLead = 'b'.repeat(24)
const datedLead = 'c'.repeat(24)
const oldDraft = 'd'.repeat(24)
const now = Math.floor(Date.now() / 1000)
const day = new Date((now - 86_400) * 1000).toISOString().slice(0, 10)
const db = new Database(':memory:')

function request(path: string, body: object) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}
const create = (lead_id: string) => draft(request('/api/outreach', { lead_id }))
const actOnDraft = (id: string, action: 'approve' | 'send') =>
  act(request(`/api/outreach/${id}`, { action }), { params: Promise.resolve({ id }) })

try {
  migrateAllSqlite(db)
  setScanDb(db)
  saveSettings(db, tenant, { sender_name: 'Test Sender', postal_address: '100 Fixture Street, Unit 2' })
  db.prepare('INSERT INTO gmail_accounts (tenant_id, email, refresh_ct) VALUES (?, ?, ?)').run(tenant, 'sender@example.test', 'fixture-unused')
  db.prepare(`INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, seller)
    VALUES (?, ?, 'Workspace', 'services', '-', 'Companies opening another site', 'running', 'We provide commercial fit-outs')`).run(job, tenant)

  for (const [id, proof, note] of [
    [indexLead, null, 'The page prints no date. This is the day the search index dates the page.'],
    [datedLead, 'page_bound', null],
  ] as const) {
    db.prepare(`INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt,
      event_date, event_date_proof, date_status, timing_note, source_kind, score, confidence, fit, intent)
      VALUES (?, ?, 'Lee Rivera', 'Buyer fixture', 'buyer.example', 'Opening another site', 'https://buyer.example/news',
        'Opening another site', ?, ?, 'unverified', ?, 'discover', 85, 85, 4, 4)`).run(id, job, day, proof, note)
    for (const [kind, value] of [['person', 'Lee Rivera, Owner'], ['email', 'lee.rivera@buyer.example']]) {
      addEnrichment(db, tenant, id, { kind, value, connector: 'discover', label: 'published on a public page',
        confidence: null, source_url: 'https://buyer.example/team', source_date: day, retrieved_at: now })
    }
  }
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)

  const refused = await create(indexLead)
  assert.equal(refused.status, 409)
  assert.equal((await refused.json()).code, 'lead_currentness_unconfirmed')
  assert.equal(db.prepare('SELECT id FROM outreach_messages WHERE lead_id = ?').get(indexLead), undefined)

  db.prepare(`INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body)
    VALUES (?, ?, ?, 'lee.rivera@buyer.example', 'Existing draft', 'This unsent draft was saved before the date was checked.')`).run(oldDraft, tenant, indexLead)
  const blocked = await actOnDraft(oldDraft, 'approve')
  assert.equal(blocked.status, 409)
  assert.equal((await blocked.json()).error, 'lead_currentness_unconfirmed')
  const message = db.prepare('SELECT status, approved_hash, sent_at FROM outreach_messages WHERE id = ?')
  assert.deepEqual(message.get(oldDraft), { status: 'draft', approved_hash: null, sent_at: null })

  const created = await create(datedLead)
  assert.equal(created.status, 201, await created.clone().text())
  const { id } = await created.json() as { id: string }
  const approved = await actOnDraft(id, 'approve')
  assert.equal(approved.status, 200, await approved.clone().text())
  const saved = message.get(id) as { status: string; approved_hash: string | null; sent_at: number | null }
  assert.equal(saved.status, 'approved')
  assert.ok(saved.approved_hash)
  assert.equal(saved.sent_at, null)

  db.prepare('UPDATE leads SET event_date_proof = NULL, timing_note = ? WHERE id = ?')
    .run('The page prints no date. This is the day the search index dates the page.', datedLead)
  const send = await actOnDraft(id, 'send')
  assert.equal(send.status, 409, await send.clone().text())
  assert.equal((await send.json()).error, 'lead_currentness_unconfirmed')
  assert.deepEqual(message.get(id), saved)
} finally {
  db.close()
}
