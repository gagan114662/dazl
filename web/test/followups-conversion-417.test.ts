// #417: warm follow-ups (runFollowups) must honour a prospect's conversion like the cold sequence and first-touch send paths do.
// The conversion cancel stops the follow-up threads that exist at conversion time, but a thread created AFTER it (the converted
// prospect replies to an old cold email, so reply sync opens a thread), a conversion proven during the token await, and a pending
// conversion whose address is already verified (a lost activation drain) all reached the Gmail handoff. Synthetic tenant and
// addresses, injected fetch and send functions: no provider, no real send. The control cases must still send, so a pass is not inert.
import { migrateConnectors } from '../lib/connectors/store.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings } from '../lib/outreach/service.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable, migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { acceptReadConsent, migrateReplies, syncReplies } from '../lib/outreach/replies.ts'
import { runFollowups, setFollowups } from '../lib/outreach/followups.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { queuePendingLifecycle, recordLifecycleEvent, POLICY_STOP } from '../lib/outreach/lifecycle.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const DAY = 86400
const TO = 'p@one.example'
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const SEND = 'https://www.googleapis.com/auth/gmail.send'

async function setup() {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db)
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW, withRead: true })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: `${SEND} ${GMAIL_READ_SCOPE}`, id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 5 })
  acceptReadConsent(db, 'A')
  return db
}
function sentLead(db: Database.Database, to: string, sentAt = NOW - 4 * DAY) {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex'), mid = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(lead, job, 'Northside', to, 'Hiring roofers', 'https://n.example/a', 'Northside is hiring', 90)
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, gmail_id, thread_id) VALUES (?, 'A', ?, ?, 'Quick question', 'bodybodybodybodybodybody', 'sent', ?, ?, ?, ?)").run(mid, lead, to, sentAt, sentAt, 'g-' + mid, 't-' + mid)
  return { lead, mid, thread: 't-' + mid }
}
const msg = (id: string, from: string, body: string, at: number) => ({ id, threadId: 't', internalDate: String(at * 1000), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }], body: { data: Buffer.from(body).toString('base64url') } } })
function gmail(threads: Record<string, unknown[]>) {
  return (async (url: string) => {
    const u = String(url)
    if (u.includes('oauth2')) return json({ access_token: 'at' })
    const m = u.match(/threads\/([^?]+)/); if (m) return json({ messages: threads[m[1]] ?? [] })
    if (u.includes('messages?q=')) return json({ messages: [] })
    return json({}, 404)
  }) as unknown as typeof fetch
}
const flags = { AUTOPILOT_ENABLED: '1' }
function sendSpy() { const sent: string[] = []; return { sent, sendFn: (async (_t: string, raw: string) => { sent.push(raw); return { id: 'f1' } }) as never } }
const base = (over: object = {}) => ({ flags, env: genv, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: gmail({}), ...over })
// The prospect replied with interest, so reply sync opens the warm follow-up thread (with its ledger consent).
async function interested(db: Database.Database, to = TO) {
  const s = sentLead(db, to)
  await syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl: gmail({ [s.thread]: [msg('r' + s.mid, to, 'Interested, tell me more', NOW - 4 * DAY)] }) })
  return s
}
const usersTable = (db: Database.Database) => db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, email_verified_at INTEGER)')
const threadStopped = (db: Database.Database) => (db.prepare('SELECT stopped FROM followup_threads WHERE tenant_id = ?').get('A') as { stopped: string | null }).stopped
const count = (db: Database.Database, sql: string) => (db.prepare(sql).get() as { n: number }).n

function assertRefused(db: Database.Database, r: { sent: number }, spy: { sent: string[] }) {
  assert.equal(r.sent, 0); assert.equal(spy.sent.length, 0, 'no Gmail handoff')
  assert.equal(count(db, 'SELECT count(*) AS n FROM followup_messages'), 0, 'no claim left behind, no sent record')
  assert.equal(threadStopped(db), POLICY_STOP, 'the thread is stopped terminally with the generic policy reason')
  assert.equal(count(db, "SELECT count(*) AS n FROM autopilot_audit WHERE action = 'followup_skipped' AND detail = 'converted'"), 1, 'the refusal is recorded')
}

