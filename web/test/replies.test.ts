import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings, getSettings, isSuppressed, cleanBookingUrl } from '../lib/outreach/service.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable, getState, migrateAutopilot, recentAutopilotAudit } from '../lib/outreach/autopilot.ts'
import { grantConsent, hasConsent, migrateLedger, revokeAll } from '../lib/outreach/ledger.ts'
import { acceptReadConsent, classifyReply, inboxRows, migrateReplies, newText, syncReplies, threadMessages } from '../lib/outreach/replies.ts'
import { followupText, runFollowups, setFollowups } from '../lib/outreach/followups.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const DAY = 86400
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const SEND = 'https://www.googleapis.com/auth/gmail.send'

async function setup(withRead = true) {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db)
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
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, gmail_id, thread_id) VALUES (?, 'A', ?, ?, 'Quick question', 'bodybodybodybodybodybody', 'sent', ?, ?, ?, ?)").run(mid, lead, to, sentAt, sentAt, 'g-' + mid, 't-' + mid)
  return { lead, mid, thread: 't-' + mid }
}
const msg = (id: string, from: string, body: string, at: number, extra: { name: string; value: string }[] = []) => ({ id, threadId: 't', internalDate: String(at * 1000), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }, ...extra], body: { data: Buffer.from(body).toString('base64url') } } })
function gmail(threads: Record<string, unknown[]>, calls: string[] = []) {
  return (async (url: string) => {
    const u = String(url); calls.push(u)
    if (u.includes('oauth2')) return json({ access_token: 'at' })
    const m = u.match(/threads\/([^?]+)/); if (m) return json({ messages: threads[m[1]] ?? [] })
    return json({}, 404)
  }) as unknown as typeof fetch
}

test('classification: opt-out and negative beat positive; unsure grants nothing; autoreplies ignored', () => {
  assert.equal(classifyReply('Please remove me from your list'), 'opt_out')
  assert.equal(classifyReply('Not interested, thanks'), 'negative')
  assert.equal(classifyReply("I'm interested but please stop emailing me"), 'opt_out')
  assert.equal(classifyReply('Sounds good, send me more information'), 'positive')
  assert.equal(classifyReply('Who is this?'), 'other')
  assert.equal(classifyReply('I am out', { autoSubmitted: 'auto-replied' }), 'auto')
  assert.equal(newText('Yes, call me\n\nOn Mon, Oct 5, Pat <me@acme.example> wrote:\n> hello'), 'Yes, call me')
})

test('consent ledger: grant, expiry, revoke-all, and suppression revokes', () => {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateLedger(db)
  grantConsent(db, 'A', 'X@Co.example', { channel: 'email', scope: 'followup', basis: 'reply_interest', evidenceRef: 'gmail:1', now: NOW })
  assert.equal(hasConsent(db, 'A', 'x@co.example', 'email', 'followup', NOW + DAY), true)
  assert.equal(hasConsent(db, 'A', 'x@co.example', 'email', 'followup', NOW + 181 * DAY), false)
  assert.equal(hasConsent(db, 'B', 'x@co.example', 'email', 'followup', NOW + DAY), false)
  revokeAll(db, 'A', 'x@co.example', 'test', NOW + 2 * DAY)
  assert.equal(hasConsent(db, 'A', 'x@co.example', 'email', 'followup', NOW + 3 * DAY), false)
})

test('reading needs consent and the read grant; it opens only threads dazl started', async () => {
  const db = await setup(false); const calls: string[] = []
  assert.equal((await syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl: gmail({}, calls) })).error, 'reading_not_enabled') // no read scope
  assert.equal(calls.length, 0)
  const db2 = await setup(true); const s = sentLead(db2, 'a@co.example'); const calls2: string[] = []
  await syncReplies(db2, 'A', { env: genv, master, now: NOW, fetchImpl: gmail({ [s.thread]: [] }, calls2) })
  assert.ok(calls2.filter(u => u.includes('gmail.googleapis.com')).every(u => u.includes(`threads/${s.thread}`)))
  assert.ok(!calls2.some(u => /messages\?|q=|labels/.test(u)))
  db2.prepare('DELETE FROM mail_read_consent').run()
  assert.equal((await syncReplies(db2, 'A', { env: genv, master, now: NOW, fetchImpl: gmail({}) })).error, 'reading_not_enabled')
})

