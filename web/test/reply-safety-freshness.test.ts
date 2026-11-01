// #413: sends must not rely on stale safety state. reply_sync is the only way opt-outs/replies arrive; when it has
// not succeeded recently, every send boundary (first-touch pre-check, post-token-await recheck, sequence claim and
// post-await recheck) must hold instead of sending.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach, replySafetyStale, REPLY_SAFETY_STALE_S } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { migrateReplies, acceptReadConsent } from '../lib/outreach/replies.ts'
import { migrateSequences, enrollColdSequence, runSequences, acceptAutoSequencePolicy, AUTO_SEQUENCE_POLICY } from '../lib/outreach/sequences.ts'
import { migrateSchedulerRuns } from '../lib/ops/scheduler-runs.ts'
import { saveSettings, sendMessage, sendBlockReason, OutreachError, type Deps } from '../lib/outreach/service.ts'
import { drainFirstTouch, runAutopilot, enable, ATTESTATIONS, CONSENT_VERSION } from '../lib/outreach/autopilot.ts'
import { runFollowups } from '../lib/outreach/followups.ts'
import { createReopenDraft, migrateReopen, sendReopen } from '../lib/outreach/reopen.ts'
import { seedOffers } from './helpers/seed-offer.ts'
import { startOAuth, completeOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'

const NOW = 1_800_000_000
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const hash = (to: string, subject: string, body: string) => createHash('sha256').update(JSON.stringify([to, subject, body])).digest('hex')
const idToken = (email: string) => ['', Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url'), ''].join('.')

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db); migrateSchedulerRuns(db)
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('L1', job, 'Acme', 'prospect@corp.example', 'Hiring roofers', 'https://acme.example/jobs', 'Hiring roofers', 90, 80)
  db.prepare("UPDATE leads SET human_confirmed_at = 1800000000, human_confirmed_from = 'test_review' WHERE id = 'L1'").run()
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  db.prepare("INSERT INTO gmail_accounts (tenant_id, email, refresh_ct, read_granted, status) VALUES ('A', 'me@acme.example', 'x', 1, 'active')").run()
  acceptReadConsent(db, 'A')
  return db
}
const approvedMsg = (db: Database.Database, id: string, status = 'approved', lead = 'L1') => {
  if (lead === 'L2') db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('L2', (db.prepare("SELECT scan_job_id FROM leads WHERE id = 'L1'").get() as { scan_job_id: string }).scan_job_id, 'Beta', 'other@corp.example', 'Hiring', 'https://beta.example', 'Hiring', 90, 80)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, approved_hash) VALUES (?, 'A', ?, 'prospect@corp.example', 'Hello', 'Body text for the first touch message.', ?, ?)")
    .run(id, lead, status, status === 'approved' ? hash('prospect@corp.example', 'Hello', 'Body text for the first touch message.') : null)
}
const syncRow = (db: Database.Database, lastSuccess: number | null, lastAttempt?: number) => {
  db.prepare("INSERT INTO scheduler_progress (tenant_id, kind, last_attempt_at, last_success_at, last_outcome, consecutive_failures) VALUES ('A', 'reply_sync', ?, ?, ?, 0) ON CONFLICT(tenant_id, kind) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at")
    .run(lastAttempt ?? lastSuccess ?? 0, lastSuccess, lastSuccess === null ? 'failure' : 'success')
}

