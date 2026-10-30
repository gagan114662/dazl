import { migrateConnectors } from '../lib/connectors/store.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings, isSuppressed } from '../lib/outreach/service.ts'
import { migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { acceptReadConsent, bounceCoverage, migrateReplies, revokeReadConsent, syncReplies } from '../lib/outreach/replies.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { dazlMessageRef, parseDsn } from '../lib/outreach/dsn.ts'

// #415: delivery-failure notices that arrive on a different Gmail thread from the email they return. Provider fixtures
// are synthetic Gmail API payloads in the RFC 3464 shape (multipart/report with message/delivery-status and the
// returned headers); Gmail is a stub at the HTTP level. Nothing is sent or read for real.
const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const DAY = 86400
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const b64 = (s: string) => Buffer.from(s).toString('base64url')
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const SEND = 'https://www.googleapis.com/auth/gmail.send'

async function setup(withRead = true) {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db)
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW, withRead })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: `${SEND}${withRead ? ' ' + GMAIL_READ_SCOPE : ''}`, id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  acceptReadConsent(db, 'A')
  return db
}
// A sent first touch, in its own thread, with an active cold sequence behind it.
function sent(db: Database.Database, to: string) {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex'), mid = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, 'Northside', ?, 'Hiring', 'https://n.example/a', 'Northside is hiring', 90)").run(lead, job, to)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, gmail_id, thread_id) VALUES (?, 'A', ?, ?, 'Quick question', 'bodybodybodybodybodybody', 'sent', ?, ?, ?, ?)").run(mid, lead, to, NOW - 2 * DAY, NOW - 2 * DAY, 'g-' + mid, 't-' + mid)
  db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES (?, 'A', ?, ?, ?, 'active')").run('seq-' + mid, lead, mid, to)
  return { lead, mid, thread: 't-' + mid, messageId: `dazl.${mid}@acme.example` }
}
// A delivery-status notice in RFC 3464 shape, on its own thread (not the original's).
function notice(id: string, o: { recipient: string; originalId: string; status?: string; action?: string; from?: string; report?: boolean }) {
  const status = o.status ?? '5.1.1', action = o.action ?? 'failed'
  return {
    id, threadId: 'dsn-thread-' + id, internalDate: String((NOW - DAY) * 1000),
    payload: {
      mimeType: o.report === false ? 'multipart/mixed' : 'multipart/report',
      headers: [{ name: 'From', value: `Mail Delivery Subsystem <${o.from ?? 'mailer-daemon@googlemail.com'}>` }, { name: 'Subject', value: 'Delivery Status Notification (Failure)' }],
      parts: [
        { mimeType: 'text/plain', body: { data: b64(`Your message wasn't delivered to ${o.recipient} because the address couldn't be found.`) } },
        { mimeType: 'message/delivery-status', body: { data: b64(`Reporting-MTA: dns; googlemail.com\n\nFinal-Recipient: rfc822; ${o.recipient}\nAction: ${action}\nStatus: ${status}\nDiagnostic-Code: smtp; 550 ${status} user unknown\n`) } },
        { mimeType: 'text/rfc822-headers', body: { data: b64(`From: Pat <me@acme.example>\nTo: ${o.recipient}\nSubject: Quick question\nMessage-ID: <${o.originalId}>\n`) } },
      ],
    },
  }
}
// Stub Gmail: threads hold nothing; the search returns the given notices (whatever the query); every call is recorded.
function gmail(notices: ReturnType<typeof notice>[], calls: string[] = []) {
  const fetchImpl = (async (u: unknown) => {
    const url = String(u); calls.push(url)
    if (url.includes('oauth2')) return json({ access_token: 'at' })
    if (url.includes('/threads/')) return json({ messages: [] })
    if (/\/messages\?q=/.test(url)) return json({ messages: notices.map(n => ({ id: n.id, threadId: n.threadId })) })
    const m = url.match(/\/messages\/([^?]+)\?format=full/); if (m) { const n = notices.find(x => x.id === m[1]); return n ? json(n) : json({}, 404) }
    return json({}, 404)
  }) as unknown as typeof fetch
  return { env: genv, master, now: NOW, fetchImpl }
}
const bounces = (db: Database.Database) => (db.prepare("SELECT count(*) AS n FROM autopilot_audit WHERE action = 'bounce'").get() as { n: number }).n
const seqStatus = (db: Database.Database, mid: string) => (db.prepare('SELECT status FROM sequences WHERE message_id = ?').get(mid) as { status: string }).status

test('#415 a permanent-failure notice on a different thread suppresses the recipient, stops the sequence and counts once', async () => {
  const db = await setup(); const a = sent(db, 'owner@northside.example'); const other = sent(db, 'ok@fine.example')
  const n1 = notice('dsn1', { recipient: 'owner@northside.example', originalId: a.messageId })
  const r = await syncReplies(db, 'A', gmail([n1]))
  assert.equal(r.error, undefined)
  assert.equal(r.bounces, 1)
  assert.equal(isSuppressed(db, 'A', 'owner@northside.example'), true)
  assert.equal(seqStatus(db, a.mid), 'stopped')
  assert.equal(bounces(db), 1)
  assert.equal(isSuppressed(db, 'A', 'ok@fine.example'), false); assert.equal(seqStatus(db, other.mid), 'active', 'nobody else affected')
  assert.deepEqual(db.prepare('SELECT thread_id, classification, outreach_message_id FROM inbound_messages').all(), [{ thread_id: a.thread, classification: 'bounce', outreach_message_id: a.mid }], 'recorded on the original thread')
  // The same notice again, and a second notice for the same email: still one bounce.
  const again = await syncReplies(db, 'A', gmail([n1, notice('dsn2', { recipient: 'owner@northside.example', originalId: a.messageId })]))
  assert.equal(again.bounces, 0); assert.equal(bounces(db), 1)
})

