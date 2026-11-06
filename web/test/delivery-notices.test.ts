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
import { bounceCount } from '../lib/outreach/bounce-ledger.ts'
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
function gmailStub(notices: ReturnType<typeof dsnNotice>[], calls: string[] = [], th1Extra: unknown[] = []) {
  return (async (url: string) => {
    const u = String(url); calls.push(u)
    if (u.includes('token')) return json({ access_token: 'at' })
    if (u.includes('messages?q=')) return json({ messages: notices.map(n => ({ id: n.id })) })
    const m = /messages\/([^?/]+)\?format=full/.exec(u)
    if (m) { const n = notices.find(x => x.id === m[1]); if (n) return json(n) }
    if (/threads\/th-1/.test(u)) return json({ messages: [{ id: 'g-sent', threadId: 'th-1', internalDate: String((NOW - 86400) * 1000), payload: { headers: [{ name: 'From', value: 'me@acme.example' }], mimeType: 'text/plain', body: { data: b64('Intro') } } }, ...th1Extra] })
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

test('old narrower consent refuses acquisition before token or mailbox calls; fresh acceptance restores bounded search', async () => {
  const db = await setup(); seedSend(db)
  db.prepare("UPDATE mail_read_consent SET version='2026-10-21' WHERE tenant_id='A'").run()
  const calls: string[] = []
  const fetchImpl = (async (u: RequestInfo | URL) => { calls.push(String(u)); if (String(u).includes('token')) return json({ access_token: 'fixture' }); return json({ messages: [] }) }) as typeof fetch
  const old = await syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl })
  assert.equal(old.error, 'reading_not_enabled'); assert.equal(calls.length, 0, 'no token refresh or mail read under an old grant')
  acceptReadConsent(db, 'A')
  const fresh = await syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl })
  assert.equal(fresh.error, undefined)
  assert.ok(calls.some(u => u.includes('/messages?q=') && decodeURIComponent(u).includes('from:mailer-daemon OR from:postmaster after:')))
  db.close()
})

// ---- Separate-thread notices matched by their own structured fields (not thread id), with authenticated provenance ----
// The notice sits on its own Gmail thread (th-dsn-*), carries no thread link to th-1, and is matched by the original
// Message-ID / In-Reply-To / References, the per-recipient Final-/Original-Recipient, or X-Failed-Recipients.
const GOOGLE_AR = 'mx.google.com; spf=pass (google.com: domain of postmaster@mx.buyer.example designates 192.0.2.7 as permitted sender) smtp.mailfrom=mx.buyer.example'
const mxFor = async (domain: string) => domain === 'buyer.example' ? ['mx.buyer.example'] : []
const syncDeps = (fetchImpl: typeof fetch, now = NOW) => ({ env: genv, master, now, fetchImpl, resolveMxFor: mxFor })
type Notice = ReturnType<typeof dsnNotice>
const withAuth = (n: Notice, ...ar: string[]): Notice => ({ ...n, payload: { ...n.payload, headers: [...ar.map(value => ({ name: 'Authentication-Results', value })), ...n.payload.headers] } })
const withHeaders = (n: Notice, ...h: { name: string; value: string }[]): Notice => ({ ...n, payload: { ...n.payload, headers: [...n.payload.headers, ...h] } })
// the original Message-ID only in the returned headers part, as RFC 3464 notices carry it
const returnedHeaders = (n: Notice, messageId: string): Notice => ({ ...n, payload: { ...n.payload, parts: n.payload.parts.map(p => p.mimeType === 'message/rfc822' ? { mimeType: 'text/rfc822-headers', body: { data: b64(`From: me@acme.example\nTo: sam@buyer.example\nMessage-ID: ${messageId}\nSubject: Intro\n`) } } : p) } })
const deliveryStatus = (n: Notice, text: string): Notice => ({ ...n, payload: { ...n.payload, parts: n.payload.parts.map(p => p.mimeType === 'message/delivery-status' ? { ...p, body: { data: b64(text) } } : p) } })
const count = (db: Database.Database, sql: string) => (db.prepare(sql).get() as { n: number }).n
const bounceAudits = (db: Database.Database) => count(db, "SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = 'A' AND action = 'bounce'")

