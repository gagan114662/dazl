import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings, type Deps } from '../lib/outreach/service.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable, migrateAutopilot, pause, runAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { acceptReadConsent, migrateReplies, revokeReadConsent } from '../lib/outreach/replies.ts'
import { migrateSequences, runSequences } from '../lib/outreach/sequences.ts'
import { AUTO_SEQUENCE_VERSION, autoSequencePolicy, autoSequenceStop, enrollAutoSequence, setAutoSequence } from '../lib/outreach/auto-sequence.ts'

// #414: autopilot's first touch, then the cold no-reply steps on day 3 and day 7, with no per-lead sequence creation or
// approval, under the account's versioned automatic follow-up policy. Stub Gmail (sendFn and HTTP), synthetic leads,
// fixed clock: nothing leaves the process and no scheduler or flag is turned on outside the test's own deps.
const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const DAY = 86400
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const SEND = 'https://www.googleapis.com/auth/gmail.send'
const FLAGS = { AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '2', SEQUENCES_ENABLED: '1' }

async function connect(db: Database.Database, email: string) {
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW, withRead: true })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: `${SEND} ${GMAIL_READ_SCOPE}`, id_token: idToken(email) })) as unknown as typeof fetch })
}
async function setup(policy = true) {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db); seedOffers(db)
  await connect(db, 'me@acme.example')
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 10 })
  acceptReadConsent(db, 'A')
  // Two earlier sends the user approved by hand (past warm-up), long ago and with no thread to read.
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('w1','A','x1','o1@z.example','s','bodybodybodybodybodybody','sent',?,?),('w2','A','x2','o2@z.example','s','bodybodybodybodybodybody','sent',?,?)").run(NOW - 200 * DAY, NOW - 200 * DAY, NOW - 200 * DAY, NOW - 200 * DAY)
  if (policy) setAutoSequence(db, 'A', true, AUTO_SEQUENCE_VERSION, NOW - 60)
  return db
}
function lead(db: Database.Database, contact: string) {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const id = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score, human_confirmed_at, human_confirmed_from) VALUES (?, ?, 'Northside Roofing', ?, 'Hiring roofers', 'https://n.example/jobs', 'Northside is hiring roofers', 90, 80, ?, 'test_review')").run(id, job, contact, NOW)
  return id
}
// Stub Gmail: every send is recorded and lands in thread-1; the thread holds whatever `inbox` says at read time.
function gmail(inbox: { msgs: unknown[] } = { msgs: [] }) {
  const sent: string[] = []
  const fetchImpl = (async (u: unknown) => {
    const url = String(u)
    if (url.includes('oauth2') || url.includes('token')) return json({ access_token: 'at' })
    if (url.includes('/threads/')) return json({ messages: inbox.msgs })
    return json({}, 404)
  }) as unknown as typeof fetch
  const sendFn = (async (_t: string, raw: string) => { sent.push(Buffer.from(raw, 'base64url').toString('utf8')); return { id: `gm${sent.length}`, threadId: 'thread-1' } }) as never
  const d = (now: number): Deps & { flags: Record<string, string> } => ({ flags: FLAGS, env: genv, master, now, baseUrl: 'https://app.test', fetchImpl, sendFn })
  return { sent, d, inbox }
}
const seq = (db: Database.Database) => db.prepare('SELECT status, stop_reason FROM sequences').all() as { status: string; stop_reason: string | null }[]
const reply = (from: string, text: string, at: number) => ({ id: 'in-' + at, threadId: 'thread-1', internalDate: String(at * 1000), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }], body: { data: Buffer.from(text).toString('base64url') } } })

