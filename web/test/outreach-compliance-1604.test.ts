// #1797 / #1604 (OK4/E4): CASL / CAN-SPAM proof. Every email dazl sends to a prospect — the first-touch
// draft, each sequence step, and a warm follow-up — must carry a working unsubscribe link, the sender's
// name and the business postal address; a missing sender identity must refuse the send, never send a
// bare email; and an unsubscribe click must mark the contact do-not-contact and stop follow-ups.
// These tests drive the real send paths end to end with injected Gmail transports and read the actual
// MIME that would leave the building.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateAutopilot, enable, CONSENT_VERSION, ATTESTATIONS } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { migrateReplies, acceptReadConsent, syncReplies } from '../lib/outreach/replies.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { approve, isSuppressed, saveSettings, sendMessage, unsubscribeByToken } from '../lib/outreach/service.ts'
import { migrateSequences, createSequence, approveSequence, runSequences } from '../lib/outreach/sequences.ts'
import { runFollowups, setFollowups } from '../lib/outreach/followups.ts'

const NOW = 1_800_000_000, DAY = 86400
const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', PUBLIC_BASE_URL: 'https://app.test' }
const NAME = 'Pat Smith'
const ADDRESS = '1 King St W, Toronto ON M5H 1A1, Canada'
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'

async function setup(withIdentity = true) {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db)
  const state = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'test-token', scope: `https://www.googleapis.com/auth/gmail.send ${GMAIL_READ_SCOPE}`, id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  if (withIdentity) {
    saveSettings(db, 'A', { sender_name: NAME, postal_address: ADDRESS })
    enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 25 })
  }
  acceptReadConsent(db, 'A')
  return db
}

// A reviewed lead plus a saved draft, inserted the way the sequences suite does: the compliance
// surface under test is the send composition, not draft creation.
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
  // Captured as headers + decoded body: the wire MIME base64-encodes the body, and the assertions
  // below read the email the way the recipient's client renders it.
  const sendFn = (async (_t: string, raw: string) => {
    const mime = Buffer.from(raw, 'base64url').toString('utf8')
    const split = mime.indexOf('\r\n\r\n')
    const body = Buffer.from(mime.slice(split + 4).replace(/\s+/g, ''), 'base64').toString('utf8')
    calls.push(mime.slice(0, split) + '\n\n' + body)
    return { id: `gm${calls.length}`, threadId: 'thread-1' }
  }) as never
  return { calls, fetchImpl, sendFn, env, master, now: NOW, baseUrl: 'https://app.test', flags: { SEQUENCES_ENABLED: '1', AUTOPILOT_AVAILABLE: '1', AUTOPILOT_ENABLED: '1' } }
}

// The compliance contract on one captured email: sender name, postal address, a List-Unsubscribe header
// and a body unsubscribe link pointing at the same URL. Returns the token from that URL.
function assertCompliant(raw: string, label: string): string {
  assert.ok(raw.includes(NAME), `${label}: sender name missing from the email`)
  assert.ok(raw.includes(ADDRESS), `${label}: postal address missing from the email`)
  const header = raw.match(/List-Unsubscribe: <(https:[^>]+)>/)
  assert.ok(header, `${label}: no List-Unsubscribe header`)
  assert.ok(raw.includes(`unsubscribe here: ${header[1]}`), `${label}: body unsubscribe link missing or differs from the header`)
  const token = new URL(header[1]).searchParams.get('t')
  assert.ok(token, `${label}: unsubscribe URL carries no token`)
  return token
}

test('the composed draft, as sent, carries name, address and a working unsubscribe', async () => {
  const db = await setup()
  const { mid: id } = addDraft(db)
  approve(db, 'A', id)
  const m = mock()
  await sendMessage(db, 'A', id, m)
  assert.equal(m.calls.length, 1)
  const token = assertCompliant(m.calls[0], 'first-touch draft')
  assert.equal(unsubscribeByToken(db, token, master), true, 'the link in the sent email resolves')
  assert.equal(isSuppressed(db, 'A', 'lead@acme.example'), true, 'the click marks the contact do-not-contact')
})

test('the stored draft is bare by design; the footer exists in what is actually sent', async () => {
  const db = await setup()
  const { mid: id } = addDraft(db)
  const stored = (db.prepare('SELECT body FROM outreach_messages WHERE id = ?').get(id) as { body: string }).body
  assert.ok(!stored.includes(ADDRESS) && !/unsubscribe/i.test(stored), 'the saved words carry no footer — it is appended by the send path, so it can never be edited out of a draft')
  approve(db, 'A', id)
  const m = mock()
  await sendMessage(db, 'A', id, m)
  assertCompliant(m.calls[0], 'first-touch draft')
})

