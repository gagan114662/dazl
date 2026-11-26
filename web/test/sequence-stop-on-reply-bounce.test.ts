// #1802: follow-ups stop on a reply or a bounce — proof. Once a lead replies, hard-bounces, or is marked
// do-not-contact by hand, no later sequence step may send, and the reason the lead shows must be plain
// words ('Replied', 'Email bounced'), never a stored code. Gmail is send-only (#413), so a reply is
// known through the reply sync when reading is consented, and otherwise through the user's own hand:
// the manual paths proven here are the do-not-contact suppression and the sequence stop, the same
// writes the UI performs. The stored stop_reason codes stay untouched (audit evidence, pinned by the
// delivery-notices and legal-policy suites); the plain words are a read-time mapping in sequences.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateAutopilot, enable, CONSENT_VERSION, ATTESTATIONS } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { migrateReplies, acceptReadConsent, hasReadConsent, revokeReadConsent, syncReplies } from '../lib/outreach/replies.ts'
import { completeOAuth, gmailStatus, startOAuth, GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } from '../lib/gmail/oauth.ts'
import { approve, saveSettings, sendMessage, suppress } from '../lib/outreach/service.ts'
import { migrateSequences, createSequence, approveSequence, runSequences, sequenceStatusByLead, stopSequenceForThread } from '../lib/outreach/sequences.ts'
import { applyBounceVerdict } from '../lib/outreach/bounce-ledger.ts'

const NOW = 1_800_000_000, DAY = 86400
const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', PUBLIC_BASE_URL: 'https://app.test' }
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'

async function connectMailbox(db: Database.Database, scope: string) {
  const state = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env, master, now: NOW, fetchImpl: async () => json({
    refresh_token: 'test-token', scope, id_token: idToken('me@acme.example'),
  }) })
}

async function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db)
  await connectMailbox(db, `${GMAIL_SEND_SCOPE} ${GMAIL_READ_SCOPE}`)
  saveSettings(db, 'A', { sender_name: 'Pat Smith', postal_address: '1 King St W, Toronto ON M5H 1A1, Canada' })
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 25 })
  acceptReadConsent(db, 'A')
  return db
}

function addDraft(db: Database.Database, email = 'lead@acme.example') {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex'), mid = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?,?,?,?,?,?,?,?)')
    .run(lead, job, 'Acme', email, 'Hiring roofers', 'https://acme.example/jobs', 'Acme is hiring roofers', 90)
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE id=?").run(lead)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body) VALUES (?, 'A', ?, ?, 'A quick question', 'This is a draft message for review.')").run(mid, lead, email)
  return { lead, mid }
}

function mock(reply?: string, replyAt = NOW + 1) {
  const calls: string[] = []
  const fetchImpl = (async (u: unknown) => {
    const url = String(u)
    if (url.includes('oauth2')) return json({ access_token: 'access' })
    if (url.includes('/threads/')) return json({ messages: reply ? [{ id: 'reply-1', internalDate: String(replyAt * 1000), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'lead@acme.example' }], body: { data: Buffer.from(reply).toString('base64url') } } }] : [] })
    if (url.includes('messages?q=')) return json({ messages: [] })
    return json({}, 404)
  }) as unknown as typeof fetch
  const sendFn = (async (_t: string, raw: string) => { calls.push(raw); return { id: `gm${calls.length}`, threadId: 'thread-1' } }) as never
  return { calls, fetchImpl, sendFn, env, master, now: NOW, baseUrl: 'https://app.test', flags: { SEQUENCES_ENABLED: '1', AUTOPILOT_AVAILABLE: '1', AUTOPILOT_ENABLED: '1' } }
}

// An approved sequence with step 1 sent and the sequence started: the state every stop must interrupt.
async function started(db: Database.Database, m: ReturnType<typeof mock>) {
  const { lead, mid } = addDraft(db)
  const seq = createSequence(db, 'A', mid)
  approveSequence(db, 'A', seq, (id) => approve(db, 'A', id, true), NOW)
  await sendMessage(db, 'A', mid, { ...m, now: NOW })
  const r = await runSequences(db, 'A', 'Acme', { ...m, now: NOW })
  assert.equal(r.started, 1, 'the sequence starts on the sent first step')
  return { lead, mid, seq }
}

const byLead = (db: Database.Database, lead: string) => sequenceStatusByLead(db, 'A').get(lead)
const seqRow = (db: Database.Database, seq: string) => db.prepare('SELECT status, stop_reason FROM sequences WHERE id = ?').get(seq) as { status: string; stop_reason: string | null }

test('a reply stops the sequence: no later step sends, and the lead shows Replied', async () => {
  const db = await setup()
  const m = mock()
  const { lead, seq } = await started(db, m)
  // The reply lands after the start (a reply already in the inbox at the start tick blocks the start
  // instead — the same guard, one pass earlier), so it arrives on its own transport from here on.
  const m2 = mock('Interested, tell me more', NOW + 3600)
  await syncReplies(db, 'A', { ...m2, now: NOW + 3600 })
  assert.equal(seqRow(db, seq).status, 'replied', 'the reply sync marks the sequence replied at once')
  assert.equal((await runSequences(db, 'A', 'Acme', { ...m2, now: NOW + 3 * DAY })).sent, 0, 'step 2 never sends')
  assert.equal((await runSequences(db, 'A', 'Acme', { ...m2, now: NOW + 7 * DAY })).sent, 0, 'step 3 never sends')
  assert.equal(m.calls.length, 1, 'only the first step ever left')
  assert.equal(m2.calls.length, 0, 'nothing at all sends after the reply')
  assert.equal(byLead(db, lead)?.stop_reason, 'Replied', 'the lead-facing reason is the plain word')
})