test('#414 first touch on day 0, then no-reply steps on day 3 and day 7, with no per-lead sequence creation or approval', async () => {
  const db = await setup(); const g = gmail(); lead(db, 'owner@northside.example')
  const r = await runAutopilot(db, 'A', 'Acme', g.d(NOW))
  assert.deepEqual([r.sent, r.enrolled, g.sent.length], [1, 1, 1], 'day 0: first touch sent and enrolled')
  assert.deepEqual(seq(db), [{ status: 'approved', stop_reason: null }])
  const steps = db.prepare('SELECT step, subject, status, approved_hash IS NOT NULL AS hashed FROM sequence_steps ORDER BY step').all()
  assert.deepEqual(steps.map(s => (s as { hashed: number }).hashed), [1, 1, 1], 'every step\'s exact words are hash-approved at enrollment')
  const sends: number[] = []
  for (const day of [1, 2, 3, 4, 6, 7, 8, 10]) { await runSequences(db, 'A', 'Acme', g.d(NOW + day * DAY)); sends.push(g.sent.length) }
  assert.deepEqual(sends, [1, 1, 2, 2, 2, 3, 3, 3], 'step 2 on day 3, step 3 on day 7, nothing else')
  assert.match(g.sent[1], /^Subject: Re: /m); assert.match(g.sent[1], /In-Reply-To: <dazl\./)
  assert.deepEqual(seq(db), [{ status: 'done', stop_reason: null }])
})

test('#414 a reply, an opt-out or a bounce before day 3 stops the sequence; nothing more is sent', async () => {
  for (const [from, text, status] of [
    ['owner@northside.example', 'Thanks, tell me more about pricing.', 'replied'],
    ['owner@northside.example', 'Please remove me from your list.', 'replied'], // any human reply ends it; the opt-out also suppresses the address
    ['mailer-daemon@googlemail.com', 'Delivery Status Notification (Failure). 550 5.1.1 user unknown: owner@northside.example', 'stopped'], // a hard bounce (5.x.x); a soft one keeps existing behaviour,
  ] as const) {
    const db = await setup(); const g = gmail(); lead(db, 'owner@northside.example')
    await runAutopilot(db, 'A', 'Acme', g.d(NOW))
    await runSequences(db, 'A', 'Acme', g.d(NOW + DAY))
    g.inbox.msgs = [reply(from, text, NOW + 2 * DAY)]
    for (const day of [3, 7]) await runSequences(db, 'A', 'Acme', g.d(NOW + day * DAY))
    assert.equal(g.sent.length, 1, `${text}: only the first touch went out`)
    assert.equal(seq(db)[0].status, status, text)
    if (/remove me/.test(text)) assert.equal(db.prepare("SELECT count(*) AS n FROM suppressions WHERE email = 'owner@northside.example'").pluck().get(), 1, 'the opt-out is suppressed for every future send')
  }
})

test('#414 no policy, an old policy version, or reply reading off: the first touch is not enrolled', async () => {
  const off = await setup(false); const g = gmail(); lead(off, 'a@one.example')
  assert.equal((await runAutopilot(off, 'A', 'Acme', g.d(NOW))).sent, 1)
  assert.deepEqual(seq(off), [], 'no policy: no sequence')
  // A stored acceptance of another version is not the current policy.
  const old = await setup(false); old.prepare("INSERT INTO autopilot_audit (id, tenant_id, action, detail, created_at) VALUES ('p', 'A', 'auto_sequence_on', '2026-01-01', ?)").run(NOW - 60)
  assert.equal(autoSequencePolicy(old, 'A').on, false)
  lead(old, 'b@two.example'); await runAutopilot(old, 'A', 'Acme', gmail().d(NOW)); assert.deepEqual(seq(old), [])
  assert.throws(() => setAutoSequence(old, 'A', true, '2026-01-01'), /policy_version/)
  // Turning it on needs reply reading, so follow-ups can stop on replies.
  const noRead = await setup(false); revokeReadConsent(noRead, 'A')
  assert.throws(() => setAutoSequence(noRead, 'A', true, AUTO_SEQUENCE_VERSION), /reading_not_enabled/)
})

test('#414 enrollment is atomic: a second enrollment of the same first touch, or of the same lead, never duplicates', async () => {
  const db = await setup(); const g = gmail(); lead(db, 'a@one.example')
  await runAutopilot(db, 'A', 'Acme', g.d(NOW))
  const mid = (db.prepare("SELECT id FROM outreach_messages WHERE to_email = 'a@one.example'").get() as { id: string }).id
  assert.equal(enrollAutoSequence(db, 'A', mid, 'me@acme.example', 'Acme', NOW), null)
  assert.equal(enrollAutoSequence(db, 'A', mid, 'me@acme.example', 'Acme', NOW), null)
  assert.equal((db.prepare('SELECT count(*) AS n FROM sequences').get() as { n: number }).n, 1)
  assert.equal((db.prepare('SELECT count(*) AS n FROM sequence_steps').get() as { n: number }).n, 3)
  for (const day of [3, 3, 7, 7]) await runSequences(db, 'A', 'Acme', g.d(NOW + day * DAY))
  assert.equal(g.sent.length, 3, 'each step once, however often the pass runs')
})

