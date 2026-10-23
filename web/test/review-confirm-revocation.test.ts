import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateAutopilot, enable, ATTESTATIONS, CONSENT_VERSION } from '../lib/outreach/autopilot.ts'
import { migrateLedger, grantConsent } from '../lib/outreach/ledger.ts'
import { migrateReplies, acceptReadConsent } from '../lib/outreach/replies.ts'
import { runFollowups, setFollowups } from '../lib/outreach/followups.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings, approve, sendMessage, createDraft } from '../lib/outreach/service.ts'
import { migrateSequences, createSequence, approveSequence, runSequences } from '../lib/outreach/sequences.ts'
import { confirmLeadReview, unconfirmLeadReview } from '../lib/scan/review-confirm.ts'

// Revocation safety: withdrawing a human confirmation must block approval and sending of
// every dependent unsent draft and sequence step, at approval time AND at execution time,
// unless the lead is independently eligible again (re-confirmed or machine-verified).
// The exact-word approval hash does not preserve revoked evidence eligibility. Machine
// verification paths, suppression, and already-sent mail are untouched.

const NOW = 1800000000, DAY = 86400
const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', PUBLIC_BASE_URL: 'https://app.test' }
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })

async function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db)
  const state = new URL(startOAuth(db, 'A', { env, now: NOW, withRead: true })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'test-token', scope: `https://www.googleapis.com/auth/gmail.send ${GMAIL_READ_SCOPE}`, id_token: 'x.' + Buffer.from(JSON.stringify({ email: 'me@acme.example', email_verified: true })).toString('base64url') + '.y' })) as typeof fetch })
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  acceptReadConsent(db, 'A')
  return db
}

function addReviewLead(db: Database.Database, email = 'lead@acme.example') {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'roofing', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, review_reason, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    lead, job, 'Acme Roofing', email, 'Acme Roofing is hiring five roofers', 'https://news.example/a',
    'Acme Roofing is hiring five roofers', null, 'quote_unconfirmed', 70)
  return { lead, job }
}

function mock() {
  const calls: string[] = []
  const fetchImpl = (async (u: unknown) => {
    const url = String(u)
    if (url.includes('oauth2')) return json({ access_token: 'at' })
    if (url.includes('/threads/')) return json({ messages: [] })
    return json({}, 404)
  }) as typeof fetch
  const sendFn = (async (_t: string, raw: string) => { calls.push(Buffer.from(raw, 'base64url').toString('utf8')); return { id: `gm${calls.length}`, threadId: 'thread-1' } })
  return { calls, fetchImpl, sendFn, env, master, now: NOW, flags: { SEQUENCES_ENABLED: '1' } }
}

test('withdraw blocks approval of a dependent unsent draft', async () => {
  const db = await setup()
  const { lead } = addReviewLead(db)
  assert.equal(confirmLeadReview(db, 'A', lead), true)
  const draftId = createDraft(db, 'A', lead, 'Acme')
  assert.equal(unconfirmLeadReview(db, 'A', lead), true)
  assert.throws(() => approve(db, 'A', draftId), /lead_evidence_withdrawn/)
  const m = db.prepare('SELECT status, approved_hash FROM outreach_messages WHERE id = ?').get(draftId) as { status: string; approved_hash: string | null }
  assert.equal(m.status, 'draft')
  assert.equal(m.approved_hash, null)
})

test('withdraw blocks sending of a draft approved before the withdrawal', async () => {
  const db = await setup()
  const { lead } = addReviewLead(db)
  confirmLeadReview(db, 'A', lead)
  const draftId = createDraft(db, 'A', lead, 'Acme')
  approve(db, 'A', draftId) // approved while the confirmation stood
  assert.equal(unconfirmLeadReview(db, 'A', lead), true)
  await assert.rejects(sendMessage(db, 'A', draftId, mock()), /lead_evidence_withdrawn/)
  const m = db.prepare('SELECT status, sent_at FROM outreach_messages WHERE id = ?').get(draftId) as { status: string; sent_at: number | null }
  assert.equal(m.sent_at, null) // nothing went out
})

test('re-confirming restores eligibility: the same draft approves and sends', async () => {
  const db = await setup()
  const { lead } = addReviewLead(db)
  confirmLeadReview(db, 'A', lead)
  const draftId = createDraft(db, 'A', lead, 'Acme')
  unconfirmLeadReview(db, 'A', lead)
  assert.throws(() => approve(db, 'A', draftId), /lead_evidence_withdrawn/)
  assert.equal(confirmLeadReview(db, 'A', lead), true) // explicit restore
  approve(db, 'A', draftId)
  const m = mock()
  assert.equal(await sendMessage(db, 'A', draftId, m), 'sent')
  assert.equal(m.calls.length, 1)
})

