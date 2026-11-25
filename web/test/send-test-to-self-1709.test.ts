// #1709: "Send test to me" — before emailing a prospect, the user sends the exact final email (real footer,
// real unsubscribe link, sender identity) to their own connected Gmail address. The draft itself is untouched:
// status stays draft, approval hash untouched, nothing is recorded as sent to the prospect. The unsubscribe
// link in a test carries a test-marked token: using it suppresses nobody, so the user cannot accidentally
// suppress themselves or the prospect by clicking it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { seedOffers } from './helpers/seed-offer.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'
import { createDraft, editDraft, isSuppressed, saveSettings, unsubscribeByToken, unsubToken, type Deps } from '../lib/outreach/service.ts'
import { isTestUnsubToken, sendTestToSelf, unsubTestToken } from '../lib/outreach/test-send.ts'

const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); seedOffers(db); migrateConnectors(db)
  return db
}
function addLead(db: Database.Database, tenant: string) {
  const job = createJob(db, tenant, { business_name: 'Acme', industry: 'roofing', location: 'Toronto' })
  const id = randomBytes(12).toString('hex')
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, fit, intent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, job, 'Northside Builders', 'info@northside.example', 'Hiring five roofers', 'https://news.example/a',
    'Northside Builders is hiring five roofers', 85, null, null)
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE id=?").run(id)
  return id
}
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
function connect(db: Database.Database, tenant: string, email = 'me@acme.example') {
  const state = new URL(startOAuth(db, tenant, { env, now: NOW })).searchParams.get('state')!
  return completeOAuth(db, tenant, 'code', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt-secret-123', scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken(email) })) as unknown as typeof fetch })
}
const tokenOk = (async (url: string) => (String(url).includes('token') ? json({ access_token: 'at-1' }) : json({}, 404))) as unknown as typeof fetch
const deps = (over: Partial<Deps> = {}): Deps => ({ env, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: tokenOk, ...over })
const okSend = () => { const sent: string[] = []; return { sent, sendFn: (async (_t: string, raw: string) => { sent.push(raw); return { id: 'gm1' } }) as never } }
const parseMime = (raw: string) => {
  const mime = Buffer.from(raw, 'base64url').toString()
  const [head, bodyB64] = mime.split('\r\n\r\n')
  return { head, body: Buffer.from((bodyB64 ?? '').replace(/\r\n/g, ''), 'base64').toString() }
}

async function draftReady(db: Database.Database) {
  await connect(db, 'A')
  saveSettings(db, 'A', { sender_name: 'Pat Smith', postal_address: '1 King St W, Toronto ON M5H 1A1, Canada' })
  const lead = addLead(db, 'A')
  const id = createDraft(db, 'A', lead, 'Acme', { manual: true })
  editDraft(db, 'A', id, { subject: 'Roofing crews, available now', body: 'Hi, we have roofing crews free next week and can start on Monday.' })
  return id
}

test('#1709 sendTestToSelf delivers the final email to the connected Gmail address, draft untouched', async () => {
  const db = setup()
  const id = await draftReady(db)
  const { sent, sendFn } = okSend()
  const to = await sendTestToSelf(db, 'A', id, deps({ sendFn }))
  assert.equal(to, 'me@acme.example', 'the test goes to the connected Gmail address, not the prospect')
  assert.equal(sent.length, 1)
  const { head, body } = parseMime(sent[0])
  assert.match(head, /^To: me@acme\.example$/m)
  assert.doesNotMatch(head, /info@northside\.example/, 'the prospect is not emailed')
  assert.match(head, /^Subject: \[Test\] Roofing crews, available now$/m)
  assert.match(body, /Hi, we have roofing crews free next week/, 'the saved words are in the test')
  assert.match(body, /Pat Smith/, 'sender name from Settings is in the footer')
  assert.match(body, /1 King St W, Toronto ON M5H 1A1, Canada/, 'postal address from Settings is in the footer')
  const unsub = body.match(/https:\/\/app\.test\/api\/unsubscribe\?t=([A-Za-z0-9._-]+)/)
  assert.ok(unsub, 'the footer carries a real unsubscribe URL, not the preview placeholder')
  const m = db.prepare('SELECT status, approved_hash, sent_at FROM outreach_messages WHERE id = ?').get(id) as { status: string; approved_hash: string | null; sent_at: number | null }
  assert.equal(m.status, 'draft', 'the draft stays a draft')
  assert.equal(m.approved_hash, null, 'no approval is created or changed')
  assert.equal(m.sent_at, null, 'nothing is recorded as sent to the prospect')
})

test('#1709 the unsubscribe link in a test email suppresses nobody', async () => {
  const db = setup()
  const id = await draftReady(db)
  const { sent, sendFn } = okSend()
  await sendTestToSelf(db, 'A', id, deps({ sendFn }))
  const token = parseMime(sent[0]).body.match(/\/api\/unsubscribe\?t=([A-Za-z0-9._-]+)/)![1]
  assert.equal(unsubscribeByToken(db, token, master), false, 'a test token is a deliberate no-op')
  assert.equal(isSuppressed(db, 'A', 'info@northside.example'), false, 'the prospect is not suppressed')
  assert.equal(isSuppressed(db, 'A', 'me@acme.example'), false, 'the user is not suppressed')
})

test('#1709 a test send needs the sender identity and a connected Gmail account', async () => {
  const db = setup()
  const lead = addLead(db, 'A')
  const id = createDraft(db, 'A', lead, 'Acme', { manual: true })
  const { sendFn } = okSend()
  await assert.rejects(sendTestToSelf(db, 'A', id, deps({ sendFn })), /sender_identity_missing/)
  await connect(db, 'A')
  await assert.rejects(sendTestToSelf(db, 'A', id, deps({ sendFn })), /sender_identity_missing/)
  saveSettings(db, 'A', { sender_name: 'Pat Smith', postal_address: '1 King St W, Toronto ON M5H 1A1, Canada' })
  assert.equal(await sendTestToSelf(db, 'A', id, deps({ sendFn })), 'me@acme.example')
  const db2 = setup()
  const lead2 = addLead(db2, 'A')
  const id2 = createDraft(db2, 'A', lead2, 'Acme', { manual: true })
  saveSettings(db2, 'A', { sender_name: 'Pat Smith', postal_address: '1 King St W, Toronto ON M5H 1A1, Canada' })
  await assert.rejects(sendTestToSelf(db2, 'A', id2, deps({ sendFn })), /gmail_not_connected/)
})

test('#1709 (Qodo) a test token cannot suppress the prospect — neither marked nor with the marker stripped', async () => {
  const db = setup()
  const id = await draftReady(db)
  const marked = unsubTestToken(id, master)
  assert.equal(isTestUnsubToken(marked, master), true, 'the marked form is recognisable as a test token')
  assert.equal(unsubscribeByToken(db, marked, master), false, 'the marked token never resolves')
  assert.equal(unsubscribeByToken(db, marked.slice(2), master), false, 'stripping the marker leaves a test-key signature the production check rejects')
  assert.equal(isSuppressed(db, 'A', 'info@northside.example'), false, 'the prospect is not suppressed')
  assert.equal(unsubscribeByToken(db, unsubToken(id, master), master), true, 'control: the real token still unsubscribes')
  assert.equal(isSuppressed(db, 'A', 'info@northside.example'), true)
})

test('#1709 (Qodo) an edit saved while the token is being fetched refuses the test instead of sending old words', async () => {
  const db = setup()
  const id = await draftReady(db)
  const { sent, sendFn } = okSend()
  const editingFetch = (async (url: string) => {
    if (String(url).includes('token')) {
      editDraft(db, 'A', id, { subject: 'Changed subject', body: 'Changed body words, saved while the test was preparing.' })
      return json({ access_token: 'at-1' })
    }
    return json({}, 404)
  }) as unknown as typeof fetch
  await assert.rejects(sendTestToSelf(db, 'A', id, deps({ sendFn, fetchImpl: editingFetch })), /draft_changed/)
  assert.equal(sent.length, 0, 'nothing was sent')
})

test('#1709 (Qodo) a Gmail connection replaced while the token is being fetched refuses the test', async () => {
  const db = setup()
  const id = await draftReady(db)
  const { sent, sendFn } = okSend()
  const replacingFetch = (async (url: string) => {
    if (String(url).includes('token')) {
      const state = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
      await completeOAuth(db, 'A', 'code2', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt-secret-999', scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
      return json({ access_token: 'at-1' })
    }
    return json({}, 404)
  }) as unknown as typeof fetch
  await assert.rejects(sendTestToSelf(db, 'A', id, deps({ sendFn, fetchImpl: replacingFetch })), /connection_replaced/)
  assert.equal(sent.length, 0, 'nothing was sent through the replaced connection')
})

test('#1709 (Qodo) a Gmail 401 on the test send marks the account needs_reconnect, scoped to the connection generation', async () => {
  const { GmailSendError } = await import('../lib/gmail/oauth.ts')
  const db = setup()
  const id = await draftReady(db)
  const dead = (async () => { throw new GmailSendError(401) }) as never
  await assert.rejects(sendTestToSelf(db, 'A', id, deps({ sendFn: dead })), /gmail_reconnect_needed/)
  const st = (db.prepare('SELECT status FROM gmail_accounts WHERE tenant_id = ?').get('A') as { status: string }).status
  assert.equal(st, 'needs_reconnect', 'the account the token was minted from is marked')
})

test('#1709 (Qodo) a Gmail 401 after the connection was replaced mid-send does not mark the new connection', async () => {
  const { GmailSendError } = await import('../lib/gmail/oauth.ts')
  const db = setup()
  const id = await draftReady(db)
  const rotating = (async () => {
    const state = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
    await completeOAuth(db, 'A', 'code2', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt-secret-999', scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
    throw new GmailSendError(401)
  }) as never
  await assert.rejects(sendTestToSelf(db, 'A', id, deps({ sendFn: rotating })), /gmail_reconnect_needed/)
  const st = (db.prepare('SELECT status FROM gmail_accounts WHERE tenant_id = ?').get('A') as { status: string }).status
  assert.equal(st, 'active', 'the replacement connection is untouched by the stale send')
})
