// #415: delivery-status notices (RFC 3464 DSNs) arrive on their OWN threads. syncReplies must acquire them with the
// least privilege possible (daemon notices in the sync window only), correlate to the exact recorded send before
// suppressing, never let a soft failure suppress, and never let an unmatched or forged notice cost a contact.
// Exact Message-ID ref = correlation, not authentication; without authenticated DSN provenance a correlated
// hard bounce is a review item, never an automatic suppression or stop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateReplies, syncReplies, acceptReadConsent } from '../lib/outreach/replies.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { isSuppressed } from '../lib/outreach/service.ts'
import { startOAuth, completeOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const b64 = (s: string) => Buffer.from(s).toString('base64url')
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'

async function setup(withRead = true) {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateReplies(db); migrateSequences(db)
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW, withRead })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: `https://www.googleapis.com/auth/gmail.send${withRead ? ' ' + GMAIL_READ_SCOPE : ''}`, id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  if (withRead) acceptReadConsent(db, 'A')
  return db
}

// A recorded send to sam@buyer.example on thread th-1; the tenant's own thread has no daemon mail in it.
function seedSend(db: Database.Database) {
  const jobId = createJob(db, 'A', { business_name: 'b', industry: 'i', location: 'l' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url) VALUES ('L1', ?, 'Sam', 'Buyer Co', 'sam@buyer.example', 's', 'https://n.example/a')").run(jobId)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, gmail_id, thread_id) VALUES ('MID', 'A', 'L1', 'sam@buyer.example', 'Intro', 'Hi Sam, thought you might find this interesting for your team.', 'sent', ?, 'g-sent', 'th-1')").run(NOW - 86400)
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at) VALUES ('A', 'th-1', 'L1', 'sam@buyer.example', 'dazl.MID@acme.example', ?)").run(NOW - 86400)
  db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES ('seq1', 'A', 'L1', 'MID', 'sam@buyer.example', 'active')").run()
}

const dsnNotice = (id: string, opts: { status?: string; recipient?: string; ref?: string | null; action?: string; from?: string }) =>
  ({ id, threadId: 'th-dsn-' + id, internalDate: String((NOW - 3600) * 1000), payload: {
    mimeType: 'multipart/report',
    headers: [{ name: 'From', value: opts.from ?? 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' }, ...(opts.ref ? [{ name: 'References', value: opts.ref }] : [])],
    parts: [
      { mimeType: 'text/plain', body: { data: b64('This is an automatically generated Delivery Status Notification. Delivery to the following recipient failed permanently.') } },
      { mimeType: 'message/delivery-status', body: { data: b64(`Final-Recipient: rfc822; ${opts.recipient ?? 'sam@buyer.example'}\nAction: ${opts.action ?? 'failed'}\nStatus: ${opts.status ?? '5.1.1'}\nDiagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.`) } },
      { mimeType: 'message/rfc822', body: {} },
    ],
  } })

// Gmail API stub: token, the tenant's own thread (clean), the daemon-notice search, and the notices themselves.
function gmailStub(notices: ReturnType<typeof dsnNotice>[], calls: string[] = []) {
  return (async (url: string) => {
    const u = String(url); calls.push(u)
    if (u.includes('token')) return json({ access_token: 'at' })
    if (u.includes('messages?q=')) return json({ messages: notices.map(n => ({ id: n.id })) })
    const m = /messages\/([^?/]+)\?format=full/.exec(u)
    if (m) { const n = notices.find(x => x.id === m[1]); if (n) return json(n) }
    if (/threads\/th-1/.test(u)) return json({ messages: [{ id: 'g-sent', threadId: 'th-1', internalDate: String((NOW - 86400) * 1000), payload: { headers: [{ name: 'From', value: 'me@acme.example' }], mimeType: 'text/plain', body: { data: b64('Intro') } } }] })
    return json({}, 404)
  }) as unknown as typeof fetch
}

test('a correlated permanent DSN without authenticated provenance goes to REVIEW: no suppression, no stop, accounted once', async () => {
  // Exact ref + recipient CORRELATES the notice to our send; it does not authenticate it. Until the notice is
  // proven to come from the recipient's own mail infrastructure, a 5.x.x is a human review item, never an
  // automatic suppression, thread stop or sequence stop.
  const db = await setup(); seedSend(db)
  const notices = [dsnNotice('dsn-1', { ref: '<dazl.MID@acme.example>' })]
  const r1 = await syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl: gmailStub(notices) })
  assert.equal(r1.bounces, 0)
  assert.equal(r1.reviews, 1)
  assert.equal(isSuppressed(db, 'A', 'sam@buyer.example'), false)
  assert.equal((db.prepare("SELECT stopped FROM followup_threads WHERE tenant_id = 'A' AND thread_id = 'th-1'").get() as { stopped: string | null }).stopped, null)
  assert.deepEqual(db.prepare("SELECT status FROM sequences WHERE id = 'seq1'").get(), { status: 'active' })
  assert.equal((db.prepare("SELECT classification FROM inbound_messages WHERE gmail_id = 'dsn-1'").get() as { classification: string }).classification, 'bounce_review')
  assert.equal((db.prepare("SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = 'A' AND action = 'bounce_review'").get() as { n: number }).n, 1)
  // Re-listed + re-run: the accounting never doubles.
  const r2 = await syncReplies(db, 'A', { env: genv, master, now: NOW + 600, fetchImpl: gmailStub(notices) })
  assert.equal(r2.bounces, 0)
  assert.equal(r2.reviews, 0)
  assert.equal((db.prepare("SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = 'A' AND action = 'bounce_review'").get() as { n: number }).n, 1)
})

