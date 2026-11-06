// #740 / PR #930 review: a Gmail connection replaced while a follow-up tick awaits its token must not drop that
// thread's pending follow-up. The claim is released (no row stuck in 'sending'), the thread is untouched, autopilot
// is not paused, nothing is sent, and the next tick sends through the replacement. Synthetic tenant, stub HTTP.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { startOAuth, completeOAuth } from '../lib/gmail/oauth.ts'
import { runFollowups } from '../lib/outreach/followups.ts'
import { acceptReadConsent } from '../lib/outreach/replies.ts'
import { CONSENT_VERSION } from '../lib/outreach/autopilot.ts'

const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000, DAY = 86400, T = 'tr', TH = 'th-tr-1'
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'

function connect(db: Database.Database, refresh: string) {
  const state = new URL(startOAuth(db, T, { env, now: NOW })).searchParams.get('state')!
  return completeOAuth(db, T, 'code', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: refresh, scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
}

async function setup() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  db.prepare("INSERT INTO autopilot_settings (tenant_id, enabled, paused, consent_version, followups_enabled) VALUES (?, 1, 0, ?, 1)").run(T, CONSENT_VERSION)
  db.prepare("INSERT INTO outreach_settings (tenant_id, sender_name, postal_address) VALUES (?, 'Pat', '1 King St W, Toronto ON')").run(T)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('job-tr', ?, 'b', 'i', 'l', 'running')").run(T)
  db.prepare("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES ('lead-tr-1', 'job-tr', 'Co 1', 'sam1@buyer.example', 's', 'https://n.example/a', 'q', 80)").run()
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE id='lead-tr-1'").run()
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent) VALUES (?, ?, 'lead-tr-1', 'sam1@buyer.example', 'root', ?, ?, 0)").run(T, TH, NOW - 4 * DAY, NOW - 4 * DAY)
  db.prepare("INSERT INTO consent_ledger (id, tenant_id, contact, channel, scope, basis, evidence_ref, granted_at, expires_at) VALUES ('c-tr-1', ?, 'sam1@buyer.example', 'email', 'followup', 'reply_interest', 'gmail:x', ?, ?)").run(T, NOW - DAY, NOW + 90 * DAY)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES ('orig-tr-1', ?, 'lead-tr-1', 'sam1@buyer.example', 'Intro', 'Thanks for the earlier conversation note.', 'sent', ?)").run(T, NOW - 4 * DAY)
  await connect(db, 'rt-old')
  db.prepare('UPDATE gmail_accounts SET read_granted = 1 WHERE tenant_id = ?').run(T)
  acceptReadConsent(db, T)
  db.prepare("INSERT INTO scheduler_progress (tenant_id, kind, last_attempt_at, last_success_at, last_outcome, consecutive_failures) VALUES (?, 'reply_sync', ?, ?, 'success', 0)").run(T, NOW, NOW)
  return db
}
const thread = (db: Database.Database) => db.prepare('SELECT followups_sent, stopped, last_followup_at FROM followup_threads WHERE tenant_id = ? AND thread_id = ?').get(T, TH)
const autopilot = (db: Database.Database) => db.prepare('SELECT paused, pause_reason FROM autopilot_settings WHERE tenant_id = ?').get(T) as { paused: number; pause_reason: string | null }

for (const [label, reply] of [['old token success', () => json({ access_token: 'old-at' })], ['old invalid_grant', () => json({ error: 'invalid_grant' }, 400)]] as const) {
  test(`follow-up: connection replaced during the token await keeps the pending follow-up for the next tick (${label})`, async () => {
    const db = await setup()
    let sends = 0
    const sendFn = (async () => { sends++; return { id: 'gm-1', threadId: TH } }) as never
    const replacing = (async () => {
      db.prepare('DELETE FROM gmail_accounts WHERE tenant_id = ?').run(T)
      await connect(db, 'rt-new')
      return reply()
    }) as unknown as typeof fetch
    const base = { env, master, now: NOW, baseUrl: 'https://app.test', flags: { AUTOPILOT_ENABLED: '1' }, sendFn }
    const r1 = await runFollowups(db, T, 'Biz', { ...base, fetchImpl: replacing })
    assert.equal(r1.stopped, 'gmail_unavailable')
    assert.equal(sends, 0, 'nothing is sent with a replaced connection')
    assert.equal(db.prepare("SELECT count(*) AS n FROM followup_messages WHERE tenant_id = ? AND status IN ('sending','uncertain')").get(T).n, 0, 'claim released, nothing stuck in sending')
    assert.deepEqual(thread(db), { followups_sent: 0, stopped: null, last_followup_at: null }, 'the pending follow-up is still due')
    assert.equal(autopilot(db).paused, 0, 'a replacement does not pause autopilot')
    assert.equal(db.prepare("SELECT status FROM gmail_accounts WHERE tenant_id = ?").get(T).status, 'active')

    // The replacement grants read access again (a fresh connection starts without it), so reply safety can clear.
    db.prepare('UPDATE gmail_accounts SET read_granted = 1 WHERE tenant_id = ?').run(T)
    const tokenOk = (async (url: string) => (String(url).includes('token') ? json({ access_token: 'new-at' }) : json({}, 404))) as unknown as typeof fetch
    const r2 = await runFollowups(db, T, 'Biz', { ...base, fetchImpl: tokenOk })
    assert.equal(r2.sent, 1, 'the next tick sends through the replacement')
    assert.equal(sends, 1)
    assert.equal(thread(db).followups_sent, 1)
    db.close()
  })
}

test('follow-up control: a genuine reconnect failure on an unreplaced connection still pauses', async () => {
  const db = await setup()
  const r = await runFollowups(db, T, 'Biz', { env, master, now: NOW, baseUrl: 'https://app.test', flags: { AUTOPILOT_ENABLED: '1' }, fetchImpl: (async () => json({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch, sendFn: (async () => { throw new Error('must not send') }) as never })
  assert.equal(r.stopped, 'gmail_unavailable')
  assert.deepEqual(autopilot(db), { paused: 1, pause_reason: 'gmail_reconnect_needed' })
  assert.equal(thread(db).followups_sent, 0)
  db.close()
})