test('gate is per-recipient: inert for fresh first contacts, blocking for contacted recipients, recovering on fresh sync', () => {
  const db = setup()
  const wall = Math.floor(Date.now() / 1000)
  approvedMsg(db, 'M1')
  // Nothing sent to this recipient yet: there is no reply to miss - a fresh first contact may go even with no sync history.
  assert.equal(replySafetyStale(db, 'A', 'prospect@corp.example'), false)
  assert.equal(sendBlockReason(db, 'A', 'M1'), null)
  // This recipient was contacted before and reply_sync has never succeeded: their opt-out could be unseen - hold.
  approvedMsg(db, 'M0', 'sent', 'L2')
  assert.equal(replySafetyStale(db, 'A', 'prospect@corp.example'), true)
  assert.equal(sendBlockReason(db, 'A', 'M1'), 'reply_sync_stale')
  // A fresh first contact to a DIFFERENT recipient is exempt from reply freshness (suppression still applies at send).
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('L3', (db.prepare("SELECT scan_job_id FROM leads WHERE id = 'L1'").get() as { scan_job_id: string }).scan_job_id, 'Gamma', 'newperson@other.example', 'Hiring', 'https://gamma.example', 'Hiring', 90, 80)
  db.prepare("UPDATE leads SET human_confirmed_at = 1800000000, human_confirmed_from = 'test_review' WHERE id = 'L3'").run()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, approved_hash) VALUES ('M2', 'A', 'L3', 'newperson@other.example', 'Hello', 'Body text for the first touch message.', 'approved', ?)")
    .run(hash('newperson@other.example', 'Hello', 'Body text for the first touch message.'))
  assert.equal(replySafetyStale(db, 'A', 'newperson@other.example'), false)
  assert.equal(sendBlockReason(db, 'A', 'M2'), null)
  // A success inside the window unblocks the contacted recipient.
  syncRow(db, wall - 60)
  assert.equal(replySafetyStale(db, 'A', 'prospect@corp.example'), false)
  assert.equal(sendBlockReason(db, 'A', 'M1'), null)
  // A success older than the window is stale again.
  syncRow(db, wall - REPLY_SAFETY_STALE_S - 10)
  assert.equal(replySafetyStale(db, 'A', 'prospect@corp.example'), true)
  assert.equal(sendBlockReason(db, 'A', 'M1'), 'reply_sync_stale')
  // Failing sync (attempt after the last success) with an old success: still stale.
  syncRow(db, wall - REPLY_SAFETY_STALE_S - 10, wall - 5)
  assert.equal(replySafetyStale(db, 'A', 'prospect@corp.example'), true)
  // Read authority revoked: freshness can never recover for a contacted recipient - their sends hold...
  db.prepare("DELETE FROM mail_read_consent WHERE tenant_id = 'A'").run()
  assert.equal(replySafetyStale(db, 'A', 'prospect@corp.example'), true)
  assert.equal(sendBlockReason(db, 'A', 'M1'), 'reply_sync_stale')
  // ...while a fresh first contact to someone never emailed still goes (their suppression was checked at send time).
  assert.equal(replySafetyStale(db, 'A', 'newperson@other.example'), false)
  assert.equal(sendBlockReason(db, 'A', 'M2'), null)
})

test('a first contact is not refused by its own claim: the post-claim recheck excludes the in-flight message', () => {
  const db = setup()
  approvedMsg(db, 'M1') // approved, never sent: no history with this recipient
  db.prepare("UPDATE outreach_messages SET status = 'sending', claimed_at = ? WHERE id = 'M1'").run(NOW) // its own claim
  db.prepare('DELETE FROM mail_read_consent').run(); db.prepare('UPDATE gmail_accounts SET read_granted = 0').run()
  assert.equal(replySafetyStale(db, 'A', 'prospect@corp.example', NOW, 'M1'), false, 'the in-flight send itself is not prior contact')
  assert.equal(replySafetyStale(db, 'A', 'prospect@corp.example', NOW), true, 'but once in flight it IS history for the next send to them')
})

test('sendMessage refuses at the pre-check when safety state is stale: no claim, no send, row stays approved', async () => {
  const db = setup()
  approvedMsg(db, 'M0', 'sent', 'L2')
  approvedMsg(db, 'M1')
  const err = await sendMessage(db, 'A', 'M1').then(() => null, (e: unknown) => e)
  assert.ok(err instanceof OutreachError)
  assert.equal((err as OutreachError).code, 'reply_sync_stale')
  assert.deepEqual(db.prepare("SELECT status, claimed_at FROM outreach_messages WHERE id = 'M1'").get(), { status: 'approved', claimed_at: null }, 'never claimed')
})