test('#414 new authority never inherits the old approval: policy off, a new policy version, or another Gmail address stop unsent steps', async () => {
  for (const change of ['off', 'new_version', 'other_gmail', 'same_gmail_reconnect'] as const) {
    const db = await setup(); const g = gmail(); lead(db, 'a@one.example')
    await runAutopilot(db, 'A', 'Acme', g.d(NOW))
    if (change === 'off') setAutoSequence(db, 'A', false, undefined, NOW + DAY)
    if (change === 'new_version') db.prepare("INSERT INTO autopilot_audit (id, tenant_id, action, detail, created_at) VALUES ('v2', 'A', 'auto_sequence_on', '2099-01-01', ?)").run(NOW + DAY)
    if (change === 'other_gmail') await connect(db, 'someone@other.example')
    if (change === 'same_gmail_reconnect') await connect(db, 'me@acme.example')
    for (const day of [3, 7]) await runSequences(db, 'A', 'Acme', g.d(NOW + day * DAY))
    if (change === 'same_gmail_reconnect') { assert.equal(g.sent.length, 3, 'the same address reconnected keeps its follow-ups'); continue }
    assert.equal(g.sent.length, 1, `${change}: no follow-up after the change`)
    assert.deepEqual(seq(db), [{ status: 'stopped', stop_reason: change === 'other_gmail' ? 'sender_changed' : 'policy_changed' }], change)
  }
})

test('#414 the policy or Gmail address changing during the token request (the send commitment) stops the step unsent', async () => {
  const db = await setup(); const g = gmail(); lead(db, 'a@one.example')
  await runAutopilot(db, 'A', 'Acme', g.d(NOW))
  await runSequences(db, 'A', 'Acme', g.d(NOW + DAY))
  let flips = 0
  const fetchImpl = (async (u: unknown) => {
    const url = String(u)
    if (url.includes('oauth2') || url.includes('token')) { if (++flips === 2) setAutoSequence(db, 'A', false, undefined, NOW + 3 * DAY); return json({ access_token: 'at' }) }
    if (url.includes('/threads/')) return json({ messages: [] })
    return json({}, 404)
  }) as unknown as typeof fetch
  await runSequences(db, 'A', 'Acme', { ...g.d(NOW + 3 * DAY), fetchImpl })
  assert.equal(g.sent.length, 1, 'turned off between the claim and the send: not sent')
  assert.deepEqual(seq(db), [{ status: 'stopped', stop_reason: 'policy_changed' }])
  assert.equal((db.prepare("SELECT count(*) AS n FROM sequence_steps WHERE status IN ('sending','uncertain')").get() as { n: number }).n, 0, 'the claim was released')
})

test('#414 sending stays gated: SEQUENCES_ENABLED off or autopilot paused sends no follow-up; a hand-approved sequence is not governed by the policy', async () => {
  const db = await setup(); const g = gmail(); lead(db, 'a@one.example')
  await runAutopilot(db, 'A', 'Acme', g.d(NOW))
  await runSequences(db, 'A', 'Acme', { ...g.d(NOW + 3 * DAY), flags: { ...FLAGS, SEQUENCES_ENABLED: '0' } })
  pause(db, 'A'); await runSequences(db, 'A', 'Acme', g.d(NOW + 3 * DAY))
  assert.equal(g.sent.length, 1)
  assert.deepEqual(seq(db), [{ status: 'approved', stop_reason: null }], 'not started, nothing sent')
  // A sequence with no automatic enrollment record (approved by hand) is outside this policy.
  setAutoSequence(db, 'A', false, undefined, NOW + 4 * DAY)
  assert.equal(autoSequenceStop(db, 'A', 'hand-approved-message', 'someone@else.example'), null)
})