test('a verified permanent DSN on its OWN thread, matched by the returned Message-ID: suppressed, sequence stops, accounted once', async () => {
  const db = await setup(); seedSend(db)
  const n1 = withAuth(returnedHeaders(dsnNotice('dsn-sep-1', {}), '<dazl.MID@acme.example>'), GOOGLE_AR)
  assert.equal(n1.payload.headers.some(h => /references|in-reply-to/i.test(h.name)), false, 'no thread linkage at all')
  const r1 = await syncReplies(db, 'A', syncDeps(gmailStub([n1])))
  assert.equal(r1.error, undefined)
  assert.equal(r1.bounces, 1)
  assert.equal(isSuppressed(db, 'A', 'sam@buyer.example'), true)
  assert.deepEqual(db.prepare("SELECT status, stop_reason FROM sequences WHERE id = 'seq1'").get(), { status: 'stopped', stop_reason: 'suppressed' })
  assert.equal((db.prepare("SELECT stopped FROM followup_threads WHERE tenant_id = 'A' AND thread_id = 'th-1'").get() as { stopped: string }).stopped, 'bounce')
  assert.deepEqual(db.prepare("SELECT classification, outreach_message_id, thread_id FROM inbound_messages WHERE gmail_id = 'dsn-sep-1'").get(), { classification: 'bounce', outreach_message_id: 'MID', thread_id: 'th-dsn-dsn-sep-1' })
  assert.equal(bounceCount(db, 'A'), 1); assert.equal(bounceAudits(db), 1)
  // A second notice for the same send (another MTA / retry, different Gmail id), matched by In-Reply-To and the
  // Original-Recipient while the Final-Recipient is a forwarding address, plus a re-run listing both: still once.
  const n2 = withAuth(withHeaders(deliveryStatus(dsnNotice('dsn-sep-2', {}), 'Reporting-MTA: dns; mx.buyer.example\n\nOriginal-Recipient: rfc822; sam@buyer.example\nFinal-Recipient: rfc822; sam.fwd@buyer.example\nAction: failed\nStatus: 5.1.1\n'), { name: 'In-Reply-To', value: '<dazl.MID@acme.example>' }), GOOGLE_AR)
  const r2 = await syncReplies(db, 'A', syncDeps(gmailStub([n1, n2]), NOW + 600))
  assert.equal(r2.bounces, 0, 'the same send + recipient never counts twice')
  assert.equal((db.prepare("SELECT classification FROM inbound_messages WHERE gmail_id = 'dsn-sep-2'").get() as { classification: string }).classification, 'bounce')
  assert.equal(bounceCount(db, 'A'), 1); assert.equal(bounceAudits(db), 1)
})

test('a follow-up step id (dazl.s1.<send>@) in References correlates to the original send; MX-aligned origin is resolved by DNS, not the notice', async () => {
  const db = await setup(); seedSend(db)
  let asked = ''
  // SPF passes for a hosted MX (not under buyer.example): aligned only through the recipient domain's DNS MX set
  const n = withAuth(dsnNotice('dsn-step', { ref: '<dazl.s1.MID@acme.example>' }), 'mx.google.com; spf=pass smtp.mailfrom=mx1.mailhost.example')
  const r = await syncReplies(db, 'A', { ...syncDeps(gmailStub([n])), resolveMxFor: async (d: string) => { asked = d; return d === 'buyer.example' ? ['mx1.mailhost.example'] : [] } })
  assert.equal(asked, 'buyer.example', 'MX looked up for the RECORDED recipient domain')
  assert.equal(r.bounces, 1)
  assert.equal(isSuppressed(db, 'A', 'sam@buyer.example'), true)
})

test('DNS failure during the MX lookup (reviewer-required negative): suppresses nobody, never crashes the sync', async () => {
  const db = await setup(); seedSend(db)
  // Same shape as the MX-resolved case above (SPF passes for a hosted MX, so provenance can only align through the
  // recipient domain's DNS MX set) except the DNS lookup itself fails.
  const n = withAuth(dsnNotice('dsn-dns-fail', { ref: '<dazl.s1.MID@acme.example>' }), 'mx.google.com; spf=pass smtp.mailfrom=mx1.mailhost.example')
  const r = await syncReplies(db, 'A', { ...syncDeps(gmailStub([n])), resolveMxFor: async () => { throw new Error('DNS lookup failed') } })
  assert.equal(r.error, undefined, 'a DNS failure never fails the whole sync')
  assert.equal(r.bounces, 0)
  assert.equal(r.reviews, 1, 'correlates (exact ref + recipient) but unverified provenance: review, not silently dropped')
  assert.equal(isSuppressed(db, 'A', 'sam@buyer.example'), false)
  assert.deepEqual(db.prepare("SELECT status FROM sequences WHERE id = 'seq1'").get(), { status: 'active' })
  assert.equal((db.prepare("SELECT classification FROM inbound_messages WHERE gmail_id = 'dsn-dns-fail'").get() as { classification: string }).classification, 'bounce_review')
})

