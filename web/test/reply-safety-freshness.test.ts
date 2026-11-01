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
