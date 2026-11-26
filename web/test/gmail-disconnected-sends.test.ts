// #1804: a revoked or expired Gmail must never make sends vanish or show as sent. When the token
// refresh answers invalid_grant, the account flips to needs_reconnect (the banner state every surface
// reads), approved drafts and due sequence steps stay queued exactly as they were, and after the user
// reconnects (and resumes, the product's own path) the queued work goes out. These tests drive the
// real send paths with a token endpoint that revokes, then heals.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateAutopilot, enable, getState, CONSENT_VERSION, ATTESTATIONS } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { migrateReplies, acceptReadConsent } from '../lib/outreach/replies.ts'
import { completeOAuth, startOAuth, gmailStatus, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { approve, saveSettings, sendMessage } from '../lib/outreach/service.ts'
import { migrateSequences, createSequence, approveSequence, runSequences } from '../lib/outreach/sequences.ts'
import { schedulerReadiness } from '../lib/outreach/scheduler-readiness.ts'
import { gmailReconnectNotice, sequenceGmailWaitLabel } from '../lib/gmail/notice.ts'

const NOW = 1_800_000_000, DAY = 86400
const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', PUBLIC_BASE_URL: 'https://app.test' }
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const oauthOk = (async () => json({ refresh_token: 'test-token', scope: `https://www.googleapis.com/auth/gmail.send ${GMAIL_READ_SCOPE}`, id_token: idToken('me@acme.example') })) as unknown as typeof fetch

async function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db)
  const state = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env, master, now: NOW, fetchImpl: oauthOk })
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

// revoked: Google's token endpoint refuses the refresh with invalid_grant (a revoked or expired grant).
function mock(revoked = false) {
  const calls: string[] = []
  const fetchImpl = (async (u: unknown) => {
    const url = String(u)
    if (url.includes('oauth2.googleapis.com/token')) return revoked ? json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400) : json({ access_token: 'access' })
    if (url.includes('/threads/')) return json({ messages: [] })
    if (url.includes('messages?q=')) return json({ messages: [] })
    return json({}, 404)
  }) as unknown as typeof fetch
  const sendFn = (async (_t: string, raw: string) => { calls.push(raw); return { id: `gm${calls.length}`, threadId: 'thread-1' } }) as never
  return { calls, fetchImpl, sendFn, env, master, now: NOW, baseUrl: 'https://app.test', flags: { SEQUENCES_ENABLED: '1', AUTOPILOT_AVAILABLE: '1', AUTOPILOT_ENABLED: '1' } }
}

const msgRow = (db: Database.Database, id: string) => db.prepare('SELECT status, error FROM outreach_messages WHERE id = ?').get(id) as { status: string; error: string | null }
const stepRow = (db: Database.Database, seq: string, step: number) => db.prepare('SELECT status FROM sequence_steps WHERE sequence_id = ? AND step = ?').get(seq, step) as { status: string }

test('invalid_grant on a manual send: the draft stays queued, nothing is marked sent, the banner state is on', async () => {
  const db = await setup()
  const { mid } = addDraft(db)
  approve(db, 'A', mid)
  const dead = mock(true)
  await assert.rejects(sendMessage(db, 'A', mid, dead), /gmail_reconnect_needed/, 'the send refuses with the reconnect code, not a silent failure')
  assert.deepEqual(msgRow(db, mid), { status: 'approved', error: 'gmail_reconnect_needed' }, 'the draft is back in the queue with its reason, not sent, not skipped, not lost')
  assert.equal(dead.calls.length, 0, 'nothing reached Gmail')
  assert.equal(gmailStatus(db, 'A')?.status, 'needs_reconnect', 'the account state the banner reads is on')
  assert.equal(schedulerReadiness(db, 'A').gates.find(g => g.id === 'gmail')?.ok, false, 'the gmail gate every surface reads agrees')
})