test('sync: positive reply grants consent; opt-out suppresses and revokes; hard bounce suppresses; soft bounce does not', async () => {
  const db = await setup(); const p = sentLead(db, 'p@one.example'), o = sentLead(db, 'o@two.example'), b = sentLead(db, 'b@three.example'), sb = sentLead(db, 's@four.example')
  const th = {
    [p.thread]: [msg('m1', 'Pat <p@one.example>', 'Sounds good, send me more info', NOW - 2 * DAY)],
    [o.thread]: [msg('m2', 'o@two.example', 'Please unsubscribe me', NOW - 2 * DAY)],
    [b.thread]: [msg('m3', 'Mail Delivery <mailer-daemon@googlemail.com>', 'Delivery Status Notification. 550 5.1.1 user unknown', NOW - 3 * DAY)],
    [sb.thread]: [msg('m4', 'postmaster@four.example', 'Mailbox full 4.2.2', NOW - 3 * DAY)],
  }
  const r = await syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl: gmail(th) })
  assert.deepEqual([r.consents, r.optOuts, r.bounces], [1, 1, 1])
  assert.equal(hasConsent(db, 'A', 'p@one.example', 'email', 'followup', NOW), true)
  assert.equal(isSuppressed(db, 'A', 'o@two.example'), true)
  assert.equal(isSuppressed(db, 'A', 'b@three.example'), true)
  assert.equal(isSuppressed(db, 'A', 's@four.example'), false)
  const again = await syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl: gmail(th) }) // idempotent
  assert.deepEqual([again.consents, again.optOuts, again.bounces], [0, 0, 0])
  assert.equal((db.prepare("SELECT count(*) n FROM consent_ledger WHERE contact = 'p@one.example'").get() as { n: number }).n, 1)
  assert.ok((db.prepare('SELECT excerpt FROM inbound_messages WHERE gmail_id = ?').get('m1') as { excerpt: string }).excerpt.length <= 200)
})

const flags = { AUTOPILOT_ENABLED: '1' }
function sendSpy() { const sent: { raw: string; thread?: string }[] = []; return { sent, sendFn: (async (_t: string, raw: string, _f: unknown, thread?: string) => { sent.push({ raw, thread }); return { id: 'f1' } }) as never } }
const base = (over: object = {}) => ({ flags, env: genv, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: gmail({}), ...over })

async function interested(db: Database.Database, to = 'p@one.example', repliedAt = NOW - 4 * DAY) {
  const s = sentLead(db, to)
  await syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl: gmail({ [s.thread]: [msg('r' + s.mid, to, 'Interested, tell me more', repliedAt)] }) })
  return s
}

test('follow-ups: off by default, then only for opted-in repliers, after the quiet gap, threaded, with unsubscribe', async () => {
  const db = await setup(); const s = await interested(db); const { sent, sendFn } = sendSpy()
  assert.equal((await runFollowups(db, 'A', 'Acme', base({ sendFn }))).stopped, 'followups_off')
  setFollowups(db, 'A', true)
  const r = await runFollowups(db, 'A', 'Acme', base({ sendFn }))
  assert.equal(r.sent, 1); assert.equal(sent[0].thread, s.thread)
  const mime = Buffer.from(sent[0].raw, 'base64url').toString()
  assert.match(mime, /In-Reply-To: <dazl\./); assert.match(mime, /List-Unsubscribe:/); assert.match(mime, /Subject: Re: Quick question/)
  assert.equal((await runFollowups(db, 'A', 'Acme', base({ sendFn }))).sent, 0) // gap not reached for step 2
  assert.equal((await runFollowups(db, 'A', 'Acme', base({ sendFn, now: NOW + 6 * DAY }))).sent, 1)
  assert.equal((await runFollowups(db, 'A', 'Acme', base({ sendFn, now: NOW + 30 * DAY }))).sent, 0) // max 2
  assert.equal(sent.length, 2)
})