test('every sequence step carries name, address and a working unsubscribe', async () => {
  const db = await setup()
  const { mid } = addDraft(db)
  const seq = createSequence(db, 'A', mid)
  approveSequence(db, 'A', seq, (id) => approve(db, 'A', id, true), NOW)
  const m = mock()
  await sendMessage(db, 'A', mid, m)
  assert.equal((await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 3 * DAY })).sent, 1, 'step 2 sends at day 3')
  assert.equal((await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 7 * DAY })).sent, 1, 'step 3 sends at day 7')
  assert.equal(m.calls.length, 3)
  const token = assertCompliant(m.calls[2], 'sequence step 3')
  assertCompliant(m.calls[1], 'sequence step 2')
  assert.equal(unsubscribeByToken(db, token, master), true, 'the step-3 link resolves')
  assert.equal(isSuppressed(db, 'A', 'lead@acme.example'), true)
})

test('an unsubscribe after step 1 stops the sequence follow-ups', async () => {
  const db = await setup()
  const { mid } = addDraft(db)
  const seq = createSequence(db, 'A', mid)
  approveSequence(db, 'A', seq, (id) => approve(db, 'A', id, true), NOW)
  const m = mock()
  await sendMessage(db, 'A', mid, m)
  const token = assertCompliant(m.calls[0], 'sequence step 1')
  assert.equal(unsubscribeByToken(db, token, master), true)
  assert.equal((await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 3 * DAY })).sent, 0, 'step 2 never sends after an unsubscribe')
  assert.equal((await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 7 * DAY })).sent, 0, 'step 3 never sends either')
  assert.equal(m.calls.length, 1, 'only the first email ever left')
  const st = (db.prepare('SELECT status FROM sequences WHERE id = ?').get(seq) as { status: string }).status
  assert.equal(st, 'stopped', 'the sequence is stopped, not merely paused')
})

test('a warm follow-up carries the same footer, and an unsubscribe stops follow-ups', async () => {
  const db = await setup()
  const { mid } = addDraft(db)
  approve(db, 'A', mid)
  const m = mock('Interested, tell me more', NOW - 4 * DAY)
  await sendMessage(db, 'A', mid, { ...m, now: NOW - 4 * DAY })
  await syncReplies(db, 'A', { env, master, now: NOW, fetchImpl: m.fetchImpl })
  setFollowups(db, 'A', true)
  const r = await runFollowups(db, 'A', 'Acme', { ...m, now: NOW })
  assert.equal(r.sent, 1, 'the follow-up sends to an interested reply')
  const token = assertCompliant(m.calls[m.calls.length - 1], 'warm follow-up')
  assert.equal(unsubscribeByToken(db, token, master), true)
  const r2 = await runFollowups(db, 'A', 'Acme', { ...m, now: NOW + 5 * DAY })
  assert.equal(r2.sent, 0, 'no further follow-up after the unsubscribe')
})

test('missing sender identity refuses every send path; blank identity cannot be saved', async () => {
  assert.throws(() => saveSettings(new Database(':memory:'), 'A', { sender_name: '', postal_address: ADDRESS }), /bad_sender_name/)
  const bare = new Database(':memory:'); migrateOutreach(bare)
  assert.throws(() => saveSettings(bare, 'A', { sender_name: NAME, postal_address: 'short' }), /bad_postal_address/)

  // The strongest case: identity existed at approval time and is removed afterwards — the sends
  // must still refuse. (With no identity at all, even approval refuses, which the setup shows.)
  const db = await setup()
  const { mid } = addDraft(db)
  const seq = createSequence(db, 'A', mid)
  approveSequence(db, 'A', seq, (id) => approve(db, 'A', id, true), NOW)
  db.prepare("DELETE FROM outreach_settings WHERE tenant_id = 'A'").run()
  const m = mock()
  await assert.rejects(sendMessage(db, 'A', mid, m), /sender_identity_missing/, 'the first-touch send refuses')
  assert.equal((await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 3 * DAY })).sent, 0, 'sequence steps refuse')
  assert.equal(m.calls.length, 0, 'nothing bare ever leaves')
})
