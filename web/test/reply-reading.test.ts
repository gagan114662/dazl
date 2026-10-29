import { migrateConnectors } from '../lib/connectors/store.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings, isSuppressed } from '../lib/outreach/service.ts'
import { ATTESTATIONS, CONSENT_VERSION, disable, enable, migrateAutopilot, pause } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { acceptReadConsent, migrateReplies, readingTenants, readRepliesForAll, replyFreshness, revokeReadConsent, syncReplies } from '../lib/outreach/replies.ts'
import { setFollowups } from '../lib/outreach/followups.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const DAY = 86400
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const SEND = 'https://www.googleapis.com/auth/gmail.send'

async function setup(withRead = true) {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db)
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
const msg = (id: string, from: string, body: string, at: number, extra: { name: string; value: string }[] = []) => ({ id, threadId: 't', internalDate: String(at * 1000), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }, ...extra], body: { data: Buffer.from(body).toString('base64url') } } })
function gmail(threads: Record<string, unknown[]>, calls: string[] = []) {
  return (async (url: string) => {
    const u = String(url); calls.push(u)
    if (u.includes('oauth2')) return json({ access_token: 'at' })
    const m = u.match(/threads\/([^?]+)/); if (m) return json({ messages: threads[m[1]] ?? [] })
    return json({}, 404)
  }) as unknown as typeof fetch
}


// #413: replies, opt-outs and bounces are read for every account that consented to reading, whatever its sending
// settings. Stub Gmail (HTTP-level), synthetic threads; nothing is sent.
const D = (fetchImpl: typeof fetch, now = NOW) => ({ env: genv, master, now, fetchImpl })

test('#413 every read-consented account with a sent thread is read: autopilot off, paused or follow-ups off alike', async () => {
  for (const sending of ['off', 'paused', 'followups_off'] as const) {
    const db = await setup(); const s = sentLead(db, 'a@co.example')
    if (sending === 'off') disable(db, 'A')
    if (sending === 'paused') pause(db, 'A')
    setFollowups(db, 'A', false)
    assert.deepEqual(readingTenants(db, NOW), ['A'], sending)
    const optOut = msg('in1', 'a@co.example', 'Please remove me from your list', NOW - DAY)
    const r = await readRepliesForAll(db, new Set(), { d: D(gmail({ [s.thread]: [optOut] }) ) })
    assert.deepEqual(r, { read: 1, failed: 0 }, sending)
    assert.equal(isSuppressed(db, 'A', 'a@co.example'), true, `${sending}: the opt-out is applied, so nothing more goes to that address`)
    assert.equal(replyFreshness(db, 'A', 3600, NOW), 'fresh')
  }
})

test('#413 who is read: no consent, revoked consent, no read grant or nothing sent in the window means no read and no provider call', async () => {
  const calls: string[] = []
  // Revoked consent: dropped from the list, and a direct sync makes zero provider calls.
  const db = await setup(); const s = sentLead(db, 'a@co.example')
  revokeReadConsent(db, 'A')
  assert.deepEqual(readingTenants(db, NOW), [])
  assert.equal((await syncReplies(db, 'A', D(gmail({ [s.thread]: [] }, calls)))).error, 'reading_not_enabled')
  assert.equal(calls.length, 0, 'no token request, no Gmail read')
  assert.equal(replyFreshness(db, 'A', 3600, NOW), 'unknown')
  // Never consented / no read scope / nothing sent in the last 120 days.
  const noRead = await setup(false); sentLead(noRead, 'b@co.example')
  assert.deepEqual(readingTenants(noRead, NOW), [])
  const old = await setup(); sentLead(old, 'c@co.example', NOW - 121 * DAY)
  assert.deepEqual(readingTenants(old, NOW), [])
  assert.deepEqual(await readRepliesForAll(old, new Set(), { d: D(gmail({}, calls)) }), { read: 0, failed: 0 })
  assert.equal(calls.length, 0)
})

test('#413 a partial sync leaves freshness unknown (the last full read is kept); a later full read is fresh again', async () => {
  const db = await setup(); const a = sentLead(db, 'a@co.example'); const b = sentLead(db, 'b@two.example')
  await syncReplies(db, 'A', D(gmail({ [a.thread]: [], [b.thread]: [] }), NOW))
  assert.equal(replyFreshness(db, 'A', 3600, NOW), 'fresh')
  // b's thread fails to load: the sync reports it, freshness is unknown, and the earlier full read is not overwritten.
  const half = (async (url: string) => String(url).includes('oauth2') ? json({ access_token: 'at' }) : String(url).includes(b.thread) ? json({}, 500) : json({ messages: [] })) as unknown as typeof fetch
  const r = await syncReplies(db, 'A', D(half, NOW + 600))
  assert.equal(r.error, 'reply_sync_failed')
  assert.equal(replyFreshness(db, 'A', 3600, NOW + 600), 'unknown')
  assert.deepEqual(db.prepare('SELECT ok_at, error, failed_threads FROM reply_sync_state').get(), { ok_at: NOW, error: 'reply_sync_failed', failed_threads: 1 })
  assert.equal((await readRepliesForAll(db, new Set(), { d: D(half, NOW + 900) })).failed, 1)
  await syncReplies(db, 'A', D(gmail({ [a.thread]: [], [b.thread]: [] }), NOW + 1200))
  assert.equal(replyFreshness(db, 'A', 3600, NOW + 1200), 'fresh')
  assert.equal(replyFreshness(db, 'A', 3600, NOW + 1200 + 3601), 'stale')
})

test('#413 the scheduler pass skips accounts already read this tick and reads each other one once', async () => {
  const db = await setup(); const s = sentLead(db, 'a@co.example'); const calls: string[] = []
  assert.deepEqual(await readRepliesForAll(db, new Set(['A']), { d: D(gmail({ [s.thread]: [] }, calls)) }), { read: 0, failed: 0 })
  assert.equal(calls.length, 0)
  let kept = 0
  assert.deepEqual(await readRepliesForAll(db, new Set(), { each: async () => { kept++ }, d: D(gmail({ [s.thread]: [] }, calls)) }), { read: 1, failed: 0 })
  assert.equal(kept, 1, 'the lease hook runs before each account')
})
