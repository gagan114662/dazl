// #370: multiple authorized sender identities per workspace. Synthetic data, stubbed Google endpoints, no live send.
import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach, replySafetyStale } from '../lib/outreach/store.ts'
import { migrateSequences, createSequence, enrollColdSequence } from '../lib/outreach/sequences.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { WORKSPACE_DDL } from '../lib/workspaces.ts'
import { migrateReplies, acceptReadConsent, syncReplies } from '../lib/outreach/replies.ts'
import { migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { completeOAuth, disconnectSender, gmailStatus, startOAuth, GmailSendError } from '../lib/gmail/oauth.ts'
import { decryptSecret } from '../lib/secrets.ts'
import { listSenders, senderCredentialContext, senderDailyLimit, SENDER_IDENTITY_CAP, SENDER_WARMUP } from '../lib/outreach/senders.ts'
import { approve, createDraft, DAILY_CAP, saveSettings, sendBlockReason, sendMessage, setMessageSender, suppress, type Deps } from '../lib/outreach/service.ts'

const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const T = 'team-tenant-0001'

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); seedOffers(db, [T]); migrateConnectors(db); migrateSequences(db)
  db.exec(WORKSPACE_DDL)
  for (const [m, role] of [['alice', 'owner'], ['bob', 'operator'], ['carol', 'admin']]) db.prepare('INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, ?, 0)').run(T, m, role)
  saveSettings(db, T, { sender_name: 'Team Acme', postal_address: '1 King St W, Toronto ON M5H 1A1, Canada' })
  return db
}
let leadN = 0
function addLead(db: Database.Database, tenant = T) {
  const job = createJob(db, tenant, { business_name: 'Acme', industry: 'roofing', location: 'Toronto' })
  const id = randomBytes(12).toString('hex')
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const n = ++leadN
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, fit, intent, human_confirmed_at, human_confirmed_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1800000000, ?)').run(
    id, job, `Northside ${n}`, `info@northside${n}.example`, 'Hiring five roofers', 'https://news.example/a', `Northside ${n} is hiring five roofers`, 85, 'test_review')
  return id
}
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const exchange = (email: string, rt: string) => (async () => json({ refresh_token: rt, scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken(email) })) as unknown as typeof fetch

// Primary connection (gmail_accounts), exactly as before #370.
async function connectPrimary(db: Database.Database, email = 'shared@acme.example') {
  const state = new URL(startOAuth(db, T, { env, now: NOW })).searchParams.get('state')!
  return completeOAuth(db, T, 'code', state, { env, master, now: NOW, fetchImpl: exchange(email, 'rt-primary') })
}
// An added identity, started and completed by the same member.
async function connectSender(db: Database.Database, member: string, email: string, verifiedAt = NOW) {
  const state = new URL(startOAuth(db, T, { env, now: verifiedAt, senderOwner: member })).searchParams.get('state')!
  const r = await completeOAuth(db, T, 'code', state, { env, master, now: verifiedAt, actorId: member, fetchImpl: exchange(email, `rt-${member}`) })
  return r.senderId!
}
// Token endpoint: the access token names the refresh token it came from, so a send proves which credential it used.
const tokenByRefresh = (async (url: string, init?: RequestInit) => {
  if (!String(url).includes('token')) return json({}, 404)
  return json({ access_token: `at:${new URLSearchParams(String(init?.body)).get('refresh_token')}` })
}) as unknown as typeof fetch
type Sent = { token: string; from: string; to: string; threadId?: string }
const capture = () => {
  const sent: Sent[] = []
  const sendFn = (async (token: string, raw: string, _f: unknown, threadId?: string) => {
    const head = Buffer.from(raw, 'base64url').toString().split('\r\n\r\n')[0]
    sent.push({ token, from: /^From: .*<([^>]+)>/m.exec(head)![1], to: /^To: (.+)$/m.exec(head)![1], threadId })
    return { id: `gm${sent.length}`, threadId: `th${sent.length}` }
  }) as never
  return { sent, sendFn }
}
const deps = (over: Partial<Deps> = {}): Deps => ({ env, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: tokenByRefresh, ...over })
const status = (db: Database.Database, id: string) => db.prepare('SELECT status, error, approved_hash, sender_id FROM outreach_messages WHERE id = ?').get(id) as { status: string; error: string | null; approved_hash: string | null; sender_id: string | null }
const ready = (db: Database.Database, sender: string | null) => { const id = createDraft(db, T, addLead(db), 'Acme'); if (sender) setMessageSender(db, T, id, sender); approve(db, T, id); return id }