test('a hard bounce stops the sequence and the lead shows Email bounced', async () => {
  const db = await setup()
  const m = mock()
  const { lead, mid, seq } = await started(db, m)
  const r = applyBounceVerdict(db, 'A', { kind: 'permanent', recipient: 'lead@acme.example', originalMessageId: 'orig-1', outreachMessageId: mid }, 'dsn', 'gmail-dsn-1', NOW + 60)
  assert.equal(r, 'recorded', 'the permanent verdict is accounted in the bounce ledger')
  assert.deepEqual(seqRow(db, seq), { status: 'stopped', stop_reason: 'suppressed' }, 'the stored code stays the pinned one — the plain words are read-time only')
  assert.equal((await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 3 * DAY })).sent, 0, 'step 2 never sends')
  assert.equal((await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 7 * DAY })).sent, 0, 'step 3 never sends')
  assert.equal(m.calls.length, 1)
  assert.equal(byLead(db, lead)?.stop_reason, 'Email bounced', 'a bounce is not labelled a do-not-contact or a reply')
})

test('a manual do-not-contact stops the sequence and reads as Do not contact', async () => {
  const db = await setup()
  const m = mock()
  const { lead, seq } = await started(db, m)
  suppress(db, 'A', 'lead@acme.example', 'manual') // the user's own mark: the write every DNC control funnels into
  assert.equal(seqRow(db, seq).status, 'stopped')
  assert.equal((await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 3 * DAY })).sent, 0)
  assert.equal((await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 7 * DAY })).sent, 0)
  assert.equal(m.calls.length, 1)
  assert.equal(byLead(db, lead)?.stop_reason, 'Do not contact')
})

test('an unsubscribe stops the sequence and reads as Unsubscribed', async () => {
  const db = await setup()
  const m = mock()
  const { lead } = await started(db, m)
  suppress(db, 'A', 'lead@acme.example', 'unsubscribe')
  assert.equal((await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 3 * DAY })).sent, 0)
  assert.equal(byLead(db, lead)?.stop_reason, 'Unsubscribed')
})

test('a manual stop prevents due follow-ups even when reply reading remains enabled', async () => {
  const db = await setup()
  const m = mock()
  const { lead, seq } = await started(db, m)
  assert.equal(hasReadConsent(db, 'A'), true)
  assert.equal(gmailStatus(db, 'A')?.read_granted, true)
  stopSequenceForThread(db, 'A', lead, 'stopped', 'user_stopped', NOW + 60)
  assert.equal(seqRow(db, seq).status, 'stopped')
  assert.equal((await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 3 * DAY })).sent, 0)
  assert.equal((await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 7 * DAY })).sent, 0)
  assert.equal(m.calls.length, 1)
  assert.equal(byLead(db, lead)?.stop_reason, 'Stopped by you')
})

test('after a send-only reconnect, manually stopping a sequence ends it and reads Stopped by you', async () => {
  const db = await setup()
  const m = mock()
  const { lead, seq } = await started(db, m)
  await connectMailbox(db, GMAIL_SEND_SCOPE)
  assert.equal(gmailStatus(db, 'A')?.read_granted, false)
  revokeReadConsent(db, 'A')
  assert.equal(hasReadConsent(db, 'A'), false)
  assert.equal(seqRow(db, seq).status, 'active')
  stopSequenceForThread(db, 'A', lead, 'stopped', 'user_stopped', NOW + 60) // the row the sequences page's stop action writes
  assert.deepEqual(seqRow(db, seq), { status: 'stopped', stop_reason: 'user_stopped' })
  assert.equal((await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 3 * DAY })).sent, 0)
  assert.equal((await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 7 * DAY })).sent, 0)
  assert.equal(m.calls.length, 1)
  assert.equal(byLead(db, lead)?.stop_reason, 'Stopped by you')
})

test('an unverified bounce notice does NOT stop the sequence as a reply', async () => {
  const db = await setup()
  const m = mock()
  const { lead, seq } = await started(db, m)
  // A delivery notice held for review (provenance unverified): it lands in the inbox as bounce_review,
  // applies no verdict and suppresses nobody. The tick must not read it as a reply.
  db.prepare("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES ('notice-1', 'A', 'thread-1', ?, 'mailer-daemon@googlemail.com', 'Delivery Status Notification', 'bounce_review', ?)").run(lead, NOW + 60)
  const r = await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 3 * DAY })
  assert.equal(r.sent, 1, 'step 2 still sends: the unverified notice stopped nothing')
  assert.equal(seqRow(db, seq).status, 'active', 'the sequence was not killed and labelled replied')
  assert.equal(byLead(db, lead)?.stop_reason, null)
})
