// #415: a delivery-status notice that arrives as its OWN thread (not inside the outreach thread) is still seen, tied to
// the exact message dazl sent and its recipient. Stubbed Gmail only: every address, domain and notice is invented.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings, isSuppressed } from '../lib/outreach/service.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable, migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { acceptReadConsent, migrateReplies, syncReplies } from '../lib/outreach/replies.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { DSN_QUERY, outreachIdOf, parseDsn } from '../lib/outreach/dsn.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const DAY = 86400
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const SEND = 'https://www.googleapis.com/auth/gmail.send'

async function setup(withRead = true) {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db)
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW, withRead })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: `${SEND}${withRead ? ' ' + GMAIL_READ_SCOPE : ''}`, id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
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
  // Test baseline is explicitly human-reviewed; no machine timing inference.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, gmail_id, thread_id) VALUES (?, 'A', ?, ?, 'Quick question', 'bodybodybodybodybodybody', 'sent', ?, ?, ?, ?)").run(mid, lead, to, sentAt, sentAt, 'g-' + mid, 't-' + mid)
  return { lead, mid, thread: 't-' + mid }
}

const b64 = (s: string) => Buffer.from(s).toString('base64url')
// A notice in its own thread, as Gmail returns it: multipart/report with a delivery-status part and the original headers.
const dsn = (id: string, o: { rcpt: string; mid: string; action?: string; status?: string; from?: string; auth?: string; inAttachment?: boolean; at?: number; structured?: boolean }) => ({
  id, threadId: `dsn-thread-${id}`, internalDate: String((o.at ?? NOW - DAY) * 1000),
  payload: { mimeType: 'multipart/report', headers: [{ name: 'From', value: `Mail Delivery Subsystem <${o.from ?? 'mailer-daemon@googlemail.com'}>` }, { name: 'Subject', value: 'Delivery Status Notification (Failure)' }, ...(o.auth ? [{ name: 'Authentication-Results', value: o.auth }] : [])],
    parts: [
      { mimeType: 'text/plain', body: { data: b64(`Address not found. Your message to ${o.rcpt} could not be delivered. 550 5.1.1 The email account does not exist.`) } },
      ...(o.structured === false ? [] : [
        o.inAttachment ? { mimeType: 'message/delivery-status', body: { attachmentId: `att-${id}`, size: 120 } } : { mimeType: 'message/delivery-status', body: { data: b64(`Reporting-MTA: dns; googlemail.com\n\nFinal-Recipient: rfc822; ${o.rcpt}\nAction: ${o.action ?? 'failed'}\nStatus: ${o.status ?? '5.1.1'}\n`) } },
        { mimeType: 'text/rfc822-headers', body: { data: b64(`From: Pat <me@acme.example>\nTo: ${o.rcpt}\nMessage-ID: <${o.mid}>\nSubject: Quick question\n`) } },
      ]),
    ] },
})
// Stubbed Gmail: the outreach threads (empty: the notice is NOT in them), the delivery-notice search, and the notices.
function mailbox(notices: ReturnType<typeof dsn>[], o: { searchStatus?: number; attachments?: Record<string, string> } = {}, calls: string[] = []) {
  return (async (url: string) => {
    const u = String(url); calls.push(u)
    if (u.includes('oauth2')) return json({ access_token: 'at' })
    if (/threads\//.test(u)) return json({ messages: [] })
    if (u.includes('messages?q=')) return o.searchStatus ? json({}, o.searchStatus) : json({ messages: notices.map(n => ({ id: n.id, threadId: n.threadId })) })
    const a = u.match(/messages\/([^/?]+)\/attachments\/([^/?]+)/); if (a) return json({ data: b64(o.attachments?.[a[2]] ?? '') })
    const m = u.match(/messages\/([^/?]+)\?format=full/); if (m) { const n = notices.find(x => x.id === m[1]); return n ? json(n) : json({}, 404) }
    return json({}, 404)
  }) as unknown as typeof fetch
}
const ID = (mid: string) => `dazl.${mid}@acme.example`
const bounceCount = (db: Database.Database) => (db.prepare("SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = 'A' AND action = 'bounce'").get() as { n: number }).n
const sync = (db: Database.Database, f: typeof fetch) => syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl: f })