test('two sends referenced in one notice (reviewer-required negative): ambiguous, correlates to neither, suppresses nobody', async () => {
  const db = await setup(); seedSend(db)
  // A second recorded send to a different recipient, same tenant.
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url) VALUES ('L2', (SELECT scan_job_id FROM leads WHERE id = 'L1'), 'Pat', 'Other Co', 'pat@other.example', 's', 'https://n.example/b')").run()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, gmail_id, thread_id) VALUES ('MID2', 'A', 'L2', 'pat@other.example', 'Intro', 'Hi Pat, thought you might find this interesting too.', 'sent', ?, 'g-sent-2', 'th-2')").run(NOW - 86400)
  // A notice naming sam@buyer.example's recipient block but referencing BOTH MID and MID2 in its headers (two
  // different valid dazl ids): referencedSendIds returns 2 ids, so nothing correlates to a single exact send.
  const n = withAuth(withHeaders(dsnNotice('dsn-ambig', {}), { name: 'References', value: '<dazl.MID@acme.example> <dazl.MID2@acme.example>' }), GOOGLE_AR)
  const r = await syncReplies(db, 'A', syncDeps(gmailStub([n])))
  assert.equal(r.bounces, 0); assert.equal(r.reviews, 0, 'ambiguous correlation is unmatched, not a review item')
  assert.equal(isSuppressed(db, 'A', 'sam@buyer.example'), false)
  assert.equal(isSuppressed(db, 'A', 'pat@other.example'), false)
  assert.equal((db.prepare("SELECT classification FROM inbound_messages WHERE gmail_id = 'dsn-ambig'").get() as { classification: string }).classification, 'bounce_unmatched')
})