async function seedSequenceTenant() {
  const db = setup()
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, email_verified_at INTEGER)')
  const master = randomBytes(32)
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW, withRead: true })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: `https://www.googleapis.com/auth/gmail.send ${GMAIL_READ_SCOPE}`, id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  acceptAutoSequencePolicy(db, 'A', AUTO_SEQUENCE_POLICY)
  approvedMsg(db, 'M0', 'sent')
  db.prepare("UPDATE outreach_messages SET sent_at = ?, gmail_id = 'g1', thread_id = 'thread-1' WHERE id = 'M0'").run(NOW)
  const seqId = enrollColdSequence(db, 'A', 'M0', { businessName: 'Acme' })!
  assert.ok(seqId)
  return { db, master, seqId }
}
const seqDeps = (master: Buffer, onToken?: () => void) => {
  const sent: string[] = []
  const d: Deps & { flags: Record<string, string> } = { flags: { AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '0', SEQUENCES_ENABLED: '1' }, env: genv, master, now: NOW + 3 * 86400 + 1, baseUrl: 'https://app.test', fetchImpl: (async (u: unknown) => {
    const url = String(u)
    if (url.includes('token')) { onToken?.(); return json({ access_token: 'at' }) }
    if (url.includes('/threads/')) return json({ messages: [] })
    return json({}, 404)
  }) as unknown as typeof fetch, sendFn: (async (_t: string, raw: string) => { sent.push(raw); return { id: 'g' } }) as never }
  return { d, sent }
}

test('sequence step: stale safety ingest holds the step approved - nothing sends, sequence is not stopped', async () => {
  const { db, master, seqId } = await seedSequenceTenant()
  const seqNow = NOW + 3 * 86400 + 1
  syncRow(db, seqNow - REPLY_SAFETY_STALE_S - 10) // stale at claim time
  const { d, sent } = seqDeps(master)
  await runSequences(db, 'A', 'Acme', d)
  assert.equal(sent.length, 0, 'no bytes went to Gmail')
  assert.deepEqual(db.prepare('SELECT status, claimed_at FROM sequence_steps WHERE sequence_id = ? AND step = 2').get(seqId), { status: 'approved', claimed_at: null }, 'step waits for fresh ingest')
  assert.notEqual((db.prepare('SELECT status FROM sequences WHERE id = ?').get(seqId) as { status: string }).status, 'stopped', 'a transient hold never terminates the sequence')
  assert.equal((db.prepare("SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = 'A' AND action = 'sequence_skipped' AND detail = 'reply_sync_stale'").get() as { n: number }).n, 1, 'audited')
})

test('sequence step: fresh ingest lets the approved step send (gate does not break normal sends)', async () => {
  const { db, master, seqId } = await seedSequenceTenant()
  const seqNow = NOW + 3 * 86400 + 1
  syncRow(db, seqNow - 60)
  const { d, sent } = seqDeps(master)
  await runSequences(db, 'A', 'Acme', d)
  assert.equal(sent.length, 1, 'the approved follow-up went out')
  assert.equal((db.prepare('SELECT status FROM sequence_steps WHERE sequence_id = ? AND step = 2').get(seqId) as { status: string }).status, 'sent')
})

test('sequence step: ingest going stale DURING the token await releases the claim inert - nothing sends', async () => {
  const { db, master, seqId } = await seedSequenceTenant()
  const seqNow = NOW + 3 * 86400 + 1
  syncRow(db, seqNow - 60)
  const { d, sent } = seqDeps(master, () => syncRow(db, seqNow - REPLY_SAFETY_STALE_S - 10)) // freshness rots inside the token await
  await runSequences(db, 'A', 'Acme', d)
  assert.equal(sent.length, 0, 'no bytes went to Gmail')
  assert.deepEqual(db.prepare('SELECT status, claimed_at FROM sequence_steps WHERE sequence_id = ? AND step = 2').get(seqId), { status: 'approved', claimed_at: null }, 'claim released inert')
})