test('#415 forged or unrelated notices change nothing and are not stored', async () => {
  const db = await setup(); const a = sent(db, 'owner@northside.example'); const b = sent(db, 'buyer@second.example')
  const cases = [
    // Our Message-ID, but the failure is reported for someone else: neither that address nor ours is suppressed.
    notice('f1', { recipient: 'buyer@second.example', originalId: a.messageId }),
    // A Message-ID dazl never sent, a dazl-shaped id from another sending domain, a sender that is not a mail system,
    // and a plain email quoting "550 5.1.1" (no delivery-status report).
    notice('f2', { recipient: 'owner@northside.example', originalId: `dazl.${'0'.repeat(24)}@acme.example` }),
    notice('f3', { recipient: 'owner@northside.example', originalId: `dazl.${a.mid}@evil.example` }),
    notice('f4', { recipient: 'owner@northside.example', originalId: a.messageId, from: 'prankster@evil.example' }),
    notice('f5', { recipient: 'owner@northside.example', originalId: a.messageId, report: false }),
  ]
  const r = await syncReplies(db, 'A', gmail(cases))
  assert.deepEqual([r.error, r.bounces, bounces(db)], [undefined, 0, 0])
  for (const e of ['owner@northside.example', 'buyer@second.example']) assert.equal(isSuppressed(db, 'A', e), false, e)
  assert.deepEqual([seqStatus(db, a.mid), seqStatus(db, b.mid)], ['active', 'active'])
  assert.equal((db.prepare('SELECT count(*) AS n FROM inbound_messages').get() as { n: number }).n, 0, 'unrelated mailbox content is not kept')
})

test('#415 a soft or delayed failure is never a permanent bounce', async () => {
  const db = await setup(); const a = sent(db, 'owner@northside.example')
  const r = await syncReplies(db, 'A', gmail([notice('s1', { recipient: 'owner@northside.example', originalId: a.messageId, status: '4.2.2', action: 'delayed' })]))
  assert.equal(r.bounces, 0)
  assert.equal(isSuppressed(db, 'A', 'owner@northside.example'), false)
  assert.equal(seqStatus(db, a.mid), 'active')
  assert.deepEqual(db.prepare('SELECT classification FROM inbound_messages').all(), [{ classification: 'soft_bounce' }])
})

test('#415 the search is narrow (mail system senders, the recipients still being emailed); without permission nothing is read and coverage is unknown', async () => {
  const db = await setup(); const a = sent(db, 'owner@northside.example'); sent(db, 'gone@bounced.example')
  db.prepare("INSERT INTO suppressions (tenant_id, email, reason) VALUES ('A', 'gone@bounced.example', 'bounce')").run()
  const calls: string[] = []
  await syncReplies(db, 'A', gmail([], calls))
  const q = calls.filter(c => c.includes('/messages?q=')).map(c => decodeURIComponent(new URL(c).searchParams.get('q')!))
  assert.equal(q.length, 1)
  assert.match(q[0], /^from:\(mailer-daemon OR postmaster\) after:\d+ \{"owner@northside\.example"\}$/, 'only mail-system notices naming a recipient still being emailed')
  assert.equal(bounceCoverage(db, 'A'), 'checked')
  void a
  // Revoked read consent: zero provider calls, and delivery is unknown rather than fine.
  revokeReadConsent(db, 'A'); calls.length = 0
  assert.equal((await syncReplies(db, 'A', gmail([notice('x', { recipient: 'owner@northside.example', originalId: a.messageId })], calls))).error, 'reading_not_enabled')
  assert.equal(calls.length, 0)
  assert.equal(bounceCoverage(db, 'A'), 'unknown')
  const noRead = await setup(false)
  assert.equal(bounceCoverage(noRead, 'A'), 'unknown')
})

test('#415 the parser reads only structured fields; dazl Message-IDs of every kind map to their email', () => {
  assert.equal(parseDsn({ mimeType: 'text/plain', body: { data: b64('550 5.1.1 user unknown') } }), null)
  const p = parseDsn(notice('p', { recipient: 'A@B.example', originalId: 'x@y' }).payload)!
  assert.deepEqual(p, { recipients: [{ recipient: 'a@b.example', action: 'failed', status: '5.1.1' }], originalIds: ['<x@y>'] })
  const id = 'ab'.repeat(12)
  for (const pre of ['', 's2.', 'f0.', 'reopen.']) assert.deepEqual(dazlMessageRef(`<dazl.${pre}${id}@Acme.example>`), { id, domain: 'acme.example' })
  assert.equal(dazlMessageRef('<abc@acme.example>'), null)
})