test('machine-verified leads are unaffected by the revocation gate', async () => {
  const db = await setup()
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence) VALUES (?,?,?,?,?,?,?,?)').run(lead, job, 'Acme', 'lead@acme.example', 'Hiring roofers', 'https://acme.example/jobs', 'Hiring roofers', 90)
  const draftId = createDraft(db, 'A', lead, 'Acme')
  approve(db, 'A', draftId) // no human confirmation involved at all
  assert.equal(await sendMessage(db, 'A', draftId, mock()), 'sent')
})

test('withdraw blocks sequence set approval', async () => {
  const db = await setup()
  const { lead } = addReviewLead(db)
  confirmLeadReview(db, 'A', lead)
  const draftId = createDraft(db, 'A', lead, 'Acme')
  const seq = createSequence(db, 'A', draftId)
  assert.equal(unconfirmLeadReview(db, 'A', lead), true)
  assert.throws(() => approveSequence(db, 'A', seq, id => approve(db, 'A', id, true), NOW), /lead_evidence_withdrawn/)
  assert.equal((db.prepare('SELECT status FROM sequences WHERE id = ?').get(seq) as { status: string }).status, 'draft')
})

test('withdraw stops an approved sequence at execution before any unsent step', async () => {
  const db = await setup()
  const { lead } = addReviewLead(db)
  confirmLeadReview(db, 'A', lead)
  const draftId = createDraft(db, 'A', lead, 'Acme')
  const seq = createSequence(db, 'A', draftId)
  const m = mock()
  approveSequence(db, 'A', seq, id => approve(db, 'A', id, true), NOW)
  assert.equal(await sendMessage(db, 'A', draftId, m), 'sent') // step 1 out while confirmed - never recalled
  assert.equal(unconfirmLeadReview(db, 'A', lead), true)
  const r = await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 3 * DAY })
  assert.equal(r.sent, 0)
  assert.equal(m.calls.length, 1) // step 2 never went out
  const s = db.prepare('SELECT status, stop_reason FROM sequences WHERE id = ?').get(seq) as { status: string; stop_reason: string | null }
  assert.equal(s.status, 'stopped')
  assert.equal(s.stop_reason, 'evidence_withdrawn')
})

test('withdraw stops an already-active sequence at its next due step', async () => {
  const db = await setup()
  const { lead } = addReviewLead(db)
  confirmLeadReview(db, 'A', lead)
  const draftId = createDraft(db, 'A', lead, 'Acme')
  const seq = createSequence(db, 'A', draftId)
  const m = mock()
  approveSequence(db, 'A', seq, id => approve(db, 'A', id, true), NOW)
  await sendMessage(db, 'A', draftId, m)
  await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 1 }) // activates: step 1 mirrored, still confirmed
  assert.equal((db.prepare('SELECT status FROM sequences WHERE id = ?').get(seq) as { status: string }).status, 'active')
  unconfirmLeadReview(db, 'A', lead)
  const r = await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 3 * DAY })
  assert.equal(r.sent, 0)
  assert.equal(m.calls.length, 1)
  assert.equal((db.prepare('SELECT stop_reason FROM sequences WHERE id = ?').get(seq) as { stop_reason: string | null }).stop_reason, 'evidence_withdrawn')
})

test('withdraw during a due sequence step token fetch: zero send, claim released, sequence stopped', async () => {
  const db = await setup()
  const { lead } = addReviewLead(db)
  confirmLeadReview(db, 'A', lead)
  const draftId = createDraft(db, 'A', lead, 'Acme')
  const seq = createSequence(db, 'A', draftId)
  const m = mock()
  approveSequence(db, 'A', seq, id => approve(db, 'A', id, true), NOW)
  assert.equal(await sendMessage(db, 'A', draftId, m), 'sent') // step 1 out while confirmed - never recalled
  await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 1 }) // activates while still confirmed
  assert.equal((db.prepare('SELECT status FROM sequences WHERE id = ?').get(seq) as { status: string }).status, 'active')
  // Withdrawal lands DURING the access-token await, after the loop-top and claim checks passed.
  const withdrawFetch = (async (u: unknown) => {
    const url = String(u)
    if (url.includes('oauth2')) { unconfirmLeadReview(db, 'A', lead); return json({ access_token: 'at' }) }
    if (url.includes('/threads/')) return json({ messages: [] })
    return json({}, 404)
  }) as typeof fetch
  const r = await runSequences(db, 'A', 'Acme', { ...m, fetchImpl: withdrawFetch, now: NOW + 3 * DAY })
  assert.equal(r.sent, 0)
  assert.equal(m.calls.length, 1) // step 2 never went out
  const s = db.prepare('SELECT status, stop_reason FROM sequences WHERE id = ?').get(seq) as { status: string; stop_reason: string | null }
  assert.equal(s.status, 'stopped')
  assert.equal(s.stop_reason, 'evidence_withdrawn')
  const step2 = db.prepare("SELECT status, claimed_at FROM sequence_steps WHERE tenant_id = 'A' AND sequence_id = ? AND step = 2").get(seq) as { status: string; claimed_at: number | null }
  assert.equal(step2.status, 'approved') // claim released, not stuck in sending
  assert.equal(step2.claimed_at, null)
})