test('connect: an added identity is verified by the provider, owned by the member who started it, credential bound to that identity; the primary is untouched', async () => {
  const db = setup()
  await connectPrimary(db)
  const x = await connectSender(db, 'alice', 'alice@acme.example')
  assert.equal(gmailStatus(db, T)?.email, 'shared@acme.example', 'primary connection unchanged')
  const row = db.prepare('SELECT * FROM sender_identities WHERE id = ?').get(x) as { refresh_ct: string; owner_member_id: string; provider: string; email: string; verified_at: number }
  assert.deepEqual([row.provider, row.email, row.owner_member_id, row.verified_at], ['gmail', 'alice@acme.example', 'alice', NOW])
  assert.ok(!row.refresh_ct.includes('rt-alice'), 'stored encrypted')
  assert.equal(decryptSecret(row.refresh_ct, senderCredentialContext(T, x), master), 'rt-alice')
  assert.throws(() => decryptSecret(row.refresh_ct, 'gmail-refresh:' + T, master), 'not readable under the primary context')
  // another member cannot complete a connect someone else started (the state is bound to the starting member)
  const s = new URL(startOAuth(db, T, { env, now: NOW, senderOwner: 'bob' })).searchParams.get('state')!
  await assert.rejects(completeOAuth(db, T, 'c', s, { env, master, now: NOW, actorId: 'alice', fetchImpl: exchange('bob@acme.example', 'rt-bob') }), /bad_state/)
  // the same mailbox connected by another member is refused, never re-owned
  const s2 = new URL(startOAuth(db, T, { env, now: NOW, senderOwner: 'bob' })).searchParams.get('state')!
  await assert.rejects(completeOAuth(db, T, 'c', s2, { env, master, now: NOW, actorId: 'bob', fetchImpl: exchange('alice@acme.example', 'rt-bob') }), /sender_owned_by_other_member/)
  // send scope only for an added identity: no read grant asked
  assert.equal(new URL(startOAuth(db, T, { env, now: NOW, senderOwner: 'bob' })).searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/gmail.send')
  assert.deepEqual(listSenders(db, T, NOW).map(v => [v.email, v.usable, v.daily_limit]), [['alice@acme.example', null, SENDER_WARMUP[0]]])
  assert.equal(JSON.stringify(listSenders(db, T, NOW)).includes('refresh_ct'), false, 'the view never carries the credential')
})

test('two team senders operate without credential or thread mixing', async () => {
  const db = setup()
  await connectPrimary(db)
  const x = await connectSender(db, 'alice', 'alice@acme.example')
  const y = await connectSender(db, 'bob', 'bob@acme.example')
  const mx = ready(db, x), my = ready(db, y), mp = ready(db, null)
  const { sent, sendFn } = capture()
  for (const id of [mx, my, mp]) assert.equal(await sendMessage(db, T, id, deps({ sendFn })), 'sent')
  assert.deepEqual(sent.map(s => [s.token, s.from]), [['at:rt-alice', 'alice@acme.example'], ['at:rt-bob', 'bob@acme.example'], ['at:rt-primary', 'shared@acme.example']])
  assert.ok(sent.every(s => s.threadId === undefined), 'a first touch never reuses a thread')
  // follow-up machinery runs on the primary mailbox only: an added identity's send never becomes a sequence or a synced thread
  assert.equal(enrollColdSequence(db, T, mx), null)
  const dx = createDraft(db, T, addLead(db), 'Acme'); setMessageSender(db, T, dx, x)
  assert.throws(() => createSequence(db, T, dx), /sender_not_primary/)
  const dp = createDraft(db, T, addLead(db), 'Acme'); createSequence(db, T, dp)
  assert.throws(() => setMessageSender(db, T, dp, x), /sender_sequence_bound/)
})

test('changing the sender invalidates the approval; a sender swapped behind the approval is refused at send', async () => {
  const db = setup()
  await connectPrimary(db)
  const x = await connectSender(db, 'alice', 'alice@acme.example')
  const y = await connectSender(db, 'bob', 'bob@acme.example')
  const id = ready(db, x)
  assert.equal(status(db, id).status, 'approved')
  setMessageSender(db, T, id, y)
  assert.deepEqual([status(db, id).status, status(db, id).approved_hash, status(db, id).sender_id], ['draft', null, y])
  approve(db, T, id)
  setMessageSender(db, T, id, null)
  assert.equal(status(db, id).status, 'draft', 'back to the primary needs a fresh approval too')
  approve(db, T, id)
  // a write that bypasses setMessageSender cannot carry the old approval to another mailbox
  db.prepare('UPDATE outreach_messages SET sender_id = ? WHERE id = ?').run(x, id)
  assert.equal(sendBlockReason(db, T, id, { now: NOW }), 'changed_since_approval')
  const { sent, sendFn } = capture()
  await assert.rejects(sendMessage(db, T, id, deps({ sendFn })), /changed_since_approval/)
  assert.equal(sent.length, 0)
  // autopilot's expected sender is the primary: a message bound elsewhere never goes out under that authority
  db.prepare('UPDATE outreach_messages SET sender_id = NULL WHERE id = ?').run(id)
  setMessageSender(db, T, id, x); approve(db, T, id)
  await assert.rejects(sendMessage(db, T, id, deps({ sendFn, expectSender: 'shared@acme.example' })), /sender_changed/)
  assert.equal(sent.length, 0)
})

test('disconnecting one sender pauses its messages only; owner removal or demotion revokes that sender', async () => {
  const db = setup()
  await connectPrimary(db)
  const x = await connectSender(db, 'alice', 'alice@acme.example')
  const y = await connectSender(db, 'bob', 'bob@acme.example')
  const mx = ready(db, x), my = ready(db, y), mp = ready(db, null)
  const revoked: string[] = []
  const revokeSpy = (async (url: string, init?: RequestInit) => { revoked.push(`${url} ${new URLSearchParams(String(init?.body)).get('token')}`); return json({}) }) as unknown as typeof fetch
  assert.equal(await disconnectSender(db, T, x, { env, master, fetchImpl: revokeSpy }), true)
  assert.deepEqual(revoked, ['https://oauth2.googleapis.com/revoke rt-alice'], 'only that identity\'s grant is revoked')
  assert.equal((db.prepare('SELECT count(*) AS n FROM sender_identities WHERE id = ?').get(x) as { n: number }).n, 0, 'credential deleted')
  const { sent, sendFn } = capture()
  await assert.rejects(sendMessage(db, T, mx, deps({ sendFn })), /sender_disconnected/)
  assert.equal(status(db, mx).status, 'approved', 'held, not lost and not sent')
  assert.equal(await sendMessage(db, T, my, deps({ sendFn })), 'sent')
  assert.equal(await sendMessage(db, T, mp, deps({ sendFn })), 'sent')
  assert.deepEqual(sent.map(s => s.from), ['bob@acme.example', 'shared@acme.example'])
  assert.equal(gmailStatus(db, T)?.status, 'active')
  assert.throws(() => setMessageSender(db, T, ready(db, null), x), /sender_not_found/)
  // workspace removal revokes delegated sending at the next send; demotion below 'send' does too
  const my2 = ready(db, y)
  db.prepare("UPDATE memberships SET role = 'viewer' WHERE tenant_id = ? AND member_id = 'bob'").run(T)
  await assert.rejects(sendMessage(db, T, my2, deps({ sendFn })), /sender_owner_removed/)
  db.prepare("DELETE FROM memberships WHERE tenant_id = ? AND member_id = 'bob'").run(T)
  await assert.rejects(sendMessage(db, T, my2, deps({ sendFn })), /sender_owner_removed/)
  assert.equal(listSenders(db, T, NOW).find(v => v.id === y)?.usable, 'sender_owner_removed')
  assert.equal(sent.length, 2)
  // another workspace cannot bind or use this tenant's identity
  assert.throws(() => setMessageSender(db, 'other-tenant', my2, y), /not_found/)
})

test('a revoked grant on one identity flips only that identity; the primary and the other identity keep sending', async () => {
  const db = setup()
  await connectPrimary(db)
  const x = await connectSender(db, 'alice', 'alice@acme.example')
  const y = await connectSender(db, 'bob', 'bob@acme.example')
  const mx = ready(db, x), my = ready(db, y)
  const refuse401 = (async (token: string) => { if (token === 'at:rt-alice') throw new GmailSendError(401); return { id: 'gm9' } }) as never
  await assert.rejects(sendMessage(db, T, mx, deps({ sendFn: refuse401 })), /sender_reconnect_needed/)
  assert.equal(listSenders(db, T, NOW).find(v => v.id === x)?.status, 'needs_reconnect')
  assert.equal(gmailStatus(db, T)?.status, 'active', 'primary untouched')
  assert.equal(await sendMessage(db, T, my, deps({ sendFn: refuse401 })), 'sent')
})

test('shared suppression and the organization cap still apply to every identity; each identity has its own warm-up cap', async () => {
  const db = setup()
  await connectPrimary(db)
  const x = await connectSender(db, 'alice', 'alice@acme.example')
  const { sent, sendFn } = capture()
  // suppression is per workspace, not per mailbox
  const ms = ready(db, x)
  suppress(db, T, (db.prepare('SELECT to_email FROM outreach_messages WHERE id = ?').get(ms) as { to_email: string }).to_email, 'unsubscribe')
  assert.equal(status(db, ms).status, 'skipped')
  // warm-up: week 1 = 5 per rolling 24h from this identity
  assert.equal(senderDailyLimit({ verified_at: NOW }, NOW), SENDER_WARMUP[0])
  assert.equal(senderDailyLimit({ verified_at: NOW - 15 * 86400 }, NOW), SENDER_WARMUP[2])
  assert.equal(senderDailyLimit({ verified_at: NOW - 60 * 86400 }, NOW), SENDER_IDENTITY_CAP)
  const ids = Array.from({ length: SENDER_WARMUP[0] + 1 }, () => ready(db, x))
  for (const id of ids.slice(0, -1)) assert.equal(await sendMessage(db, T, id, deps({ sendFn })), 'sent')
  assert.equal(sendBlockReason(db, T, ids.at(-1)!, { now: NOW }), 'sender_daily_cap')
  await assert.rejects(sendMessage(db, T, ids.at(-1)!, deps({ sendFn })), /sender_daily_cap/)
  assert.equal(status(db, ids.at(-1)!).status, 'approved')
  // the primary is not limited by the identity's warm-up, but everyone shares the workspace cap
  const mp = ready(db, null)
  assert.equal(await sendMessage(db, T, mp, deps({ sendFn })), 'sent')
  const later = deps({ sendFn, now: NOW + 2 * 86400 }) // the identity's own window has passed; the org window is full again
  for (let i = 0; i < DAILY_CAP; i++) db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, claimed_at) VALUES (?, ?, ?, 'a@b.example', 's', 'body body body body body', 'sent', ?)").run(randomBytes(12).toString('hex'), T, 'm' + i, NOW + 2 * 86400 - 100)
  await assert.rejects(sendMessage(db, T, ids.at(-1)!, later), /daily_cap/)
  assert.equal(sent.length, SENDER_WARMUP[0] + 1)
})