// ---------- whole-class coverage: drain recovery, warm follow-up, re-open (builder, refs #413) ----------

const tokenFetch = (onToken?: () => void) => (async (u: unknown) => {
  if (String(u).includes('token')) { onToken?.(); return json({ access_token: 'at' }) }
  return json({}, 404)
}) as unknown as typeof fetch

test('reply_sync_stale hold: drain avoids the send while stale, then selects the hold and sends exactly once after a full fresh sync', async () => {
  const { db, master: mstr } = await seedSequenceTenant()
  seedOffers(db)
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 5 })
  const wall = Math.floor(Date.now() / 1000)
  // A second lead at the SAME recipient: the sent M0 is now history, so freshness governs this recipient.
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('L9', (db.prepare("SELECT scan_job_id FROM leads WHERE id = 'L1'").get() as { scan_job_id: string }).scan_job_id, 'Delta', 'prospect@corp.example', 'Hiring', 'https://delta.example', 'Hiring', 90, 80)
  db.prepare("UPDATE leads SET human_confirmed_at = 1800000000, human_confirmed_from = 'test_review' WHERE id = 'L9'").run()
  // The drain's candidate query only reads DONE scans: a running scan's leads are not final yet (same trigger-legal
  // lifecycle as the real runner: pending -> running -> leads -> done).
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = (SELECT scan_job_id FROM leads WHERE id = 'L9')").run()
  const sent: string[] = []
  const d = (now: number, onToken?: () => void): Deps & { flags: Record<string, string> } => ({ flags: { AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '1' }, env: genv, master: mstr, now, baseUrl: 'https://app.test', fetchImpl: tokenFetch(onToken), sendFn: (async (_t: string, raw: string) => { sent.push(raw); return { id: 'g' } }) as never })
  syncRow(db, wall - REPLY_SAFETY_STALE_S - 10) // stale: the actual hold path
  const r1 = await runAutopilot(db, 'A', 'Acme', d(wall))
  assert.equal(r1.sent, 0)
  assert.equal(sent.length, 0, 'no bytes went to Gmail')
  const held = db.prepare("SELECT status, hold_reason FROM outreach_messages WHERE lead_id = 'L9'").get() as { status: string; hold_reason: string | null }
  // Merged representation (#448 drain x #413 hold): autopilot's approval comes off a draft that is not going (the
  // drain owns the retry and re-approves at its own commitment), and the transient hold lives on the message row.
  assert.deepEqual(held, { status: 'draft', hold_reason: 'reply_sync_stale' }, 'held transient, never skipped, no retries consumed')
  // Still stale at the drain: the hold is selected but sendMessage's own pre-check re-refuses - no send, hold kept.
  const r2 = await drainFirstTouch(db, 'A', d(wall + 901))
  assert.equal(r2.sent, 0)
  assert.equal(sent.length, 0)
  assert.equal((db.prepare("SELECT hold_reason FROM outreach_messages WHERE lead_id = 'L9'").get() as { hold_reason: string }).hold_reason, 'reply_sync_stale')
  assert.equal((db.prepare("SELECT attempts FROM outreach_messages WHERE lead_id = 'L9'").get() as { attempts: number }).attempts, 0, 'a safety hold consumes no retry budget')
  // A full fresh sync: the drain selects the hold and the send goes through exactly once.
  // (The stale drain re-held at wall+901 with a fresh 15-minute retry window, so the hold is due at wall+1801.)
  syncRow(db, wall + 1802)
  const r3 = await drainFirstTouch(db, 'A', d(wall + 1802))
  assert.equal(r3.sent, 1)
  assert.equal(sent.length, 1, 'exactly one send across hold, stale drain and fresh drain')
  // A sent row keeps its (now inert) hold record: every selection filters on status, so it can never be re-sent.
  assert.equal((db.prepare("SELECT status FROM outreach_messages WHERE lead_id = 'L9'").get() as { status: string }).status, 'sent')
  const r4 = await drainFirstTouch(db, 'A', d(wall + 1802))
  assert.equal(r4.sent, 0)
  assert.equal(sent.length, 1, 'no double send')
  assert.equal((db.prepare("SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = 'A' AND detail = 'retry_exhausted'").get() as { n: number }).n, 0, 'a stale-ingest hold never counts toward retry exhaustion')
})

