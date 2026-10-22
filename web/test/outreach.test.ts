import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateSequences, setTestAddresses } from '../lib/outreach/sequences.ts'
import { completeOAuth, disconnectGmail, getAccessToken, gmailStatus, startOAuth, GmailSendError, type OAuthDeps } from '../lib/gmail/oauth.ts'
import { buildMime } from '../lib/gmail/mime.ts'
import { approve, createDraft, editDraft, isSuppressed, listMessages, OutreachError, readUnsubToken, resolveUncertain, saveSettings, sendMessage, skip, suppress, unsubToken, unsubscribeByToken, type Deps } from '../lib/outreach/service.ts'

const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db)
  return db
}
function addLead(db: Database.Database, tenant: string, o: Partial<{ contact: string | null; evidence: string | null; confidence: number | null; fit: number | null; intent: number | null }> = {}) {
  const job = createJob(db, tenant, { business_name: 'Acme', industry: 'roofing', location: 'Toronto' })
  const id = randomBytes(12).toString('hex')
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, fit, intent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, job, 'Northside Builders', 'contact' in o ? o.contact : 'jobs@northside.example', 'Hiring five roofers', 'https://news.example/a',
    'evidence' in o ? o.evidence : 'Northside Builders is hiring five roofers', 'confidence' in o ? o.confidence : 85,
    'fit' in o ? o.fit : null, 'intent' in o ? o.intent : null)
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
  // Held by failed grading (fit 0, intent unset): not draftable until a rescan grades it.
  assert.throws(() => createDraft(db, 'A', addLead(db, 'A', { fit: 0, intent: null }), 'Acme'), /lead_ungraded/)
  // A real grade of 0 (mismatch) and a never-scored lead (fit unset) stay draftable.
  assert.ok(createDraft(db, 'A', addLead(db, 'A', { fit: 0, intent: 1 }), 'Acme'))
  assert.ok(createDraft(db, 'A', addLead(db, 'A', { contact: 'x@unscored.example' }), 'Acme'))
  const lead = addLead(db, 'A')
  assert.throws(() => createDraft(db, 'B', lead, 'Acme'), /not_found/)
  suppress(db, 'A', 'JOBS@northside.example', 'manual')
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
  const m = (listMessages(db, 'A', deps()) as { status: string }[])[0]
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
  assert.match(head, /^To: jobs@northside.example$/m)
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
  const id = createDraft(db, 'A', addLead(db, 'A'), 'Acme'); approve(db, 'A', id)
  const other = createDraft(db, 'A', addLead(db, 'A'), 'Acme') // same address, second lead
  const { sent, sendFn } = okSend()
  // the recipient unsubscribes between approval and send
  db.prepare("INSERT INTO suppressions (tenant_id, email, reason) VALUES ('A','jobs@northside.example','manual')").run()
  await assert.rejects(sendMessage(db, 'A', id, deps({ sendFn })), /suppressed/)
  assert.equal(sent.length, 0)
  assert.equal(isSuppressed(db, 'A', ' JOBS@northside.example '), true)
  assert.equal(isSuppressed(db, 'B', 'jobs@northside.example'), false) // per tenant
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

test('test mode: an allowlisted own-inbox consumer address drafts only with OUTREACH_TEST_MODE=1 and is labelled', () => {
  const db = setup()
  migrateSequences(db)
  setTestAddresses(db, 'A', ['instinct114114@gmail.com'])
  const lead = addLead(db, 'A', { contact: 'instinct114114@gmail.com' })
  // Default (env unset): the consumer-recipient gate still rejects, allowlist or not.
  delete process.env.OUTREACH_TEST_MODE
  assert.throws(() => createDraft(db, 'A', lead, 'Acme'), /personal_email/)
  // Operator test mode + tenant allowlist: the draft is allowed and marked as a test.
  process.env.OUTREACH_TEST_MODE = '1'
  try {
    const id = createDraft(db, 'A', lead, 'Acme')
    assert.equal((db.prepare('SELECT test FROM outreach_messages WHERE id = ?').get(id) as { test: number }).test, 1)
    assert.equal((listMessages(db, 'A')[0] as { test: number }).test, 1)
    // A consumer address NOT on the tenant's test list is still rejected.
    assert.throws(() => createDraft(db, 'A', addLead(db, 'A', { contact: 'someone@yahoo.com' }), 'Acme'), /personal_email/)
  } finally {
    delete process.env.OUTREACH_TEST_MODE
  }
  // A business-domain allowlisted address never needed the bypass; it is still labelled as a test recipient.
  const biz = createDraft(db, 'A', addLead(db, 'A', { contact: 'founder@acme.example' }), 'Acme')
  assert.equal((db.prepare('SELECT test FROM outreach_messages WHERE id = ?').get(biz) as { test: number }).test, 0)
  process.env.OUTREACH_TEST_MODE = '1'
  try {
    setTestAddresses(db, 'A', ['instinct114114@gmail.com', 'founder@acme2.example'])
    const id2 = createDraft(db, 'A', addLead(db, 'A', { contact: 'founder@acme2.example' }), 'Acme')
    assert.equal((db.prepare('SELECT test FROM outreach_messages WHERE id = ?').get(id2) as { test: number }).test, 1)
  } finally {
    delete process.env.OUTREACH_TEST_MODE
  }
})