test('reply safety: history from an added identity holds anything further to that recipient (no reply ingest runs there yet)', async () => {
  const db = setup()
  db.exec('CREATE TABLE IF NOT EXISTS scheduler_progress (tenant_id TEXT, kind TEXT, last_success_at INTEGER); CREATE TABLE IF NOT EXISTS mail_read_consent (tenant_id TEXT, version TEXT)')
  await connectPrimary(db)
  const x = await connectSender(db, 'alice', 'alice@acme.example')
  const id = ready(db, x)
  const to = (db.prepare('SELECT to_email FROM outreach_messages WHERE id = ?').get(id) as { to_email: string }).to_email
  assert.equal(replySafetyStale(db, T, to, NOW), false, 'first contact: no history, nothing stale')
  const { sendFn } = capture()
  assert.equal(await sendMessage(db, T, id, deps({ sendFn })), 'sent')
  assert.equal(replySafetyStale(db, T, to, NOW), true)
})

test('reply sync on the primary mailbox never opens a thread sent from an added identity', async () => {
  const db = setup(); migrateAutopilot(db); migrateLedger(db); migrateReplies(db)
  const state = new URL(startOAuth(db, T, { env, now: NOW, withRead: true })).searchParams.get('state')!
  await completeOAuth(db, T, 'c', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt-primary', scope: 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly', id_token: idToken('shared@acme.example') })) as unknown as typeof fetch })
  acceptReadConsent(db, T)
  const x = await connectSender(db, 'alice', 'alice@acme.example')
  const put = (mid: string, sender: string | null) => db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, gmail_id, thread_id, sender_id) VALUES (?, ?, ?, ?, 'Quick question', 'bodybodybodybodybodybody', 'sent', ?, ?, ?, ?, ?)").run(mid, T, addLead(db), `p-${mid}@co.example`, NOW - 86400, NOW - 86400, `g-${mid}`, `t-${mid}`, sender)
  put('a'.repeat(24), null); put('b'.repeat(24), x)
  const calls: string[] = []
  const fetchImpl = (async (url: string) => {
    const u = String(url); calls.push(u)
    if (u.includes('oauth2')) return json({ access_token: 'at' })
    if (/threads\//.test(u)) return json({ messages: [] })
    if (u.includes('messages?q=')) return json({ messages: [] })
    return json({}, 404)
  }) as unknown as typeof fetch
  const r = await syncReplies(db, T, { env, master, now: NOW, fetchImpl })
  assert.equal(r.threads, 1)
  assert.ok(calls.some(u => u.includes(`threads/t-${'a'.repeat(24)}`)))
  assert.ok(!calls.some(u => u.includes('b'.repeat(24))), 'the added identity\'s message id and thread are never looked up with the primary token')
  assert.deepEqual((db.prepare('SELECT thread_id FROM followup_threads WHERE tenant_id = ?').all(T) as { thread_id: string }[]).map(t => t.thread_id), [`t-${'a'.repeat(24)}`])
})