test('invalid_grant on a sequence tick: the due step stays queued and the sequence stays alive', async () => {
  const db = await setup()
  const ok = mock()
  const { mid } = addDraft(db)
  const seq = createSequence(db, 'A', mid)
  approveSequence(db, 'A', seq, (id) => approve(db, 'A', id, true), NOW)
  await sendMessage(db, 'A', mid, { ...ok, now: NOW })
  assert.equal((await runSequences(db, 'A', 'Acme', { ...ok, now: NOW })).started, 1)
  const dead = mock(true)
  const r = await runSequences(db, 'A', 'Acme', { ...dead, now: NOW + 3 * DAY })
  assert.equal(r.sent, 0, 'the due step does not send')
  assert.equal(stepRow(db, seq, 2).status, 'approved', 'the step is released back to queued, not failed and not sent')
  assert.equal((db.prepare('SELECT status FROM sequences WHERE id = ?').get(seq) as { status: string }).status, 'active', 'the sequence itself is not stopped or completed')
  assert.equal(gmailStatus(db, 'A')?.status, 'needs_reconnect')
})

test('after reconnect the queued draft and the queued step go out', async () => {
  const db = await setup()
  const ok = mock()
  const { mid } = addDraft(db)
  const seq = createSequence(db, 'A', mid)
  approveSequence(db, 'A', seq, (id) => approve(db, 'A', id, true), NOW)
  await sendMessage(db, 'A', mid, { ...ok, now: NOW })
  await runSequences(db, 'A', 'Acme', { ...ok, now: NOW })
  const dead = mock(true)
  await runSequences(db, 'A', 'Acme', { ...dead, now: NOW + 3 * DAY })
  assert.equal(stepRow(db, seq, 2).status, 'approved', 'still queued while Gmail is dead')
  // The user reconnects: a fresh OAuth grant replaces the dead one. This path never paused the
  // account (reply sync failed before any step was claimed), so no resume is needed either.
  const state = new URL(startOAuth(db, 'A', { env, now: NOW + 3 * DAY })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c2', state, { env, master, now: NOW + 3 * DAY, fetchImpl: oauthOk })
  assert.equal(gmailStatus(db, 'A')?.status, 'active', 'the banner state clears')
  const r = await runSequences(db, 'A', 'Acme', { ...ok, now: NOW + 3 * DAY })
  assert.equal(r.sent, 1, 'the queued step sends on the first pass after reconnect')
  assert.equal(stepRow(db, seq, 2).status, 'sent')
  // And a fresh manual send works again too.
  const second = addDraft(db, 'second@acme.example')
  approve(db, 'A', second.mid)
  assert.equal(await sendMessage(db, 'A', second.mid, { ...ok, now: NOW + 3 * DAY }), 'sent')
})

test('token failure AFTER the step is claimed: the step is released, the account pauses, and reconnect alone resumes it', async () => {
  const db = await setup()
  const ok = mock()
  const { mid } = addDraft(db)
  const seq = createSequence(db, 'A', mid)
  approveSequence(db, 'A', seq, (id) => approve(db, 'A', id, true), NOW)
  await sendMessage(db, 'A', mid, { ...ok, now: NOW })
  await runSequences(db, 'A', 'Acme', { ...ok, now: NOW })
  // Reply sync succeeds (its token call works); the grant dies before the claimed step's own token call.
  let tokenCalls = 0
  const flaky = { ...mock(), fetchImpl: (async (u: unknown) => {
    const url = String(u)
    if (url.includes('oauth2.googleapis.com/token')) { tokenCalls++; return tokenCalls === 1 ? json({ access_token: 'access' }) : json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400) }
    if (url.includes('/threads/')) return json({ messages: [] })
    if (url.includes('messages?q=')) return json({ messages: [] })
    return json({}, 404)
  }) as unknown as typeof fetch }
  const r = await runSequences(db, 'A', 'Acme', { ...flaky, now: NOW + 3 * DAY })
  assert.equal(r.sent, 0, 'the claimed step does not send')
  assert.equal(r.stopped, 'gmail_unavailable')
  assert.equal(stepRow(db, seq, 2).status, 'approved', 'the claimed step is released back to queued, not sent, not failed')
  const st = getState(db, 'A')
  assert.equal(st.paused, true, 'the account pauses on the dead grant')
  assert.equal(st.pause_reason, 'gmail_reconnect_needed')
  assert.equal(gmailStatus(db, 'A')?.status, 'needs_reconnect')
  // The user reconnects - and does nothing else. No resume() call: reconnecting is the resume for this pause.
  const state = new URL(startOAuth(db, 'A', { env, now: NOW + 3 * DAY })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c3', state, { env, master, now: NOW + 3 * DAY, fetchImpl: oauthOk })
  assert.equal(gmailStatus(db, 'A')?.status, 'active')
  const r2 = await runSequences(db, 'A', 'Acme', { ...ok, now: NOW + 3 * DAY })
  assert.equal(r2.sent, 1, 'the queued step sends on the first pass after reconnect, with no resume click')
  assert.equal(stepRow(db, seq, 2).status, 'sent')
  assert.equal(getState(db, 'A').paused, false, 'the reconnect pause cleared itself')
})

test('the manual draft that failed while Gmail was down is the one that sends after reconnect, exactly once', async () => {
  const db = await setup()
  const { mid } = addDraft(db)
  approve(db, 'A', mid)
  const dead = mock(true)
  await assert.rejects(sendMessage(db, 'A', mid, dead), /gmail_reconnect_needed/)
  assert.equal(msgRow(db, mid).status, 'approved', 'the failed draft is the queued one')
  const state = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c4', state, { env, master, now: NOW, fetchImpl: oauthOk })
  const ok = mock()
  assert.equal(await sendMessage(db, 'A', mid, { ...ok, now: NOW }), 'sent', 'pressing Send again on that same draft sends it')
  assert.equal(ok.calls.length, 1)
  assert.equal(await sendMessage(db, 'A', mid, { ...ok, now: NOW }), 'sent', 'a second press is an idempotent no-op (service.ts: already sent)')
  assert.equal(ok.calls.length, 1, 'no duplicate copy went out')
})

// #1804 review: ONE Reconnect banner on /app/outreach. OutreachClient renders SequencesClient inside the same
// page, and both used to render a gmail-reconnect-banner, so the page showed two. The banner lives in
// OutreachClient only; the sequences panel keeps the 'Waiting: reconnect Gmail' step label and the
// prerequisites list. The banner and the Home journey notice key on status 'needs_reconnect' exactly: any
// other state (none, pending) must not claim Gmail is disconnected.
const srcOf = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

test('#1804: one gmail-reconnect-banner on the Outreach page, in OutreachClient only', () => {
  const outreach = srcOf('../app/app/outreach/outreach-client.tsx')
  const sequences = srcOf('../app/app/outreach/sequences-client.tsx')
  assert.ok(outreach.includes('<SequencesClient'), 'the sequences panel renders inside the Outreach page')
  assert.equal((outreach.match(/gmail-reconnect-banner/g) ?? []).length, 1, 'OutreachClient renders the one banner')
  assert.ok(!sequences.includes('gmail-reconnect-banner'), 'SequencesClient renders no second banner')
  assert.ok(sequences.includes('sequenceGmailWaitLabel('), 'the sequences panel takes its Waiting label from the shared decision')
  assert.ok(sequences.includes('Sending prerequisites not met'), 'the sequences panel keeps the prerequisites list')
  assert.ok(sequences.includes('Follow-ups send on their own once Gmail is reconnected'), 'the panel says plainly that follow-ups need no Send press')
})

// Behaviour, not source shape: the notice and label decisions themselves, over every account state.
test('#1804: the reconnect notice shows only for a connection that exists and died', () => {
  assert.equal(gmailReconnectNotice('needs_reconnect'), true)
  for (const st of ['active', 'pending', 'revoked', null, undefined, '']) assert.equal(gmailReconnectNotice(st), false, `status ${String(st)} shows no reconnect notice`)
})

test('#1804: the sequences wait label never says reconnect for a Gmail that was never connected', () => {
  assert.equal(sequenceGmailWaitLabel('needs_reconnect'), 'Waiting: reconnect Gmail')
  assert.equal(sequenceGmailWaitLabel(null), 'Waiting: connect Gmail', 'no account yet: connect, not reconnect')
  assert.equal(sequenceGmailWaitLabel(undefined), 'Waiting: connect Gmail')
  assert.equal(sequenceGmailWaitLabel('pending'), 'Waiting: connect Gmail')
  assert.equal(sequenceGmailWaitLabel('active'), null, 'an active Gmail is not a wait')
})

test('#1804: both surfaces take the notice from the shared decision', () => {
  for (const [name, src] of [['outreach-client', srcOf('../app/app/outreach/outreach-client.tsx')], ['journey', srcOf('../app/app/journey.tsx')]] as const) {
    assert.ok(src.includes('gmailReconnectNotice('), `${name} calls the shared decision`)
    assert.ok(!src.includes("'needs_reconnect'"), `${name} carries no inline status comparison of its own`)
  }
})