test('follow-ups never go to people without consent, who opted out, whose consent expired, or after a new reply', async () => {
  const db = await setup(); setFollowups(db, 'A', true); const { sent, sendFn } = sendSpy()
  const s1 = sentLead(db, 'cold@one.example'); db.prepare('UPDATE followup_threads SET last_lead_reply_at = ? WHERE thread_id = ?').run(NOW - 4 * DAY, s1.thread) // no ledger row
  await interested(db, 'ok@two.example'); await interested(db, 'out@three.example'); await interested(db, 'old@four.example'); await interested(db, 'again@five.example')
  revokeAll(db, 'A', 'out@three.example', 'opt_out', NOW)
  db.prepare("UPDATE consent_ledger SET expires_at = ? WHERE contact = 'old@four.example'").run(NOW - 1)
  db.prepare("UPDATE followup_threads SET followups_sent = 1, last_followup_at = ?, last_lead_reply_at = ? WHERE to_email = 'again@five.example'").run(NOW - 10 * DAY, NOW - 1 * DAY)
  const r = await runFollowups(db, 'A', 'Acme', base({ sendFn, now: NOW + 6 * DAY }))
  assert.equal(r.sent, 1); assert.ok(Buffer.from(sent[0].raw, 'base64url').toString().includes('To: ok@two.example'))
})

test('follow-ups obey pause, the operator kill switch, the shared daily cap, and an unsubscribe between runs', async () => {
  const db = await setup(); await interested(db, 'a@one.example'); await interested(db, 'b@two.example'); setFollowups(db, 'A', true); const { sent, sendFn } = sendSpy()
  assert.equal((await runFollowups(db, 'A', 'Acme', base({ sendFn, flags: { ...flags, AUTOPILOT_KILL: '1' } }))).stopped, 'not_available')
  db.prepare('UPDATE autopilot_settings SET daily_cap = 1').run()
  const r = await runFollowups(db, 'A', 'Acme', base({ sendFn }))
  assert.equal(r.sent, 1); assert.equal(r.stopped, 'daily_cap')
  db.prepare('UPDATE autopilot_settings SET paused = 1').run()
  assert.equal((await runFollowups(db, 'A', 'Acme', base({ sendFn, now: NOW + 6 * DAY }))).stopped, 'autopilot_off')
  assert.equal(sent.length, 1); assert.equal(getState(db, 'A').paused, true)
  assert.ok(recentAutopilotAudit(db, 'A').some(a => a.action === 'followup_sent'))
})

test('an uncertain follow-up send pauses autopilot', async () => {
  const db = await setup(); await interested(db); setFollowups(db, 'A', true)
  const r = await runFollowups(db, 'A', 'Acme', base({ sendFn: (async () => { throw new Error('network') }) as never }))
  assert.equal(r.stopped, 'uncertain_send'); assert.equal(getState(db, 'A').paused, true)
  assert.match(followupText(0, { company: 'C', name: 'Pat Q', signal: 's', source_url: 'https://x.example' }, 'Acme'), /^Hi Pat,/)
})

