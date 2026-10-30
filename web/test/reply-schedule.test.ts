// #413: replies, opt-outs and bounces are read on schedule for every read-authorized tenant, independent of sending
// settings (first-touch only, autopilot off or paused, follow-ups off). Stubbed Gmail only; every address is invented.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings, isSuppressed } from '../lib/outreach/service.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable, migrateAutopilot, pause } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { acceptReadConsent, migrateReplies, revokeReadConsent, syncReplies } from '../lib/outreach/replies.ts'
import { migrateSequences, runSequences } from '../lib/outreach/sequences.ts'
import { migrateReplySchedule, readTenants, replyFreshness, scheduledReplySync, FRESH_FOR_S } from '../lib/outreach/reply-schedule.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const DAY = 86400
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const SEND = 'https://www.googleapis.com/auth/gmail.send'

async function setup(withRead = true) {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db); migrateReplySchedule(db)
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


const optOut = (id: string, from: string, at: number) => ({ id, threadId: 't', internalDate: String(at * 1000), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }], body: { data: Buffer.from('Please remove me from your list.').toString('base64url') } } })
function mailbox(threads: Record<string, unknown[]>, calls: string[]) {
  return (async (url: string) => {
    const u = String(url); calls.push(u)
    if (u.includes('oauth2')) return json({ access_token: 'at' })
    const m = u.match(/threads\/([^?]+)/); if (m) return json({ messages: threads[m[1]] ?? [] })
    return json({}, 404)
  }) as unknown as typeof fetch
}
const syncWith = (f: typeof fetch) => (db: Database.Database, t: string) => syncReplies(db, t, { env: genv, master, now: NOW, fetchImpl: f })

test('first-touch only, autopilot never enabled: an opt-out is ingested on the scheduled pass', async () => {
  const db = await setup()
  db.prepare('DELETE FROM autopilot_settings').run()           // send-only first touch: no autopilot, no follow-ups, no sequence
  const s = sentLead(db, 'pat@buyer.example'); const calls: string[] = []
  assert.deepEqual(readTenants(db, NOW), ['A'])
  const r = await scheduledReplySync(db, { now: NOW, sync: syncWith(mailbox({ [s.thread]: [optOut('r1', 'pat@buyer.example', NOW - DAY)] }, calls)) })
  assert.equal(r.get('A')!.error, undefined)
  assert.equal(isSuppressed(db, 'A', 'pat@buyer.example'), true)
  assert.equal(replyFreshness(db, 'A', NOW), 'fresh')
})

test('sending paused: replies are still read and opt-outs honoured (on main, a paused tenant was read by nothing)', async () => {
  const db = await setup(); pause(db, 'A', 'owner paused sending')
  const s = sentLead(db, 'sam@buyer.example'); const calls: string[] = []
  // the old paths: a paused tenant is skipped by the follow-up tick, and runSequences stops before reading
  const seq = await runSequences(db, 'A', '', { env: genv, master, now: NOW, fetchImpl: mailbox({}, calls), flags: { SEQUENCES_ENABLED: '1' } })
  assert.equal(seq.stopped, 'paused'); assert.equal(calls.length, 0)
  // the scheduled pass reads it
  await scheduledReplySync(db, { now: NOW, sync: syncWith(mailbox({ [s.thread]: [optOut('r2', 'sam@buyer.example', NOW - DAY)] }, calls)) })
  assert.equal(isSuppressed(db, 'A', 'sam@buyer.example'), true)
})

test('revoked read consent, or no read grant: the tenant is not selected and no provider call is made', async () => {
  const db = await setup(); sentLead(db, 'x@buyer.example'); const calls: string[] = []
  revokeReadConsent(db, 'A')
  assert.deepEqual(readTenants(db, NOW), [])
  const r = await scheduledReplySync(db, { now: NOW, sync: syncWith(mailbox({}, calls)) })
  assert.equal(r.size, 0); assert.equal(calls.length, 0)
  const noGrant = await setup(false); sentLead(noGrant, 'y@buyer.example')
  assert.deepEqual(readTenants(noGrant, NOW), [])
  // a tenant with nothing sent in the read window is not read either
  const quiet = await setup()
  assert.deepEqual(readTenants(quiet, NOW), [])
})

test('a failed or partial sync is checkpointed as failed, never fresh; a later success is fresh, and age makes it stale', async () => {
  const db = await setup(); const s = sentLead(db, 'z@buyer.example'); const calls: string[] = []
  const failing = (async (url: string) => { calls.push(String(url)); if (String(url).includes('oauth2')) return json({ access_token: 'at' }); return json({}, 500) }) as unknown as typeof fetch
  const r = await scheduledReplySync(db, { now: NOW, sync: syncWith(failing) })
  assert.equal(r.get('A')!.error, 'reply_sync_failed')
  assert.equal(replyFreshness(db, 'A', NOW), 'failed')
  const crashed = await scheduledReplySync(db, { now: NOW, sync: async () => { throw new Error('boom') } })
  assert.equal(crashed.get('A')!.error, 'sync_crashed'); assert.equal(replyFreshness(db, 'A', NOW), 'failed')
  await scheduledReplySync(db, { now: NOW, sync: syncWith(mailbox({ [s.thread]: [] }, calls)) })
  assert.equal(replyFreshness(db, 'A', NOW), 'fresh')
  assert.equal(replyFreshness(db, 'A', NOW + FRESH_FOR_S + 1), 'stale')
  assert.equal(replyFreshness(db, 'B', NOW), 'unknown')
})

test('the tick reads first, for every read-authorized tenant, and sends only on a sync that succeeded in that tick', () => {
  const src = readFileSync(new URL('../app/api/internal/tick/route.ts', import.meta.url), 'utf8')
  const read = src.indexOf('scheduledReplySync(db'), follow = src.indexOf('runFollowups(db'), seq = src.indexOf('runSequences(db')
  assert.ok(read > 0 && read < follow && read < seq, 'the scheduled read runs before any sending')
  assert.ok(!/syncReplies\(/.test(src), 'no other read path in the tick (one read per tenant per tick)')
  assert.match(src, /if \(!sync \|\| sync\.error\) continue/)                          // follow-ups need this tick's successful sync
  assert.match(src, /runSequences\(db, t\.tenant_id, '', \{ presynced: sync \?\? \{ error: 'reading_not_enabled' \} \}\)/)
})

test('runSequences with a failed presync stops before sending; it does not read the mailbox again', async () => {
  const db = await setup(); const calls: string[] = []
  const r = await runSequences(db, 'A', '', { env: genv, master, now: NOW, fetchImpl: mailbox({}, calls), flags: { SEQUENCES_ENABLED: '1' }, presynced: { error: 'reply_sync_failed' } })
  assert.equal(r.stopped, 'reply_sync_failed'); assert.equal(calls.filter(u => u.includes('gmail.googleapis.com')).length, 0)
})