async function seedFollowupTenant() {
  const db = setup()
  const master2 = randomBytes(32)
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW, withRead: true })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env: genv, master: master2, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: `https://www.googleapis.com/auth/gmail.send ${GMAIL_READ_SCOPE}`, id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  db.prepare("INSERT INTO autopilot_settings (tenant_id, enabled, paused, consent_version, followups_enabled, daily_cap) VALUES ('A', 1, 0, ?, 1, 20)").run(CONSENT_VERSION)
  approvedMsg(db, 'M1', 'sent') // the sent first touch: history for this recipient, and the thread's original
  const wall0 = Math.floor(Date.now() / 1000)
  db.prepare("UPDATE outreach_messages SET sent_at = ?, gmail_id = 'g1', thread_id = 'thread-1' WHERE id = 'M1'").run(wall0 - 4 * 86400)
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent) VALUES ('A', 'th1', 'L1', 'prospect@corp.example', 'root', ?, ?, 0)").run(wall0 - 4 * 86400, wall0 - 4 * 86400)
  db.prepare("INSERT INTO consent_ledger (id, tenant_id, contact, channel, scope, basis, evidence_ref, granted_at, expires_at) VALUES ('c1', 'A', 'prospect@corp.example', 'email', 'followup', 'reply_interest', 'gmail:x', ?, ?)").run(wall0 - 4 * 86400, wall0 + 90 * 86400)
  return { db, master: master2 }
}

test('warm follow-up: stale ingest at claim holds; staleness DURING the token await removes the claim, sends nothing, stops nothing', async () => {
  const { db, master: mstr } = await seedFollowupTenant()
  const wall = Math.floor(Date.now() / 1000)
  const sent: string[] = []
  const d = (onToken?: () => void): Deps & { flags: Record<string, string> } => ({ flags: { AUTOPILOT_ENABLED: '1' }, env: genv, master: mstr, now: wall, baseUrl: 'https://app.test', fetchImpl: tokenFetch(onToken), sendFn: (async (_t: string, raw: string) => { sent.push(raw); return { id: 'g' } }) as never })
  syncRow(db, wall - REPLY_SAFETY_STALE_S - 10) // stale at claim time
  await runFollowups(db, 'A', 'Acme', d())
  assert.equal(sent.length, 0)
  assert.equal((db.prepare("SELECT count(*) AS n FROM followup_messages WHERE tenant_id = 'A'").get() as { n: number }).n, 0, 'no claim row left behind')
  assert.equal((db.prepare('SELECT stopped FROM followup_threads WHERE thread_id = ?').get('th1') as { stopped: string | null }).stopped, null, 'a transient hold never stops the thread')
  assert.equal((db.prepare('SELECT followups_sent FROM followup_threads WHERE thread_id = ?').get('th1') as { followups_sent: number }).followups_sent, 0, 'a held follow-up never counts as sent')
  // Fresh at claim, rotting inside the token await: same inert outcome.
  syncRow(db, wall)
  await runFollowups(db, 'A', 'Acme', d(() => syncRow(db, wall - REPLY_SAFETY_STALE_S - 10)))
  assert.equal(sent.length, 0, 'no bytes went to Gmail')
  assert.equal((db.prepare("SELECT count(*) AS n FROM followup_messages WHERE tenant_id = 'A'").get() as { n: number }).n, 0)
  assert.equal((db.prepare("SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = 'A' AND action = 'followup_skipped' AND detail = 'reply_sync_stale'").get() as { n: number }).n, 2, 'both holds audited')
  // Fresh again: the follow-up sends.
  syncRow(db, wall)
  await runFollowups(db, 'A', 'Acme', d())
  assert.equal(sent.length, 1)
})