async function setupFollowups() {
  const db = await setup()
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 5 })
  setFollowups(db, 'A', true)
  return db
}

function interestedReviewThread(db: Database.Database, email = 'lead@acme.example') {
  const { lead } = addReviewLead(db, email)
  confirmLeadReview(db, 'A', lead)
  const mid = randomBytes(12).toString('hex'), thread = 't-' + mid
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, gmail_id, thread_id) VALUES (?, 'A', ?, ?, 'Quick question', 'bodybodybodybodybodybody', 'sent', ?, ?, ?, ?)").run(mid, lead, email, NOW - 4 * DAY, NOW - 4 * DAY, 'g-' + mid, thread)
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent, last_followup_at, stopped) VALUES ('A', ?, ?, ?, ?, ?, ?, 0, NULL, NULL)").run(thread, lead, email, 'root-' + mid, NOW - 4 * DAY, NOW - 4 * DAY)
  grantConsent(db, 'A', email, { channel: 'email', scope: 'followup', basis: 'reply_interest', evidenceRef: 'gmail:1', now: NOW - 4 * DAY })
  return { lead, thread }
}

const followupFlags = { AUTOPILOT_ENABLED: '1', SEQUENCES_ENABLED: '1' }

test('withdraw stops a warm follow-up thread before send; re-confirm does not resurrect it', async () => {
  const db = await setupFollowups()
  const { lead, thread } = interestedReviewThread(db)
  const m = mock()
  assert.equal(unconfirmLeadReview(db, 'A', lead), true)
  const r = await runFollowups(db, 'A', 'Acme', { ...m, flags: followupFlags })
  assert.equal(r.sent, 0)
  assert.equal(m.calls.length, 0)
  assert.equal((db.prepare('SELECT stopped FROM followup_threads WHERE thread_id = ?').get(thread) as { stopped: string | null }).stopped, 'evidence_withdrawn')
  // Re-confirming restores lead eligibility, but the stopped thread stays stopped.
  assert.equal(confirmLeadReview(db, 'A', lead), true)
  const r2 = await runFollowups(db, 'A', 'Acme', { ...m, flags: followupFlags, now: NOW + 10 * DAY })
  assert.equal(r2.sent, 0)
  assert.equal(m.calls.length, 0)
  assert.equal((db.prepare('SELECT stopped FROM followup_threads WHERE thread_id = ?').get(thread) as { stopped: string | null }).stopped, 'evidence_withdrawn')
})

test('withdraw during a follow-up token fetch: zero send, claim row deleted, thread stopped', async () => {
  const db = await setupFollowups()
  const { lead, thread } = interestedReviewThread(db)
  const m = mock()
  const withdrawFetch = (async (u: unknown) => {
    const url = String(u)
    if (url.includes('oauth2')) { unconfirmLeadReview(db, 'A', lead); return json({ access_token: 'at' }) }
    if (url.includes('/threads/')) return json({ messages: [] })
    return json({}, 404)
  }) as typeof fetch
  const r = await runFollowups(db, 'A', 'Acme', { ...m, flags: followupFlags, fetchImpl: withdrawFetch })
  assert.equal(r.sent, 0)
  assert.equal(m.calls.length, 0)
  assert.equal((db.prepare('SELECT stopped FROM followup_threads WHERE thread_id = ?').get(thread) as { stopped: string | null }).stopped, 'evidence_withdrawn')
  assert.equal((db.prepare('SELECT count(*) AS n FROM followup_messages').get() as { n: number }).n, 0) // claim deleted, none stuck sending
})