test('a permanent DSN on a DIFFERENT thread for a recorded message: recipient suppressed, sequence and thread stopped, counted once', async () => {
  const db = await setup(); migrateSequences(db)
  const s = sentLead(db, 'gone@three.example'), other = sentLead(db, 'still@four.example')
  db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES ('seq1', 'A', ?, ?, 'gone@three.example', 'active')").run(s.lead, s.mid)
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at) VALUES ('A', ?, ?, 'gone@three.example', ?, ?)").run(s.thread, s.lead, ID(s.mid), NOW - 4 * DAY)
  const box = mailbox([dsn('n1', { rcpt: 'gone@three.example', mid: ID(s.mid) })])
  const r = await sync(db, box)
  assert.deepEqual([r.bounces, r.bounce_coverage, r.error], [1, 'checked', undefined])   // before the fix: 0 bounces, never searched
  assert.equal(isSuppressed(db, 'A', 'gone@three.example'), true)
  assert.equal(isSuppressed(db, 'A', 'still@four.example'), false)
  assert.deepEqual(db.prepare("SELECT status, stop_reason FROM sequences WHERE id = 'seq1'").get(), { status: 'stopped', stop_reason: 'suppressed' }) // the suppression stops it
  assert.equal((db.prepare('SELECT stopped FROM followup_threads WHERE thread_id = ?').get(s.thread) as { stopped: string }).stopped, 'bounce')
  assert.deepEqual(db.prepare("SELECT classification, outreach_message_id, thread_id FROM inbound_messages WHERE gmail_id = 'n1'").get(), { classification: 'bounce', outreach_message_id: s.mid, thread_id: s.thread }) // recorded in the send's own conversation
  // the same notice on the next sync is not counted again
  assert.equal((await sync(db, box)).bounces, 0)
  assert.equal(bounceCount(db), 1)
  void other
})

test('forged, unrelated or uncorrelated notices suppress nobody', async () => {
  const db = await setup()
  const a = sentLead(db, 'alice@one.example'), b = sentLead(db, 'bob@two.example')
  const notices = [
    dsn('f1', { rcpt: 'bob@two.example', mid: ID(a.mid) }),                                   // names Bob, but the message went to Alice
    dsn('f2', { rcpt: 'alice@one.example', mid: ID('00000000000000000000aaaa') }),            // a message id dazl never sent
    dsn('f3', { rcpt: 'alice@one.example', mid: `dazl.${a.mid}@elsewhere.example` }),          // dazl-shaped, another sender domain
    dsn('f4', { rcpt: 'alice@one.example', mid: ID(a.mid), auth: 'mx.google.com; dkim=fail header.d=googlemail.com; spf=fail' }), // unauthenticated
    dsn('f5', { rcpt: 'alice@one.example', mid: ID(a.mid), structured: false }),               // only a code quoted in text
    dsn('f6', { rcpt: 'alice@one.example', mid: ID(a.mid), from: 'attacker@evil.example' }),   // not a delivery-notice sender at all
    dsn('f7', { rcpt: 'alice@one.example', mid: ID(a.mid), at: NOW - 30 * DAY }),              // older than the send it names
  ]
  const r = await sync(db, mailbox(notices))
  assert.equal(r.bounces, 0)
  for (const e of ['alice@one.example', 'bob@two.example']) assert.equal(isSuppressed(db, 'A', e), false, e)
  assert.equal(bounceCount(db), 0)
  // an uncorrelated notice is not stored anywhere (it may be about the user's own mail): no Inbox thread, no excerpt
  assert.equal((db.prepare('SELECT count(*) AS n FROM inbound_messages').get() as { n: number }).n, 0)
  void b
})

test('another tenant\'s message id never suppresses in this tenant', async () => {
  const db = await setup(); const s = sentLead(db, 'x@one.example')
  db.prepare("UPDATE outreach_messages SET tenant_id = 'B' WHERE id = ?").run(s.mid)
  assert.equal((await sync(db, mailbox([dsn('t1', { rcpt: 'x@one.example', mid: ID(s.mid) })]))).bounces, 0)
  assert.equal(isSuppressed(db, 'A', 'x@one.example'), false)
})