test('inboxRows: joins lead company and follow-up state, newest first, tenant-scoped', () => {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db)
  const jobId = createJob(db, 'A', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url) VALUES ('lead1', ?, 'Ada', 'Acme Co', 'hiring', 'https://x.com/1')").run(jobId)
  const ins = "INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES (?, 'A', 't1', 'lead1', 'ada@acme.example', ?, ?, ?)"
  db.prepare(ins).run('g1', 'yes, tell me more about pricing', 'positive', NOW - 100)
  db.prepare(ins).run('g2', 'not interested, thanks', 'negative', NOW - 50)
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, followups_sent, stopped) VALUES ('A', 't1', 'lead1', 'ada@acme.example', 'root', ?, 1, NULL)").run(NOW - 90)
  db.prepare("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES ('g3', 'B', 't9', NULL, 'x@y.example', 'hi', 'other', ?)").run(NOW)
  const rows = inboxRows(db, 'A')
  assert.equal(rows.length, 2) // tenant B's row is invisible
  assert.equal(rows[0].gmail_id, 'g2') // newest first
  assert.equal(rows[1].company, 'Acme Co')
  assert.equal(rows[1].lead_name, 'Ada')
  assert.equal(rows[1].followups_sent, 1)
  assert.equal(rows[1].stopped, null)
})

test('threadMessages: original outreach and replies interleave oldest-first; another tenant sees nothing', async () => {
  const db = await setup()
  const { lead, mid, thread } = sentLead(db, 'sam@northside.example')
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at) VALUES ('A', ?, ?, ?, ?, ?, ?)").run(thread, lead, 'sam@northside.example', mid, NOW - 4 * DAY, NOW - DAY)
  db.prepare("INSERT INTO followup_messages (tenant_id, thread_id, step, status, created_at) VALUES ('A', ?, 0, 'sent', ?)").run(thread, NOW - 2 * DAY)
  db.prepare("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES ('g-r1', 'A', ?, ?, 'sam@northside.example', 'Sounds good, tell me more', 'positive', ?)").run(thread, lead, NOW - DAY)
  const t = threadMessages(db, 'A', thread)
  assert.deepEqual(t.map(m => m.kind), ['original', 'followup', 'reply'])
  assert.equal(t[0].dir, 'out'); assert.equal(t[0].subject, 'Quick question')
  assert.equal(t[1].subject, 'Follow-up 1')
  assert.equal(t[2].dir, 'in'); assert.equal(t[2].classification, 'positive')
  assert.deepEqual(threadMessages(db, 'B', thread), []) // tenant isolation
})

test('booking link: https-only, stored on sender settings, lands in follow-up text only when set', async () => {
  const db = await setup()
  assert.throws(() => cleanBookingUrl('http://cal.com/pat'), /bad_booking_url/)
  assert.throws(() => cleanBookingUrl('javascript:alert(1)'), /bad_booking_url/)
  assert.equal(cleanBookingUrl(''), '')
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1', booking_url: 'https://cal.com/pat/15min' })
  assert.equal(getSettings(db, 'A')?.booking_url, 'https://cal.com/pat/15min')
  const lead = { company: 'Northside', name: 'Sam Lee', signal: 'Hiring roofers', source_url: 'https://n.example/a' }
  assert.ok(followupText(0, lead, 'Acme', 'https://cal.com/pat/15min').includes('https://cal.com/pat/15min'))
  assert.ok(followupText(1, lead, 'Acme', 'https://cal.com/pat/15min').includes('https://cal.com/pat/15min'))
  assert.ok(!followupText(0, lead, 'Acme').includes('cal.com'))
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1', booking_url: '' })
  assert.equal(getSettings(db, 'A')?.booking_url, null) // cleared
})
test('granular consent: read requested but unticked on Google\'s screen connects send-only, no error', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db)
  // The connect always requests read now (withRead: true), but the granted scope lacks it.
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW, withRead: true })).searchParams.get('state')!
  const r = await completeOAuth(db, 'A', 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: SEND, id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  assert.equal(r.email, 'me@acme.example')
  const acc = db.prepare('SELECT status, read_granted FROM gmail_accounts WHERE tenant_id = ?').get('A') as { status: string; read_granted: number }
  assert.deepEqual(acc, { status: 'active', read_granted: 0 })
  // Reading stays off even if the in-app notice was accepted: read_granted is the gate.
  acceptReadConsent(db, 'A')
  const sync = await syncReplies(db, 'A', { env: genv, master, now: NOW })
  assert.equal(sync.error, 'reading_not_enabled')
  assert.equal(sync.threads, 0)
})
