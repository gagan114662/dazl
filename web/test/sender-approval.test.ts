// #370 (first slice): an approval is for the Gmail address connected when it was given. Changing the sender
// invalidates it: connecting another account sends every waiting approval back to draft, the send claim refuses one
// approved for another address, and a disconnect binds older approvals to the departing address. The same address
// reconnecting keeps them. Tenant-scoped. Gmail and Google are stubbed; nothing leaves the process.
import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { completeOAuth, disconnectGmail, startOAuth } from '../lib/gmail/oauth.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { approve, createDraft, OutreachError, saveSettings, sendBlockReason, sendMessage, type Deps } from '../lib/outreach/service.ts'

const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateSequences(db); seedOffers(db); migrateConnectors(db)
  return db
}
function addLead(db: Database.Database, tenant: string, o: Partial<{ contact: string | null; evidence: string | null; confidence: number | null; fit: number | null; intent: number | null }> = {}) {
  const job = createJob(db, tenant, { business_name: 'Acme', industry: 'roofing', location: 'Toronto' })
  const id = randomBytes(12).toString('hex')
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, fit, intent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, job, 'Northside Builders', 'contact' in o ? o.contact : 'info@northside.example', 'Hiring five roofers', 'https://news.example/a',
    'evidence' in o ? o.evidence : 'Northside Builders is hiring five roofers', 'confidence' in o ? o.confidence : 85,
    'fit' in o ? o.fit : null, 'intent' in o ? o.intent : null)
  // Explicit human review is the eligible baseline for unrelated send tests.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE id=? AND confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run(id)
  return id
}
const idToken = (email: string, verified = true) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: verified })).toString('base64url') + '.y'
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
function connect(db: Database.Database, tenant: string, email = 'me@acme.example') {
  const state = new URL(startOAuth(db, tenant, { env, now: NOW })).searchParams.get('state')!
  return completeOAuth(db, tenant, 'code', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt-secret-123', scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken(email) })) as unknown as typeof fetch })
}
const tokenOk = (async (url: string) => (String(url).includes('token') ? json({ access_token: 'at-1' }) : json({}, 404))) as unknown as typeof fetch
function ready(db: Database.Database, tenant = 'A') {
  saveSettings(db, tenant, { sender_name: 'Pat Smith', postal_address: '1 King St W, Toronto ON M5H 1A1, Canada' })
}
const deps = (over: Partial<Deps> = {}): Deps => ({ env, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: tokenOk, ...over })
const okSend = () => { const sent: string[] = []; return { sent, sendFn: (async (_t: string, raw: string) => { sent.push(raw); return { id: 'gm1' } }) as never } }


const status = (db: Database.Database, id: string) => db.prepare('SELECT status, approved_sender, error FROM outreach_messages WHERE id = ?').get(id) as { status: string; approved_sender: string | null; error: string | null }
const acode = async (f: () => Promise<unknown>) => { try { await f(); return null } catch (e) { return e instanceof OutreachError ? e.code : String(e) } }

test('approval records the sender; connecting another Gmail address sends waiting approvals back to draft; nothing is sent from it', async () => {
  const db = setup(); await connect(db, 'A', 'me@acme.example'); ready(db)
  const id = createDraft(db, 'A', addLead(db, 'A'), 'Acme'); approve(db, 'A', id)
  assert.deepEqual(status(db, id), { status: 'approved', approved_sender: 'me@acme.example', error: null })
  await connect(db, 'A', 'someone-else@acme.example')
  assert.deepEqual(status(db, id), { status: 'draft', approved_sender: null, error: 'sender_changed' })
  const { sent, sendFn } = okSend()
  assert.equal(await acode(() => sendMessage(db, 'A', id, deps({ sendFn }))), 'not_approved')
  assert.equal(sent.length, 0)
  // approved again, for the new address: it sends from it
  approve(db, 'A', id)
  assert.equal(status(db, id).approved_sender, 'someone-else@acme.example')
  assert.equal(await sendMessage(db, 'A', id, deps({ sendFn })), 'sent')
  assert.match(Buffer.from(sent[0], 'base64url').toString(), /^From: "Pat Smith" <someone-else@acme.example>/m)
})

test('the same address reconnecting (any case) keeps approvals', async () => {
  const db = setup(); await connect(db, 'A', 'me@acme.example'); ready(db)
  const id = createDraft(db, 'A', addLead(db, 'A'), 'Acme'); approve(db, 'A', id)
  await connect(db, 'A', 'Me@Acme.example')
  assert.equal(status(db, id).status, 'approved')
  const { sent, sendFn } = okSend()
  assert.equal(await sendMessage(db, 'A', id, deps({ sendFn })), 'sent')
  assert.equal(sent.length, 1)
})

test('the send claim itself refuses an approval for another address, whatever changed the account', async () => {
  const db = setup(); await connect(db, 'A', 'me@acme.example'); ready(db)
  const id = createDraft(db, 'A', addLead(db, 'A'), 'Acme'); approve(db, 'A', id)
  db.prepare("UPDATE gmail_accounts SET email = 'swapped@acme.example' WHERE tenant_id = 'A'").run() // any other path
  assert.equal(sendBlockReason(db, 'A', id, { now: NOW }), 'sender_changed')
  const { sent, sendFn } = okSend()
  assert.equal(await acode(() => sendMessage(db, 'A', id, deps({ sendFn }))), 'sender_changed')
  assert.equal(sent.length, 0)
  assert.deepEqual(status(db, id), { status: 'draft', approved_sender: null, error: 'sender_changed' })
})

test('disconnect binds an approval made before the binding existed; another account connected later cannot send it', async () => {
  const db = setup(); await connect(db, 'A', 'me@acme.example'); ready(db)
  const id = createDraft(db, 'A', addLead(db, 'A'), 'Acme'); approve(db, 'A', id)
  db.prepare('UPDATE outreach_messages SET approved_sender = NULL WHERE id = ?').run(id) // as recorded before this change
  await disconnectGmail(db, 'A', { env, master, fetchImpl: (async () => json({})) as unknown as typeof fetch })
  assert.equal(status(db, id).approved_sender, 'me@acme.example')
  await connect(db, 'A', 'new-owner@acme.example')
  const { sent, sendFn } = okSend()
  assert.equal(await acode(() => sendMessage(db, 'A', id, deps({ sendFn }))), 'sender_changed')
  assert.equal(sent.length, 0)
})

test('an older approval with no recorded sender still sends while the same account stays connected (no mass invalidation)', async () => {
  const db = setup(); await connect(db, 'A', 'me@acme.example'); ready(db)
  const id = createDraft(db, 'A', addLead(db, 'A'), 'Acme'); approve(db, 'A', id)
  db.prepare('UPDATE outreach_messages SET approved_sender = NULL WHERE id = ?').run(id)
  const { sent, sendFn } = okSend()
  assert.equal(await sendMessage(db, 'A', id, deps({ sendFn })), 'sent')
  assert.equal(sent.length, 1)
})

test('sequence approvals follow the sender too; another tenant changing its sender changes nothing here', async () => {
  const db = setup(); await connect(db, 'A', 'me@acme.example'); ready(db); await connect(db, 'B', 'b@beta.example'); ready(db, 'B')
  const id = createDraft(db, 'A', addLead(db, 'A'), 'Acme'); approve(db, 'A', id)
  db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES ('sq', 'A', (SELECT lead_id FROM outreach_messages WHERE id = ?), ?, 'info@northside.example', 'approved')").run(id, id)
  for (const step of [1, 2, 3]) db.prepare("INSERT INTO sequence_steps (tenant_id, sequence_id, step, subject, body, approved_hash, status, approved_sender) VALUES ('A', 'sq', ?, 's', 'A follow-up body long enough.', 'h', 'approved', 'me@acme.example')").run(step)
  await connect(db, 'B', 'b2@beta.example')
  assert.equal(status(db, id).status, 'approved', 'tenant B reconnecting does not touch A')
  assert.equal((db.prepare("SELECT status FROM sequences WHERE id = 'sq'").get() as { status: string }).status, 'approved')
  await connect(db, 'A', 'other@acme.example')
  assert.equal(status(db, id).status, 'draft')
  assert.equal((db.prepare("SELECT status FROM sequences WHERE id = 'sq'").get() as { status: string }).status, 'draft')
  assert.deepEqual((db.prepare("SELECT DISTINCT status, approved_sender FROM sequence_steps WHERE sequence_id = 'sq'").all()), [{ status: 'draft', approved_sender: null }])
})