async function seedReopenTenant(withConsent: boolean) {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateReopen(db); migrateSchedulerRuns(db)
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  const master3 = randomBytes(32)
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW, withRead: true })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env: genv, master: master3, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: `https://www.googleapis.com/auth/gmail.send ${GMAIL_READ_SCOPE}`, id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  if (withConsent) acceptReadConsent(db, 'A')
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('L1', job, 'Acme', 'prospect@corp.example', 'Hiring roofers', 'https://acme.example/jobs', 'Hiring roofers', 90, 80)
  db.prepare("UPDATE leads SET human_confirmed_at = 1800000000, human_confirmed_from = 'test_review' WHERE id = 'L1'").run()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES ('M1', 'A', 'L1', 'prospect@corp.example', 'Hello', 'Body text for the first touch message.', 'sent', ?)").run(NOW - 50 * 86400)
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent) VALUES ('A', 't1', 'L1', 'prospect@corp.example', 'r@x', ?, ?, 2)").run(NOW - 45 * 86400, NOW - 45 * 86400)
  db.prepare("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES ('g', 'A', 't1', 'L1', 'prospect@corp.example', 'sounds interesting', 'positive', ?)").run(NOW - 45 * 86400)
  createReopenDraft(db, 'A', 't1', 'Acme')
  return { db, master: master3 }
}

test('re-open: revoked or never-granted read authority holds a thread-bound re-open; restored consent with a fresh sync sends it', async () => {
  const wall = Math.floor(Date.now() / 1000)
  const attempt = async (db: Database.Database, mstr: Buffer, onToken?: () => void) => {
    let sends = 0, err = ''
    try { await sendReopen(db, 'A', 't1', { env: genv, now: wall, master: mstr, sendFn: (async () => { sends++; return { id: 'g' } }) as never, fetchImpl: tokenFetch(onToken) }) } catch (e) { err = e instanceof OutreachError ? e.code : String(e) }
    return { sends, err }
  }
  const rev = await seedReopenTenant(false) // never granted (same gate as revoked: no current read authority)
  const r1 = await attempt(rev.db, rev.master)
  assert.deepEqual(r1, { sends: 0, err: 'reply_sync_stale' })
  assert.equal((rev.db.prepare("SELECT status FROM reopen_messages WHERE thread_id = 't1'").get() as { status: string }).status, 'draft', 'nothing claimed: the draft waits')
  // Read authority present and fresh at the pre-check, rotting DURING the token await: the post-await
  // re-check (reopen.ts) throws before the claim - nothing sends, the draft stays recoverable.
  const mid = await seedReopenTenant(true)
  syncRow(mid.db, wall)
  const r2 = await attempt(mid.db, mid.master, () => syncRow(mid.db, wall - REPLY_SAFETY_STALE_S - 10))
  assert.deepEqual(r2, { sends: 0, err: 'reply_sync_stale' })
  assert.equal((mid.db.prepare("SELECT status FROM reopen_messages WHERE thread_id = 't1'").get() as { status: string }).status, 'draft', 'mid-await hold leaves the draft untouched')
  syncRow(mid.db, wall)
  const r2b = await attempt(mid.db, mid.master)
  assert.deepEqual(r2b, { sends: 1, err: '' }, 'the same draft sends once the ingest is fresh again')
  const okT = await seedReopenTenant(true)
  syncRow(okT.db, wall)
  const r3 = await attempt(okT.db, okT.master)
  assert.deepEqual(r3, { sends: 1, err: '' }, 'restored read authority + fresh ingest lets the user-approved re-open send')
})
