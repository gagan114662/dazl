import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { setScanDb } from './sequence-route-db.ts'
import { migrateScan, createJob } from '../../lib/scan/store.ts'
import { migrateOutreach } from '../../lib/outreach/store.ts'
import { migrateMemory } from '../../lib/memory.ts'
import { migrateSequences, sequenceStepText, draftSequenceSteps } from '../../lib/outreach/sequences.ts'
import { migrateKeys, saveKey } from '../../lib/llm/key-store.ts'
import { providers } from '../../lib/llm/provider.ts'
import { createDraft } from '../../lib/outreach/service.ts'
import { confirmLeadReview } from '../../lib/scan/review-confirm.ts'
import { NextRequest } from 'next/server'
import { POST } from '../../app/api/outreach/sequences/route.ts'

// Runtime route regression with dummy credentials and all provider/network calls stubbed.
const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64') // synthetic test key only

const completeCalls: string[] = []
for (const [name, p] of Object.entries(providers)) {
  if (p.complete) {
    p.complete = async () => { completeCalls.push(name); return 'A synthetic follow-up body used only for the paid-path sensitivity check.' }
  }
}
const fetchCalls: string[] = []
globalThis.fetch = (async (u: unknown, i?: RequestInit) => { fetchCalls.push(String(u)); throw new Error('Unexpected network attempt in sequence-create test') }) as typeof fetch

test('route create action bills no provider and stores draft templates', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateSequences(db); migrateKeys(db); migrateMemory(db)
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'roofing', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, review_reason, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    lead, job, 'Acme Roofing', 'lead@acme.example', 'Acme Roofing is hiring five roofers', 'https://news.example/a',
    'Acme Roofing is hiring five roofers', null, 'quote_unconfirmed', 70)
  confirmLeadReview(db, 'A', lead)
  const draftId = createDraft(db, 'A', lead, 'Acme')
  const draftBody = (db.prepare('SELECT body FROM outreach_messages WHERE id = ?').get(draftId) as { body: string }).body
  // A configured BYOK key: if creation secretly drafted with AI, a provider would be called NOW.
  saveKey(db, 'A', 'anthropic', 'sk-ant-synthetic-test-key')
  setScanDb(db)

  const req = new NextRequest('http://localhost/api/outreach/sequences', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'create', message_id: draftId }),
  })
  const res = await POST(req)
  assert.equal(res.status, 200)
  const body = await res.json() as { id: string }
  assert.ok(body.id)

  assert.deepEqual(completeCalls, [], 'no provider.complete call during sequence create')
  assert.deepEqual(fetchCalls, [], 'no fetch of any kind during sequence create')

  const seq = db.prepare('SELECT status FROM sequences WHERE id = ?').get(body.id) as { status: string }
  assert.equal(seq.status, 'draft')
  const steps = db.prepare('SELECT step, subject, body, status, approved_hash FROM sequence_steps WHERE sequence_id = ? ORDER BY step').all(body.id) as { step: number; subject: string; body: string; status: string; approved_hash: string | null }[]
  assert.equal(steps.length, 3)
  for (const s of steps) { assert.equal(s.status, 'draft'); assert.equal(s.approved_hash, null) }
  assert.equal(steps[0].body, draftBody) // step 1 = the approved-message draft verbatim
  const leadRow = { company: 'Acme Roofing', name: null as unknown as string, signal: 'Acme Roofing is hiring five roofers', source_url: 'https://news.example/a' }
  assert.equal(steps[1].body, sequenceStepText(2, leadRow, 'Acme', undefined))
  assert.equal(steps[2].body, sequenceStepText(3, leadRow, 'Acme', undefined))
  // Sensitivity control: the old optional rewrite path really triggers the spy twice.
  // This calls only the in-memory stub above, never a real provider or fetch.
  await draftSequenceSteps(db, 'A', body.id, 'Acme')
  assert.equal(completeCalls.length, 2, 'provider trap detects both paid-path rewrites')
  assert.deepEqual(fetchCalls, [], 'sensitivity control remains network-free')
  db.close()

})
