import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateSequences, setTestAddresses } from '../lib/outreach/sequences.ts'
import { completeOAuth, disconnectGmail, getAccessToken, gmailStatus, startOAuth, GmailSendError, type OAuthDeps } from '../lib/gmail/oauth.ts'
import { buildMime } from '../lib/gmail/mime.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { domainReviewFor } from '../lib/outreach/domain-review.ts'
import { setDomainReview } from '../lib/scan/domain-review-action.ts'
import { approve, createDraft, editDraft, isSuppressed, listMessages, OutreachError, readUnsubToken, resolveUncertain, saveSettings, sendMessage, skip, suppress, unsubToken, unsubscribeByToken, type Deps } from '../lib/outreach/service.ts'

const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); seedOffers(db); migrateConnectors(db)
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

test('oauth: url has send-only scope, PKCE S256, offline access, one-use state', () => {
  const db = setup()
  const u = new URL(startOAuth(db, 'A', { env, now: NOW }))
  assert.equal(u.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/gmail.send')
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(u.searchParams.get('access_type'), 'offline')
  assert.equal(u.searchParams.get('redirect_uri'), 'https://app.test/api/gmail/callback')
  assert.throws(() => startOAuth(db, 'A', { env: {} }), /google_not_configured/)
})

test('oauth callback: stores the refresh token encrypted, verified email only, state is one use and tied to the user', async () => {
  const db = setup()
  assert.deepEqual(await connect(db, 'A'), { email: 'me@acme.example' })
  const row = db.prepare('SELECT refresh_ct FROM gmail_accounts WHERE tenant_id = ?').get('A') as { refresh_ct: string }
  assert.ok(!row.refresh_ct.includes('rt-secret-123'))
  assert.equal(gmailStatus(db, 'A')?.status, 'active')

  const s1 = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
  const ex = (b: object) => (async () => json(b)) as unknown as typeof fetch
  const good = { refresh_token: 'r', scope: 'https://www.googleapis.com/auth/gmail.send', id_token: idToken('a@b.example') }
  await assert.rejects(completeOAuth(db, 'B', 'c', s1, { env, master, now: NOW, fetchImpl: ex(good) }), /bad_state/) // other user
  await assert.rejects(completeOAuth(db, 'A', 'c', s1, { env, master, now: NOW, fetchImpl: ex(good) }), /bad_state/) // already consumed
  const s2 = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
  await assert.rejects(completeOAuth(db, 'A', 'c', s2, { env, master, now: NOW + 601, fetchImpl: ex(good) }), /bad_state/) // expired
  const s3 = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
  await assert.rejects(completeOAuth(db, 'A', 'c', s3, { env, master, now: NOW, fetchImpl: ex({ ...good, scope: 'openid email' }) }), /send_scope_not_granted/)
  const s4 = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
  await assert.rejects(completeOAuth(db, 'A', 'c', s4, { env, master, now: NOW, fetchImpl: ex({ ...good, id_token: idToken('a@b.example', false) }) }), /email_not_verified/)
  const s5 = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
  await assert.rejects(completeOAuth(db, 'A', 'c', s5, { env, master, now: NOW, fetchImpl: ex({ scope: good.scope, id_token: good.id_token }) }), /no_refresh_token/)
})

test('token lifecycle: refresh works; revoked grant flips to needs_reconnect; disconnect revokes and deletes', async () => {
  const db = setup()
  await connect(db, 'A')
  assert.equal(await getAccessToken(db, 'A', deps()), 'at-1')
  const revoked = (async () => json({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch
  await assert.rejects(getAccessToken(db, 'A', deps({ fetchImpl: revoked })), /grant_revoked/)
  assert.equal(gmailStatus(db, 'A')?.status, 'needs_reconnect')
  await assert.rejects(getAccessToken(db, 'A', deps()), /not_connected/)
  await connect(db, 'A')
  const calls: string[] = []
  await disconnectGmail(db, 'A', deps({ fetchImpl: (async (u: string) => { calls.push(String(u)); return json({}) }) as unknown as typeof fetch }))
  assert.ok(calls[0].includes('/revoke'))
  assert.equal(gmailStatus(db, 'A'), null)
})

test('draft rules: needs a verified lead, a business email, no suppression; one draft per lead; tenant scoped', () => {
  const db = setup()
  assert.throws(() => createDraft(db, 'A', addLead(db, 'A', { evidence: null, confidence: null }), 'Acme'), /lead_not_verified/)
  assert.throws(() => createDraft(db, 'A', addLead(db, 'A', { contact: null }), 'Acme'), /no_email_contact/)
  assert.throws(() => createDraft(db, 'A', addLead(db, 'A', { contact: '(416) 555-0199' }), 'Acme'), /no_email_contact/)
  assert.throws(() => createDraft(db, 'A', addLead(db, 'A', { contact: 'someone@gmail.com' }), 'Acme'), /personal_email/)
  // A published inbox whose purpose is not sales must never receive a sales draft -
  // whether it came from the cited page or from the company's own contact page.
  assert.throws(() => createDraft(db, 'A', addLead(db, 'A', { contact: 'press@northside.example' }), 'Acme'), /not_sales_contact/)
  assert.throws(() => createDraft(db, 'A', addLead(db, 'A', { contact: 'support@northside.example' }), 'Acme'), /not_sales_contact/)
  assert.throws(() => createDraft(db, 'A', addLead(db, 'A', { contact: 'jobs@northside.example' }), 'Acme'), /not_sales_contact/)
  {
    const db2 = setup()
    db2.prepare("CREATE TABLE IF NOT EXISTS lead_enrichments (tenant_id TEXT, lead_id TEXT, connector TEXT, kind TEXT, value TEXT, label TEXT, confidence REAL, source_url TEXT, source_date TEXT, retrieved_at INTEGER)").run()
    const leadId = addLead(db2, 'A', { contact: null })
    db2.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES ('A', ?, 'sitecrawl', 'email', 'press@figma.com', 'https://figma.com/contact', '2026-10-22', 1)").run(leadId)
    assert.throws(() => createDraft(db2, 'A', leadId, 'Acme'), /not_sales_contact/)
    const leadId2 = addLead(db2, 'A', { contact: null })
    db2.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES ('A', ?, 'sitecrawl', 'email', 'info@northside.example', 'https://northside.example/contact', '2026-10-22', 1)").run(leadId2)
    // An unrecorded crawled website needs the user's identity review first (see test/domain-review.test.ts); the same address on a domain the cited page itself is on does not.
    assert.throws(() => createDraft(db2, 'A', leadId2, 'Acme'), /domain_unconfirmed/)
    db2.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('A', ?, 'sitecrawl', 'domain', 'northside.example|evidence_own_domain', 'domain-basis-v1:evidence_own_domain', 'https://northside.example/careers/1', '2026-10-22', 1)").run(leadId2)
    assert.ok(createDraft(db2, 'A', leadId2, 'Acme'))
  }
  // Held by failed grading (fit 0, intent unset): not draftable until a rescan grades it.
  assert.throws(() => createDraft(db, 'A', addLead(db, 'A', { fit: 0, intent: null }), 'Acme'), /lead_ungraded/)
  // A real grade of 0 (mismatch) and a never-scored lead (fit unset) stay draftable.
  assert.ok(createDraft(db, 'A', addLead(db, 'A', { fit: 0, intent: 1 }), 'Acme'))
  assert.ok(createDraft(db, 'A', addLead(db, 'A', { contact: 'x@unscored.example' }), 'Acme'))
  const lead = addLead(db, 'A')
  assert.throws(() => createDraft(db, 'B', lead, 'Acme'), /not_found/)
  suppress(db, 'A', 'INFO@northside.example', 'manual')
  assert.throws(() => createDraft(db, 'A', lead, 'Acme'), /suppressed/)
  const db2 = setup(); const l2 = addLead(db2, 'A')
  createDraft(db2, 'A', l2, 'Acme')
  assert.throws(() => createDraft(db2, 'A', l2, 'Acme'), /already_drafted/)
})

test('approve needs sender identity and a connected Gmail; editing after approval drops the approval; other tenants cannot touch it', async () => {
  const db = setup(); await connect(db, 'A')
  const id = createDraft(db, 'A', addLead(db, 'A'), 'Acme')
  assert.throws(() => approve(db, 'A', id), /sender_identity_missing/)
  ready(db)
  assert.throws(() => approve(db, 'B', id), /not_found/)
  assert.throws(() => skip(db, 'B', id), /not_found/)
  approve(db, 'A', id)
  editDraft(db, 'A', id, { subject: 'New subject', body: 'A different body that is long enough to pass.' })
  const m = (listMessages(db, 'A', deps()) as { status: string; evidence_state: string }[])[0]
  assert.equal(m.status, 'draft')
  assert.throws(() => editDraft(db, 'A', id, { subject: 'x', body: 'short' }), /bad_body/)
  const { sent, sendFn } = okSend()
  await assert.rejects(sendMessage(db, 'A', id, deps({ sendFn })), /not_approved/)
  assert.equal(sent.length, 0)
})

test('send: once only. repeated and concurrent calls never double send; footer, identity and unsubscribe headers are added', async () => {
  const db = setup(); await connect(db, 'A'); ready(db)
  const id = createDraft(db, 'A', addLead(db, 'A'), 'Acme'); approve(db, 'A', id)
  const { sent, sendFn } = okSend()
  const results = await Promise.allSettled([sendMessage(db, 'A', id, deps({ sendFn })), sendMessage(db, 'A', id, deps({ sendFn }))])
  assert.equal(sent.length, 1)
  assert.equal(results.filter(r => r.status === 'fulfilled').length >= 1, true)
  assert.equal(await sendMessage(db, 'A', id, deps({ sendFn })), 'sent') // retry after success is a no-op
  assert.equal(sent.length, 1)
  const mime = Buffer.from(sent[0], 'base64url').toString()
  const [head, bodyB64] = mime.split('\r\n\r\n')
  assert.match(head, /^From: "Pat Smith" <me@acme.example>/m)
  assert.match(head, /^To: info@northside.example$/m)
  assert.match(head, /^List-Unsubscribe: <https:\/\/app.test\/api\/unsubscribe\?t=[a-f0-9]{24}\.[a-f0-9]{32}>$/m)
  assert.match(head, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m)
  const body = Buffer.from(bodyB64.replace(/\r\n/g, ''), 'base64').toString()
  assert.ok(body.includes('Pat Smith') && body.includes('1 King St W') && body.includes('unsubscribe here: https://app.test/api/unsubscribe?t='))
  assert.equal((db.prepare('SELECT gmail_id FROM outreach_messages WHERE id = ?').get(id) as { gmail_id: string }).gmail_id, 'gm1')
})

test('failure handling: definite Gmail refusals go back to approved; unknown outcomes become uncertain and are never auto resent', async () => {
  const db = setup(); await connect(db, 'A'); ready(db)
  const id = createDraft(db, 'A', addLead(db, 'A'), 'Acme'); approve(db, 'A', id)
  const failing = (status: number) => ({ sendFn: (async () => { throw new GmailSendError(status) }) as never })
  await assert.rejects(sendMessage(db, 'A', id, deps(failing(429))), /gmail_rate_limited/)
  assert.equal((db.prepare('SELECT status FROM outreach_messages').get() as { status: string }).status, 'approved')
  await assert.rejects(sendMessage(db, 'A', id, deps(failing(400))), /gmail_rejected/)
  // 5xx and network errors: outcome unknown
  assert.equal(await sendMessage(db, 'A', id, deps(failing(503))), 'uncertain')
  const { sent, sendFn } = okSend()
  await assert.rejects(sendMessage(db, 'A', id, deps({ sendFn })), /already_uncertain/)
  assert.equal(sent.length, 0)
  resolveUncertain(db, 'A', id, 'retry') // the user decides
  assert.equal(await sendMessage(db, 'A', id, deps({ sendFn })), 'sent')
  assert.equal(sent.length, 1)
  // network exception
  const id2 = createDraft(db, 'A', addLead(db, 'A', { contact: 'x@other.example' }), 'Acme'); approve(db, 'A', id2)
  assert.equal(await sendMessage(db, 'A', id2, deps({ sendFn: (async () => { throw new TypeError('fetch failed') }) as never })), 'uncertain')
  resolveUncertain(db, 'A', id2, 'sent')
  assert.equal((db.prepare('SELECT status FROM outreach_messages WHERE id = ?').get(id2) as { status: string }).status, 'sent')
})

test('crash mid-send: a stale sending claim becomes uncertain, not sendable', async () => {
  const db = setup(); await connect(db, 'A'); ready(db)
  const id = createDraft(db, 'A', addLead(db, 'A'), 'Acme'); approve(db, 'A', id)
  db.prepare("UPDATE outreach_messages SET status = 'sending', claimed_at = ? WHERE id = ?").run(NOW - 3600, id) // process died after claiming
  const { sent, sendFn } = okSend()
  await assert.rejects(sendMessage(db, 'A', id, deps({ sendFn })), /already_uncertain/)
  assert.equal(sent.length, 0)
})

test('a revoked Gmail grant stops sends and keeps the message approved', async () => {
  const db = setup(); await connect(db, 'A'); ready(db)
  const id = createDraft(db, 'A', addLead(db, 'A'), 'Acme'); approve(db, 'A', id)
  const { sent, sendFn } = okSend()
  const revoked = (async () => json({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch
  await assert.rejects(sendMessage(db, 'A', id, deps({ sendFn, fetchImpl: revoked })), /gmail_reconnect_needed/)
  assert.equal(sent.length, 0)
  assert.equal(gmailStatus(db, 'A')?.status, 'needs_reconnect')
})

test('suppression: enforced at send time, by unsubscribe token, and cancels pending drafts to that address', async () => {
  const db = setup(); await connect(db, 'A'); ready(db)
  // same address, second lead, drafted before the first is approved (once one is approved, another play cannot draft
  // to the same person: test/cross-play-dedupe.test.ts)
  const id = createDraft(db, 'A', addLead(db, 'A'), 'Acme')
  const other = createDraft(db, 'A', addLead(db, 'A'), 'Acme')
  approve(db, 'A', id)
  const { sent, sendFn } = okSend()
  // the recipient unsubscribes between approval and send
  db.prepare("INSERT INTO suppressions (tenant_id, email, reason) VALUES ('A','info@northside.example','manual')").run()
  await assert.rejects(sendMessage(db, 'A', id, deps({ sendFn })), /suppressed/)
  assert.equal(sent.length, 0)
  assert.equal(isSuppressed(db, 'A', ' INFO@northside.example '), true)
  assert.equal(isSuppressed(db, 'B', 'info@northside.example'), false) // per tenant
  void other

  const db2 = setup(); await connect(db2, 'A'); ready(db2)
  const a = createDraft(db2, 'A', addLead(db2, 'A'), 'Acme'); const b = createDraft(db2, 'A', addLead(db2, 'A'), 'Acme'); approve(db2, 'A', b)
  const token = unsubToken(a, master)
  assert.equal(readUnsubToken(token, master), a)
  assert.equal(readUnsubToken(token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'), master), null)
  assert.equal(readUnsubToken(unsubToken(a, randomBytes(32)), master), null)
  assert.equal(unsubscribeByToken(db2, 'garbage', master), false)
  assert.equal(unsubscribeByToken(db2, token, master), true)
  assert.equal(unsubscribeByToken(db2, token, master), true) // idempotent
  const states = (db2.prepare('SELECT status FROM outreach_messages').all() as { status: string }[]).map(r => r.status)
  assert.deepEqual(states, ['skipped', 'skipped'])
  await assert.rejects(sendMessage(db2, 'A', b, deps({ sendFn })), /not_approved/)
})

test('daily cap stops sends past the limit', async () => {
  const db = setup(); await connect(db, 'A'); ready(db)
  for (let i = 0; i < 30; i++) db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, claimed_at) VALUES (?, 'A', ?, 'a@b.example', 's', 'body body body body body', 'sent', ?)").run(String(i).padStart(24, '0'), 'l' + i, NOW - 100)
  const id = createDraft(db, 'A', addLead(db, 'A'), 'Acme'); approve(db, 'A', id)
  const { sent, sendFn } = okSend()
  await assert.rejects(sendMessage(db, 'A', id, deps({ sendFn })), /daily_cap/)
  assert.equal(sent.length, 0)
})

test('mime: header injection is neutralised, non-ASCII is encoded, bad addresses rejected', () => {
  const m = buildMime({ fromName: 'Pat\r\nBcc: evil@x.example', fromEmail: 'me@acme.example', to: 'a@b.example', subject: 'Hi\r\nBcc: evil@x.example', body: 'x', messageId: 'id@acme.example', unsubscribeUrl: 'https://u.example/x' })
  assert.ok(!/^Bcc:/mi.test(m))
  const u = buildMime({ fromName: 'Zoë Müller', fromEmail: 'me@acme.example', to: 'a@b.example', subject: 'Café', body: 'x', messageId: 'id@acme.example', unsubscribeUrl: 'https://u.example/x' })
  assert.match(u, /^Subject: =\?UTF-8\?B\?/m)
  assert.throws(() => buildMime({ fromName: 'x', fromEmail: 'me@acme.example', to: 'a@b.example\r\nBcc: e@x.example', subject: 's', body: 'x', messageId: 'i@a.b', unsubscribeUrl: 'https://u.example' }), /bad_address/)
  void createHash
})

test('test bypass: exact operator tenant + exact inbox + exact list only; revoke at send',async()=>{
 const db=setup(); migrateSequences(db); await connect(db,'B'); await connect(db,'A'); ready(db)
 delete process.env.OUTREACH_TEST_TENANT_ID
 setTestAddresses(db,'A',['instinct114114@gmail.com','other@gmail.com'])
 assert.throws(()=>createDraft(db,'A',addLead(db,'A',{contact:'instinct114114@gmail.com'}),'Acme'),/personal_email/)
 process.env.OUTREACH_TEST_TENANT_ID='A'
 try {
  assert.throws(()=>createDraft(db,'A',addLead(db,'A',{contact:'other@gmail.com'}),'Acme'),/personal_email/)
  const id=createDraft(db,'A',addLead(db,'A',{contact:'instinct114114@gmail.com'}),'Acme'); approve(db,'A',id)
  assert.equal((db.prepare('SELECT test FROM outreach_messages WHERE id=?').get(id) as {test:number}).test,1)
  setTestAddresses(db,'B',['instinct114114@gmail.com'])
  assert.throws(()=>createDraft(db,'B',addLead(db,'B',{contact:'instinct114114@gmail.com'}),'Acme'),/personal_email/)
  delete process.env.OUTREACH_TEST_TENANT_ID
  await assert.rejects(sendMessage(db,'A',id,deps()),/personal_email/)
 } finally { delete process.env.OUTREACH_TEST_TENANT_ID }
})

test('existing approved draft cannot send after lead becomes held; successful regrade permits it', async () => {
 const db = setup(); await connect(db, 'A'); ready(db)
 const lead = addLead(db, 'A'), id = createDraft(db, 'A', lead, 'Acme'); approve(db, 'A', id)
 const { sent, sendFn } = okSend()
 db.prepare('UPDATE leads SET fit=0, intent=NULL WHERE id=?').run(lead)
 await assert.rejects(sendMessage(db,'A',id,deps({sendFn})), /lead_ungraded/)
 assert.equal(sent.length,0)
 db.prepare('UPDATE leads SET fit=4, intent=3 WHERE id=?').run(lead)
 assert.equal(await sendMessage(db,'A',id,deps({sendFn})), 'sent')
})

test('held status is rechecked after async token refresh', async () => {
 const db = setup(); await connect(db, 'A'); ready(db)
 const lead = addLead(db,'A'), id = createDraft(db,'A',lead,'Acme'); approve(db,'A',id)
 const {sent,sendFn} = okSend()
 const d = deps({sendFn})
 const fetchImpl = d.fetchImpl!
 d.fetchImpl = (async (...args: Parameters<typeof fetch>) => { db.prepare('UPDATE leads SET fit=0,intent=NULL WHERE id=?').run(lead); return fetchImpl(...args) }) as typeof fetch
 await assert.rejects(sendMessage(db,'A',id,d), /lead_ungraded/)
 assert.equal(sent.length,0)
})

test('approval freezes lead signal context, preserving secondary signals and test marker', async () => {
  const db=setup(); const lead=addLead(db,'A')
  await connect(db,'A')
  db.prepare("UPDATE leads SET signals='[\"hiring\",\"funding\"]',signal_kind='hiring',source_kind='query' WHERE id=?").run(lead)
  saveSettings(db,'A',{sender_name:'Pat',postal_address:'1 King St W, Toronto ON M5H 1A1'})
  const id=createDraft(db,'A',lead,'Seller'); approve(db,'A',id)
  const row=db.prepare('SELECT signals_json,signal_kind,source_kind FROM outreach_signal_context WHERE message_id=?').get(id) as any
  assert.deepEqual(row,{signals_json:'["hiring","funding"]',signal_kind:'hiring',source_kind:'query'})
})

test('known recruitment context blocks approval and rechecks after token await without changing approved words',async()=>{
 const db=setup();await connect(db,'A');ready(db)
 const lead=addLead(db,'A'),draft=createDraft(db,'A',lead,'Seller')
 db.prepare("UPDATE leads SET evidence_excerpt='Send your CV to info@northside.example' WHERE id=?").run(lead)
 assert.throws(()=>approve(db,'A',draft),/not_sales_contact/)
 db.prepare("UPDATE leads SET evidence_excerpt='Northside Builders is hiring five roofers' WHERE id=?").run(lead);approve(db,'A',draft)
 const saved=db.prepare('SELECT subject,body,approved_hash FROM outreach_messages WHERE id=?').get(draft)
 const sent=okSend();const fetchImpl=(async()=>{db.prepare("UPDATE leads SET evidence_excerpt='Send your CV to info@northside.example' WHERE id=?").run(lead);return json({access_token:'at'})}) as typeof fetch
 await assert.rejects(sendMessage(db,'A',draft,deps({...sent,fetchImpl})),/not_sales_contact/)
 assert.equal(sent.sent.length,0);assert.deepEqual(db.prepare('SELECT subject,body,approved_hash FROM outreach_messages WHERE id=?').get(draft),saved)
 assert.equal((db.prepare('SELECT status FROM outreach_messages WHERE id=?').get(draft) as {status:string}).status,'approved')
})


test('a crawled address needs the user identity review at approve and at send, not only at draft: a draft made before the gate, or whose confirmation is withdrawn, cannot go out', async () => {
  const db = setup(); migrateConnectors(db); await connect(db, 'A'); ready(db)
  const lead = addLead(db, 'A', { contact: null })
  const ins = db.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('A', ?, 'sitecrawl', ?, ?, ?, ?, '2026-10-24', 10)")
  ins.run(lead, 'email', 'info@northside.example', null, 'https://northside.example/contact'); ins.run(lead, 'domain', 'northside.example|name_probe', 'domain-basis-v1:name_probe', 'https://northside.example/')
  const rows = () => db.prepare('SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ?').all(lead) as never
  // A draft that already exists with no review on record (made before the gate): it is held at approve.
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, test) VALUES ('legacy1','A',?,?,?,?,0)").run(lead, 'info@northside.example', 'Subject here', 'A body that is long enough to pass the checks.')
  assert.throws(() => approve(db, 'A', 'legacy1'), /domain_unconfirmed/)
  assert.equal((db.prepare("SELECT status FROM outreach_messages WHERE id = 'legacy1'").get() as { status: string }).status, 'draft')
  // Confirm with the binding the user saw: approve and send work.
  setDomainReview(db, 'A', lead, 'confirm', domainReviewFor({ id: lead, contact: null }, rows()).binding!)
  approve(db, 'A', 'legacy1')
  // Withdraw after approval: the approved message is refused at send and never reaches Gmail.
  setDomainReview(db, 'A', lead, 'withdraw')
  const { sent, sendFn } = okSend()
  await assert.rejects(sendMessage(db, 'A', 'legacy1', deps({ sendFn })), /domain_unconfirmed/)
  assert.equal(sent.length, 0)
  assert.equal((db.prepare("SELECT status FROM outreach_messages WHERE id = 'legacy1'").get() as { status: string }).status, 'approved', 'refused before the claim: not sending, not skipped')
  // Confirmed again: it sends once.
  setDomainReview(db, 'A', lead, 'confirm', domainReviewFor({ id: lead, contact: null }, rows()).binding!)
  assert.equal(await sendMessage(db, 'A', 'legacy1', deps({ sendFn })), 'sent')
  assert.equal(sent.length, 1)
  // An address printed on the cited page is unaffected (another address: this person was just emailed from another play).
  const own = addLead(db, 'A', { contact: 'sales@northside.example' })
  const id2 = createDraft(db, 'A', own, 'Acme'); approve(db, 'A', id2)
})

test('unreadable crawl state holds a non-email lead (fail closed), and the review check shares the write lock of approve and of the send claim', async () => {
  // No lead_enrichments table at all: a lead with no email contact cannot have its address's identity verified, so it is held.
  const db0 = setup(); db0.exec('DROP TABLE lead_enrichments'); await connect(db0, 'A'); ready(db0)
  const l0 = addLead(db0, 'A', { contact: null })
  db0.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, test) VALUES ('m0','A',?,?,?,?,0)").run(l0, 'info@northside.example', 'Subject here', 'A body that is long enough to pass the guard')
  assert.throws(() => approve(db0, 'A', 'm0'), /review_unreadable/)
  // Same-file second writer: approve and the send claim take the write lock before reading the review state.
  const dir = mkdtempSync(join(tmpdir(), 'ds-')); const f = join(dir, 'a.db')
  const a = new Database(f); migrateScan(a); migrateOutreach(a); seedOffers(a); migrateConnectors(a); await connect(a, 'A'); ready(a)
  const lead = addLead(a, 'A', { contact: null })
  const ins = a.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('A', ?, 'sitecrawl', ?, ?, ?, ?, '2026-10-24', 10)")
  ins.run(lead, 'email', 'info@northside.example', null, 'https://northside.example/contact'); ins.run(lead, 'domain', 'northside.example|name_probe', 'domain-basis-v1:name_probe', 'https://northside.example/')
  a.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, test) VALUES ('m1','A',?,?,?,?,0)").run(lead, 'info@northside.example', 'Subject here', 'A body that is long enough to pass the guard')
  const bind = domainReviewFor({ id: lead, contact: null }, a.prepare('SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ?').all(lead) as never).binding!
  setDomainReview(a, 'A', lead, 'confirm', bind)
  const b = new Database(f, { timeout: 0 })
  a.exec('BEGIN IMMEDIATE')
  assert.throws(() => approve(b, 'A', 'm1'), /locked|busy/i, 'approve waits for the write lock, it does not read a stale review state')
  a.exec('COMMIT')
  approve(b, 'A', 'm1')
  const { sent, sendFn } = okSend()
  a.exec('BEGIN IMMEDIATE')
  await assert.rejects(sendMessage(b, 'A', 'm1', deps({ sendFn })), /locked|busy/i, 'the claim takes the write lock before checking')
  a.exec('COMMIT')
  assert.equal(sent.length, 0)
  assert.equal((a.prepare("SELECT status FROM outreach_messages WHERE id = 'm1'").get() as { status: string }).status, 'approved')
})

test('a test=1 message to an address that is not on the test allowlist gets no domain-review bypass at approve or send', async () => {
  const db = setup(); migrateConnectors(db); await connect(db, 'A'); ready(db)
  const lead = addLead(db, 'A', { contact: null })
  const ins = db.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('A', ?, 'sitecrawl', ?, ?, ?, ?, '2026-10-24', 10)")
  ins.run(lead, 'email', 'info@northside.example', null, 'https://northside.example/contact'); ins.run(lead, 'domain', 'northside.example|name_probe', 'domain-basis-v1:name_probe', 'https://northside.example/')
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, test) VALUES ('t1','A',?,?,?,?,1)").run(lead, 'info@northside.example', 'Subject here', 'A body that is long enough to pass the guard')
  assert.throws(() => approve(db, 'A', 't1'), /domain_unconfirmed/)
  assert.equal((db.prepare("SELECT status FROM outreach_messages WHERE id = 't1'").get() as { status: string }).status, 'draft')
  const { sent, sendFn } = okSend()
  db.prepare("UPDATE outreach_messages SET status = 'approved' WHERE id = 't1'").run()
  await assert.rejects(sendMessage(db, 'A', 't1', deps({ sendFn })), /domain_unconfirmed/)
  assert.equal(sent.length, 0)
})

test('a rescan that later sets lead.contact to an email does not exempt an older crawl-address draft; a recipient with no crawl record is outside the gate', async () => {
  const db = setup(); migrateConnectors(db); await connect(db, 'A'); ready(db)
  const lead = addLead(db, 'A', { contact: null })
  const ins = db.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('A', ?, 'sitecrawl', ?, ?, ?, ?, '2026-10-24', 10)")
  ins.run(lead, 'email', 'info@northside.example', null, 'https://northside.example/contact'); ins.run(lead, 'domain', 'northside.example|name_probe', 'domain-basis-v1:name_probe', 'https://northside.example/')
  const add = (id: string, l: string, to: string) => db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, test) VALUES (?,'A',?,?,?,?,0)").run(id, l, to, 'Subject here', 'A body that is long enough to pass the guard')
  const lead2 = addLead(db, 'A', { contact: 'else@cited2.example' })
  add('old1', lead, 'info@northside.example'); add('cited1', lead2, 'hello@cited.example')
  db.prepare('UPDATE leads SET contact = ? WHERE id = ?').run('someone@elsewhere.example', lead) // rescan changed the contact to a different email
  assert.throws(() => approve(db, 'A', 'old1'), /domain_unconfirmed/)
  assert.equal((db.prepare("SELECT to_email FROM outreach_messages WHERE id = 'old1'").get() as { to_email: string }).to_email, 'info@northside.example', 'recipient never rewritten')
  approve(db, 'A', 'cited1') // boundary: no crawl record for this recipient, not judged by the domain review
  db.prepare('UPDATE leads SET contact = ? WHERE id = ?').run('info@northside.example', lead) // contact now equals the recipient, but the crawl recorded it too
  assert.throws(() => approve(db, 'A', 'old1'), /domain_unconfirmed/, 'equality with the contact does not prove a cited-page origin')
  const rows = () => db.prepare('SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ?').all(lead) as never
  const offered = domainReviewFor({ id: lead, contact: 'info@northside.example' }, rows())
  assert.equal(offered.state, 'required'); assert.equal(offered.binding, domainReviewFor({ id: lead, contact: null }, rows()).binding, 'the binding the Leads page offers is the one the gate judges')
  assert.deepEqual(setDomainReview(db, 'A', lead, 'confirm', offered.binding!), { status: 'confirmed', domain: 'northside.example' })
  approve(db, 'A', 'old1')
  const m = db.prepare("SELECT to_email, subject, body FROM outreach_messages WHERE id = 'old1'").get() as { to_email: string; subject: string; body: string }
  assert.deepEqual(m, { to_email: 'info@northside.example', subject: 'Subject here', body: 'A body that is long enough to pass the guard' }, 'confirming changed neither recipient nor words')
  setDomainReview(db, 'A', lead, 'withdraw')
  const { sent, sendFn } = okSend()
  await assert.rejects(sendMessage(db, 'A', 'old1', deps({ sendFn })), /domain_unconfirmed/)
  assert.equal(sent.length, 0)
})

test('sendMessage: a website confirmation withdrawn during the token fetch releases the claim and sends nothing', async () => {
  const db = setup(); migrateConnectors(db); await connect(db, 'A'); ready(db)
  const lead = addLead(db, 'A', { contact: null })
  const ins = db.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('A', ?, 'sitecrawl', ?, ?, ?, ?, '2026-10-24', 10)")
  ins.run(lead, 'email', 'info@northside.example', null, 'https://northside.example/contact'); ins.run(lead, 'domain', 'northside.example|name_probe', 'domain-basis-v1:name_probe', 'https://northside.example/')
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, test) VALUES ('w1','A',?,?,?,?,0)").run(lead, 'info@northside.example', 'Subject here', 'A body that is long enough to pass the guard')
  const rows = () => db.prepare('SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ?').all(lead) as never
  setDomainReview(db, 'A', lead, 'confirm', domainReviewFor({ id: lead, contact: null }, rows()).binding!)
  approve(db, 'A', 'w1')
  const { sent, sendFn } = okSend()
  const fetchImpl = (async () => { setDomainReview(db, 'A', lead, 'withdraw'); return json({ access_token: 'at' }) }) as typeof fetch
  await assert.rejects(sendMessage(db, 'A', 'w1', deps({ sendFn, fetchImpl })), /domain_unconfirmed/)
  assert.equal(sent.length, 0)
  assert.equal((db.prepare("SELECT status FROM outreach_messages WHERE id = 'w1'").get() as { status: string }).status, 'approved', 'claim released back to approved')
})

test('current email contact + unreadable crawl table is held with review_unreadable at approve (origin unknowable, fail closed)', async () => {
  const db = setup(); await connect(db, 'A'); ready(db)
  const lead = addLead(db, 'A', { contact: 'info@northside.example' })
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, test) VALUES ('mu','A',?,?,?,?,1)").run(lead, 'info@northside.example', 'Subject here', 'A body that is long enough to pass the length check for this fixture message.')
  db.exec('DROP TABLE lead_enrichments')
  assert.throws(() => approve(db, 'A', 'mu'), /review_unreadable/)
})