test('in-thread and separate-thread notices for the same send share one ledger: one suppression, one count', async () => {
  const db = await setup(); seedSend(db)
  const inThread = { id: 'g-in', threadId: 'th-1', internalDate: String((NOW - 7200) * 1000), payload: { headers: [{ name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' }], mimeType: 'text/plain', body: { data: b64('Delivery to sam@buyer.example failed permanently: 550 5.1.1 no such user') } } }
  const separate = withAuth(returnedHeaders(dsnNotice('dsn-sep', {}), '<dazl.MID@acme.example>'), GOOGLE_AR)
  const r = await syncReplies(db, 'A', syncDeps(gmailStub([separate], [], [inThread])))
  assert.equal(r.bounces, 1)
  assert.equal(bounceCount(db, 'A'), 1); assert.equal(bounceAudits(db), 1)
  assert.equal((db.prepare("SELECT classification FROM inbound_messages WHERE gmail_id = 'dsn-sep'").get() as { classification: string }).classification, 'bounce')
})

test('X-Failed-Recipients alone (no delivery-status part) correlates but carries no status: review, never suppression', async () => {
  const db = await setup(); seedSend(db)
  const n = withAuth(withHeaders(dsnNotice('dsn-xfr', { ref: '<dazl.MID@acme.example>' }), { name: 'X-Failed-Recipients', value: 'sam@buyer.example' }), GOOGLE_AR)
  n.payload.parts = n.payload.parts.filter(p => p.mimeType !== 'message/delivery-status')
  const r = await syncReplies(db, 'A', syncDeps(gmailStub([n])))
  assert.equal(r.bounces, 0); assert.equal(r.reviews, 1)
  assert.equal(isSuppressed(db, 'A', 'sam@buyer.example'), false)
  assert.equal((db.prepare("SELECT classification FROM inbound_messages WHERE gmail_id = 'dsn-xfr'").get() as { classification: string }).classification, 'bounce_review')
  // X-Failed-Recipients never overrides a delivery-status block that names someone else
  const db2 = await setup(); seedSend(db2)
  const other = withAuth(withHeaders(dsnNotice('dsn-xfr-2', { ref: '<dazl.MID@acme.example>', recipient: 'carol@other.example' }), { name: 'X-Failed-Recipients', value: 'sam@buyer.example' }), GOOGLE_AR)
  const r2 = await syncReplies(db2, 'A', syncDeps(gmailStub([other])))
  assert.equal(r2.bounces, 0); assert.equal(r2.reviews, 0)
  assert.equal(isSuppressed(db2, 'A', 'sam@buyer.example'), false); assert.equal(isSuppressed(db2, 'A', 'carol@other.example'), false)
})

test('a soft (4.x.x) or delayed separate-thread notice never suppresses, even with verified provenance', async () => {
  const db = await setup(); seedSend(db)
  const soft = withAuth(returnedHeaders(dsnNotice('dsn-soft-v', { status: '4.2.2' }), '<dazl.MID@acme.example>'), GOOGLE_AR)
  const delayed = withAuth(returnedHeaders(dsnNotice('dsn-delayed', { status: '4.4.7', action: 'delayed' }), '<dazl.MID@acme.example>'), GOOGLE_AR)
  const r = await syncReplies(db, 'A', syncDeps(gmailStub([soft, delayed])))
  assert.equal(r.bounces, 0)
  assert.equal(isSuppressed(db, 'A', 'sam@buyer.example'), false)
  assert.deepEqual(db.prepare("SELECT status FROM sequences WHERE id = 'seq1'").get(), { status: 'active' })
  assert.equal(count(db, "SELECT count(*) AS n FROM inbound_messages WHERE classification = 'soft_bounce'"), 2)
  assert.equal(bounceCount(db, 'A'), 0)
})

test('forged, foreign-domain, ambiguous or unaligned notices cannot suppress anyone, even carrying a Google Authentication-Results', async () => {
  const cases: [string, Notice, 'bounce_review' | 'bounce_unmatched'][] = [
    // attacker's own domain passes SPF on its own notice: not aligned with the recipient's domain or MX
    ['attacker-own-pass', withAuth(returnedHeaders(dsnNotice('f1', { from: 'mailer-daemon@attacker.example' }), '<dazl.MID@acme.example>'), 'mx.google.com; spf=pass smtp.mailfrom=attacker.example'), 'bounce_review'],
    // a forged "mx.google.com" result injected BELOW an untrusted first header
    ['injected-second-ar', withAuth(returnedHeaders(dsnNotice('f2', {}), '<dazl.MID@acme.example>'), 'evil.example; none', GOOGLE_AR), 'bounce_review'],
    // a dazl-shaped id on a domain that is not the tenant's sending domain
    ['foreign-domain-ref', withAuth(returnedHeaders(dsnNotice('f3', {}), '<dazl.MID@evil.example>'), GOOGLE_AR), 'bounce_unmatched'],
    // references to two different sends: ambiguous, correlates to nothing
    ['two-sends', withAuth(dsnNotice('f4', { ref: '<dazl.MID@acme.example> <dazl.OTHER@acme.example>' }), GOOGLE_AR), 'bounce_unmatched'],
    // our reference, verified origin, but the block names someone else: never costs another contact
    ['other-recipient', withAuth(returnedHeaders(dsnNotice('f5', { recipient: 'carol@other.example' }), '<dazl.MID@acme.example>'), GOOGLE_AR), 'bounce_unmatched'],
  ]
  for (const [name, notice, cls] of cases) {
    const db = await setup(); seedSend(db)
    db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, gmail_id, thread_id) VALUES ('OTHER', 'A', 'L2', 'sam@buyer.example', 'Intro 2', 'Hi Sam, a second note that is long enough.', 'sent', ?, 'g-sent-2', 'th-2')").run(NOW - 3600)
    const r = await syncReplies(db, 'A', syncDeps(gmailStub([notice])))
    assert.equal(r.bounces, 0, name)
    assert.equal(isSuppressed(db, 'A', 'sam@buyer.example'), false, name)
    assert.equal(isSuppressed(db, 'A', 'carol@other.example'), false, name)
    assert.deepEqual(db.prepare("SELECT status FROM sequences WHERE id = 'seq1'").get(), { status: 'active' }, name)
    assert.equal(bounceCount(db, 'A'), 0, name)
    assert.equal((db.prepare('SELECT classification FROM inbound_messages WHERE gmail_id = ?').get(notice.id) as { classification: string }).classification, cls, name)
  }
})

test('read consent revoked during the MX lookup: no suppression is written', async () => {
  const db = await setup(); seedSend(db)
  // first AR is Google's, but SPF names the recipient MX host only, so alignment needs the DNS lookup
  const n = withAuth(returnedHeaders(dsnNotice('dsn-race', {}), '<dazl.MID@acme.example>'), 'mx.google.com; spf=pass smtp.mailfrom=mx1.mailhost.example')
  const r = await syncReplies(db, 'A', { ...syncDeps(gmailStub([n])), resolveMxFor: async () => { db.prepare("DELETE FROM mail_read_consent WHERE tenant_id = 'A'").run(); return ['mx1.mailhost.example'] } })
  assert.equal(r.error, 'reading_not_enabled')
  assert.equal(isSuppressed(db, 'A', 'sam@buyer.example'), false)
  assert.equal(bounceCount(db, 'A'), 0)
})