test('a soft (4.x.x / delayed) notice is recorded, never a permanent bounce', async () => {
  const db = await setup(); const s = sentLead(db, 'slow@one.example')
  const r = await sync(db, mailbox([dsn('s1', { rcpt: 'slow@one.example', mid: ID(s.mid), action: 'delayed', status: '4.4.7' }), dsn('s2', { rcpt: 'slow@one.example', mid: ID(s.mid), action: 'failed', status: '4.2.2' })]))
  assert.equal(r.bounces, 0); assert.equal(isSuppressed(db, 'A', 'slow@one.example'), false)
  assert.deepEqual((db.prepare("SELECT classification FROM inbound_messages ORDER BY gmail_id").all() as { classification: string }[]).map(x => x.classification), ['soft_bounce', 'soft_bounce'])
})

test('the delivery-status part delivered as an attachment is read (same read scope) and correlates', async () => {
  const db = await setup(); const s = sentLead(db, 'att@one.example')
  const r = await sync(db, mailbox([dsn('a1', { rcpt: 'att@one.example', mid: ID(s.mid), inAttachment: true })], { attachments: { 'att-a1': 'Reporting-MTA: dns; x\n\nFinal-Recipient: rfc822;att@one.example\nAction: failed\nStatus: 5.2.1\n' } }))
  assert.equal(r.bounces, 1); assert.equal(isSuppressed(db, 'A', 'att@one.example'), true)
})

test('coverage is unknown, not healthy, when notices cannot be read: no read grant, or the search fails', async () => {
  const noRead = await setup(false); sentLead(noRead, 'n@one.example')
  const a = await sync(noRead, mailbox([]))
  assert.deepEqual([a.error, a.bounce_coverage], ['reading_not_enabled', 'unknown'])
  const db = await setup(); sentLead(db, 'n@one.example')
  assert.equal((await sync(db, mailbox([], { searchStatus: 403 }))).bounce_coverage, 'unknown')
  assert.equal((await sync(db, mailbox([]))).bounce_coverage, 'checked')
})

test('the search is narrow: only delivery-notice senders are listed, and only what it returns is opened', async () => {
  const db = await setup(); const s = sentLead(db, 'n@one.example'); const calls: string[] = []
  await sync(db, mailbox([dsn('q1', { rcpt: 'n@one.example', mid: ID(s.mid) })], {}, calls))
  const gm = calls.filter(u => u.includes('gmail.googleapis.com'))
  assert.deepEqual(gm.filter(u => u.includes('messages?')), [`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(DSN_QUERY)}&maxResults=50`])
  assert.deepEqual(gm.filter(u => /messages\/[^?]+\?format=full/.test(u)), ['https://gmail.googleapis.com/gmail/v1/users/me/messages/q1?format=full'])
  assert.equal(DSN_QUERY, 'from:(mailer-daemon OR postmaster) newer_than:30d')
})

test('parseDsn / outreachIdOf: structured fields only, and dazl ids of every send kind', () => {
  const p = parseDsn({ mimeType: 'message/delivery-status', body: { data: b64('Reporting-MTA: dns; x\n\nFinal-Recipient: rfc822; <A@B.example>\nAction: Failed\nStatus: 5.7.1\n\nFinal-Recipient: rfc822; c@d.example\nAction: delivered\nStatus: 2.0.0\n') } })
  assert.deepEqual(p.recipients, [{ final: 'a@b.example', action: 'failed', status: '5.7.1' }, { final: 'c@d.example', action: 'delivered', status: '2.0.0' }])
  assert.equal(outreachIdOf('dazl.0123456789abcdef01234567@acme.example', 'acme.example'), '0123456789abcdef01234567')
  assert.equal(outreachIdOf('dazl.f2.0123456789abcdef01234567@acme.example', 'acme.example'), '0123456789abcdef01234567')
  assert.equal(outreachIdOf('dazl.reopen.0123456789abcdef01234567@acme.example', 'acme.example'), '0123456789abcdef01234567')
  assert.equal(outreachIdOf('dazl.0123456789abcdef01234567@other.example', 'acme.example'), null)
  assert.equal(outreachIdOf('random@acme.example', 'acme.example'), null)
})