test('control: no conversion, the due warm follow-up sends', async () => {
  const db = await setup(); await interested(db); setFollowups(db, 'A', true)
  const spy = sendSpy()
  const r = await runFollowups(db, 'A', 'Acme', base({ sendFn: spy.sendFn }))
  assert.equal(r.sent, 1); assert.equal(spy.sent.length, 1)
  db.close()
})

test('converted BEFORE the thread existed (converted prospect replies to an old cold email): no warm sales follow-up', async () => {
  const db = await setup()
  assert.equal(recordLifecycleEvent(db, 'payment', TO, 'acct-1', NOW - 5 * DAY), 0) // nothing pending yet to stop
  await interested(db); setFollowups(db, 'A', true)
  assert.equal(threadStopped(db), null, 'precondition: reply sync opened a live thread after the conversion')
  const spy = sendSpy()
  const r = await runFollowups(db, 'A', 'Acme', base({ sendFn: spy.sendFn }))
  assertRefused(db, r, spy)
  // A retry/restart cannot resurrect it: the next pass sees a stopped thread and sends nothing.
  const again = await runFollowups(db, 'A', 'Acme', base({ sendFn: spy.sendFn }))
  assert.equal(again.sent, 0); assert.equal(spy.sent.length, 0)
  db.close()
})

test('conversion matched case- and whitespace-insensitively on the thread address', async () => {
  const db = await setup(); recordLifecycleEvent(db, 'signup', '  P@ONE.example ', 'acct-1', NOW - 5 * DAY)
  await interested(db); setFollowups(db, 'A', true)
  const spy = sendSpy()
  assertRefused(db, await runFollowups(db, 'A', 'Acme', base({ sendFn: spy.sendFn })), spy)
  db.close()
})

test('conversion proven DURING the token await: refused at the handoff, claim released, thread stopped', async () => {
  const db = await setup(); await interested(db); setFollowups(db, 'A', true)
  const spy = sendSpy(); const f = gmail({})
  // Another process records the conversion while this pass awaits the token. Its cancel already stops the thread row; the
  // in-flight pass loaded the thread before that and must re-prove the conversion itself.
  const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
    if (String(args[0]).includes('oauth2')) db.prepare("INSERT INTO lifecycle_events (event_key, kind, email, account_tenant, created_at, activated_at) VALUES ('payment|p@one.example', 'payment', 'p@one.example', 'acct-1', ?, ?)").run(NOW, NOW)
    return f(...args)
  }) as typeof fetch
  recordLifecycleEvent(db, 'signup', 'unrelated@two.example', 'acct-2', NOW) // also creates the table before the pass
  const r = await runFollowups(db, 'A', 'Acme', base({ sendFn: spy.sendFn, fetchImpl }))
  assertRefused(db, r, spy)
  db.close()
})

test('pending conversion whose address is already verified (lost activation drain) blocks the send', async () => {
  const db = await setup(); usersTable(db)
  queuePendingLifecycle(db, 'signup', TO, 'u1', NOW - DAY)
  db.prepare('INSERT INTO users (id, email, email_verified_at) VALUES (?, ?, ?)').run('u1', TO, NOW - 3600)
  await interested(db); setFollowups(db, 'A', true)
  const spy = sendSpy()
  assertRefused(db, await runFollowups(db, 'A', 'Acme', base({ sendFn: spy.sendFn })), spy)
  db.close()
})

test('pending UNVERIFIED signup (a typed address proves nothing) and an unrelated conversion do not block', async () => {
  const db = await setup(); usersTable(db)
  queuePendingLifecycle(db, 'signup', TO, 'u1', NOW - DAY)
  db.prepare('INSERT INTO users (id, email, email_verified_at) VALUES (?, ?, NULL)').run('u1', TO)
  recordLifecycleEvent(db, 'payment', 'p@one.example.other', 'acct-2', NOW - DAY) // same-looking but different address
  await interested(db); setFollowups(db, 'A', true)
  const spy = sendSpy()
  const r = await runFollowups(db, 'A', 'Acme', base({ sendFn: spy.sendFn }))
  assert.equal(r.sent, 1); assert.equal(spy.sent.length, 1)
  assert.equal(threadStopped(db), null)
  db.close()
})