test('a soft (4.x.x) failure never suppresses', async () => {
  const db = await setup(); seedSend(db)
  const r = await syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl: gmailStub([dsnNotice('dsn-soft', { status: '4.2.2', ref: '<dazl.MID@acme.example>' })]) })
  assert.equal(r.bounces, 0)
  assert.equal(isSuppressed(db, 'A', 'sam@buyer.example'), false)
  assert.equal((db.prepare("SELECT classification FROM inbound_messages WHERE gmail_id = 'dsn-soft'").get() as { classification: string }).classification, 'soft_bounce')
})

test('forged, unrelated, or ambiguous notices suppress nobody', async () => {
  const db = await setup(); seedSend(db)
  const notices = [
    dsnNotice('dsn-forge', { ref: '<dazl.MID@acme.example>', recipient: 'carol@other.example' }), // references our send but names someone else
    dsnNotice('dsn-unknown', { ref: null, recipient: 'nobody@never-wrote.example' }), // structured but we never wrote to them
    dsnNotice('dsn-text', { ref: null, recipient: 'sam@buyer.example', action: undefined as never, status: undefined as never }), // human text only, no structure
  ]
  // The last one has no delivery-status fields at all: strip its structured part.
  notices[2].payload.parts = notices[2].payload.parts.filter(p => p.mimeType !== 'message/delivery-status')
  const r = await syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl: gmailStub(notices) })
  assert.equal(r.bounces, 0)
  assert.equal(isSuppressed(db, 'A', 'sam@buyer.example'), false)
  assert.equal(isSuppressed(db, 'A', 'carol@other.example'), false)
  assert.equal((db.prepare("SELECT count(*) AS n FROM inbound_messages WHERE tenant_id = 'A' AND classification = 'bounce_unmatched'").get() as { n: number }).n, 3)
})

test('a genuine-looking NO-REFERENCE 5.1.1 notice naming the sole recent recipient can never suppress (From is not authentication)', async () => {
  const db = await setup(); seedSend(db)
  const r = await syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl: gmailStub([dsnNotice('dsn-noref', { ref: null, status: '5.1.1', recipient: 'sam@buyer.example' })]) })
  assert.equal(r.bounces, 0)
  assert.equal(isSuppressed(db, 'A', 'sam@buyer.example'), false)
  assert.equal((db.prepare("SELECT stopped FROM followup_threads WHERE tenant_id = 'A' AND thread_id = 'th-1'").get() as { stopped: string | null }).stopped, null)
  assert.deepEqual(db.prepare("SELECT status FROM sequences WHERE id = 'seq1'").get(), { status: 'active' })
  const row = db.prepare("SELECT classification, from_email, excerpt FROM inbound_messages WHERE gmail_id = 'dsn-noref'").get() as { classification: string; from_email: string; excerpt: string }
  assert.equal(row.classification, 'bounce_unmatched', 'unmatched is never soft_bounce and never a suppression')
  // retention minimum: nothing about the claimed sender or recipient of mail that may not be ours
  assert.equal(row.from_email, ''); assert.equal(row.excerpt, '')
})

test('a spoofed daemon From with a FABRICATED dazl-pattern reference suppresses nobody', async () => {
  const db = await setup(); seedSend(db)
  const forged = dsnNotice('dsn-forged-ref', { ref: '<dazl.0123456789abcdef01234567@acme.example>', status: '5.1.1', recipient: 'sam@buyer.example' })
  const r = await syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl: gmailStub([forged]) })
  assert.equal(r.bounces, 0)
  assert.equal(isSuppressed(db, 'A', 'sam@buyer.example'), false)
  assert.equal((db.prepare("SELECT classification FROM inbound_messages WHERE gmail_id = 'dsn-forged-ref'").get() as { classification: string }).classification, 'bounce_unmatched')
  assert.equal((db.prepare("SELECT detail FROM autopilot_audit WHERE tenant_id = 'A' AND action = 'bounce_unmatched'").get() as { detail: string }).detail, 'no exact send correlation', 'audit carries no addresses of unmatched mail')
})

test('a spoofed daemon From quoting a KNOWN VALID reference: correlates, and takes NO action', async () => {
  // An exact Message-ID ref is correlation, not authentication - a party who saw the send's headers could quote
  // it. Knowledge of headers is not consent to be suppressed, so without provenance the forged notice and the
  // genuine one land in the same review bucket; nobody is suppressed and nothing stops.
  const db = await setup(); seedSend(db)
  const forged = dsnNotice('dsn-spoof-valid', { from: 'mailer-daemon@attacker.example', ref: '<dazl.MID@acme.example>', recipient: 'sam@buyer.example', status: '5.1.1' })
  const r = await syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl: gmailStub([forged]) })
  assert.equal(r.bounces, 0)
  assert.equal(r.reviews, 1, 'correlated but unproven: a human review item, never an automatic action')
  assert.equal(isSuppressed(db, 'A', 'sam@buyer.example'), false)
  assert.equal(isSuppressed(db, 'A', 'carol@other.example'), false)
  assert.equal((db.prepare("SELECT stopped FROM followup_threads WHERE tenant_id = 'A' AND thread_id = 'th-1'").get() as { stopped: string | null }).stopped, null)
  assert.deepEqual(db.prepare("SELECT status FROM sequences WHERE id = 'seq1'").get(), { status: 'active' })
})

test('without read consent nothing is listed and coverage reports unknown, never healthy', async () => {
  const db = await setup(false); seedSend(db)
  const calls: string[] = []
  const r = await syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl: gmailStub([dsnNotice('dsn-1', { ref: '<dazl.MID@acme.example>' })], calls) })
  assert.equal(r.error, 'reading_not_enabled')
  assert.equal(calls.filter(u => u.includes('messages')).length, 0, 'no mailbox listing without consent')
  assert.equal(isSuppressed(db, 'A', 'sam@buyer.example'), false)
})
