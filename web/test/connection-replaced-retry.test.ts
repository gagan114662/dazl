// #739 review follow-up: a same-address reconnect that lands while a send is minting its token is proven not sent and
// leaves a healthy connection. It must never pause the tenant, ask for another reconnect, or discard an approved draft:
// the work is released and goes out on a later pass with a token bound to the new connection. Injected fetch/send only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateReplies, acceptReadConsent } from '../lib/outreach/replies.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { saveSettings, type Deps } from '../lib/outreach/service.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'
import { createReopenDraft, migrateReopen, sendReopen } from '../lib/outreach/reopen.ts'
import { runFollowups } from '../lib/outreach/followups.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable, migrateAutopilot, runAutopilot } from '../lib/outreach/autopilot.ts'
import { seedOffers } from './helpers/seed-offer.ts'

const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000, DAY = 86400
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
async function connect(db: Database.Database, tenant: string, rt: string) {
  const state = new URL(startOAuth(db, tenant, { env, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, tenant, 'code', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: rt, scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
}
// The first token call is raced by a completed same-address reconnect; later calls mint normally.
function racingFetch(db: Database.Database, tenant: string) {
  let raced = false
  return (async (url: string) => {
    if (!String(url).includes('token')) return json({}, 404)
    if (!raced) { raced = true; await connect(db, tenant, 'rt-2') }
    return json({ access_token: 'at' })
  }) as unknown as typeof fetch
}
const paused = (db: Database.Database, t: string) => db.prepare('SELECT paused, pause_reason FROM autopilot_settings WHERE tenant_id = ?').get(t) as { paused: number; pause_reason: string | null }

test('follow-ups: reconnect during the token fetch releases the claim without pausing; the next pass sends', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const t = 'tr'
  raw.prepare("INSERT INTO autopilot_settings (tenant_id, enabled, paused, consent_version, followups_enabled) VALUES (?, 1, 0, ?, 1)").run(t, CONSENT_VERSION)
  raw.prepare("INSERT INTO outreach_settings (tenant_id, sender_name, postal_address) VALUES (?, 'Pat', '1 King St W, Toronto ON')").run(t)
  raw.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('job', ?, 'b', 'i', 'l', 'running')").run(t)
  raw.prepare("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, human_confirmed_at, human_confirmed_from) VALUES ('l1', 'job', 'Co 1', 'sam1@buyer.example', 's', 'https://n.example/a', 'q', 80, 1800000000, 'test_review')").run()
  raw.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent) VALUES (?, 'th1', 'l1', 'sam1@buyer.example', 'root', ?, ?, 0)").run(t, NOW - 4 * DAY, NOW - 4 * DAY)
  raw.prepare("INSERT INTO consent_ledger (id, tenant_id, contact, channel, scope, basis, evidence_ref, granted_at, expires_at) VALUES ('c1', ?, 'sam1@buyer.example', 'email', 'followup', 'reply_interest', 'gmail:x', ?, ?)").run(t, NOW - DAY, NOW + 90 * DAY)
  raw.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES ('o1', ?, 'l1', 'sam1@buyer.example', 'Intro', 'Thanks for the earlier conversation note.', 'sent', ?)").run(t, NOW - 4 * DAY)
  await connect(raw, t, 'rt-1')
  raw.prepare('UPDATE gmail_accounts SET read_granted = 1 WHERE tenant_id = ?').run(t)
  acceptReadConsent(raw, t)
  raw.prepare("INSERT INTO scheduler_progress (tenant_id, kind, last_attempt_at, last_success_at, last_outcome, consecutive_failures) VALUES (?, 'reply_sync', ?, ?, 'success', 0)").run(t, NOW, NOW)
  let calls = 0
  const d = { env, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: racingFetch(raw, t), flags: { AUTOPILOT_ENABLED: '1' }, sendFn: (async () => { calls++; return { id: 'g1' } }) as never }
  const r1 = await runFollowups(raw, t, 'Biz', d)
  assert.equal(r1.stopped, 'connection_replaced'); assert.equal(calls, 0)
  assert.equal(paused(raw, t).paused, 0, 'a healthy replacement connection is never paused')
  assert.equal((raw.prepare('SELECT count(*) AS n FROM followup_messages').get() as { n: number }).n, 0, 'claim released')
  // The replacement connection carries its own read grant and reply ingest catches up, as after any reconnect.
  raw.prepare('UPDATE gmail_accounts SET read_granted = 1 WHERE tenant_id = ?').run(t)
  acceptReadConsent(raw, t)
  raw.prepare("UPDATE scheduler_progress SET last_attempt_at = ?, last_success_at = ? WHERE tenant_id = ? AND kind = 'reply_sync'").run(NOW + 1, NOW + 1, t)
  const r2 = await runFollowups(raw, t, 'Biz', { ...d, now: NOW + 2 })
  assert.equal(r2.sent, 1); assert.equal(calls, 1)
})

test('re-open: reconnect during the token fetch reports connection_replaced, not gmail_reconnect_needed', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateReplies(db); migrateLedger(db); migrateReopen(db)
  saveSettings(db, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  await connect(db, 'A', 'rt-1')
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('job-x1','A','b','i','l','running')").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, human_confirmed_at) VALUES ('lead-x1', 'job-x1','Pat','Acme','pat@acme.com','hiring AEs','https://n.com/a', 1)").run()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'job-x1'").run()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES ('m1','A','lead-x1','pat@acme.com','Quick question for Acme','Hi Pat, body text here for the first mail.','sent',?)").run(NOW - DAY * 50)
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent, stopped) VALUES ('A','thread-x1','lead-x1','pat@acme.com','root@x',?,?,2,NULL)").run(NOW - DAY * 45, NOW - DAY * 45)
  db.prepare("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES ('gx','A','thread-x1','lead-x1','pat@acme.com','sounds interesting','positive',?)").run(NOW - DAY * 45)
  createReopenDraft(db, 'A', 'thread-x1', 'Dazl')
  let sends = 0
  const d = { env, now: NOW, master, fetchImpl: racingFetch(db, 'A'), sendFn: (async () => { sends++; return { id: 'stub' } }) as never }
  await assert.rejects(sendReopen(db, 'A', 'thread-x1', d), /connection_replaced/)
  assert.equal(sends, 0)
})

test('autopilot first touch: reconnect mid-send holds the approved draft without spending retries, then sends', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); seedOffers(db)
  await connect(db, 'A', 'rt-1')
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 3 })
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('s1a2b3c4d5e6f7a8b9c0d1e2','A','x1','o1@z.example','s','bodybodybodybodybodybody','sent',?,?),('s2a2b3c4d5e6f7a8b9c0d1e2','A','x2','o2@z.example','s','bodybodybodybodybodybody','sent',?,?)").run(NOW - 9e5, NOW - 9e5, NOW - 9e5, NOW - 9e5)
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score, human_confirmed_at, human_confirmed_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('lead1', job, 'Co one', 'a@one.example', 'Hiring roofers', 'https://n.example/a', 'Co is hiring', 90, 80, NOW, 'test_review')
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  const calls: string[] = []
  const d: Deps & { flags: Record<string, string> } = { flags: { AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '2' }, env, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: racingFetch(db, 'A'), sendFn: (async (_t: string, raw: string) => { calls.push(raw); return { id: 'g' } }) as never }
  const r1 = await runAutopilot(db, 'A', 'Acme', d)
  assert.equal(r1.sent, 0); assert.equal(calls.length, 0)
  const m = db.prepare("SELECT id, status FROM outreach_messages WHERE to_email = 'a@one.example'").get() as { id: string; status: string }
  assert.notEqual(m.status, 'skipped', 'never permanently discarded')
  const w = db.prepare("SELECT reason, next_at, attempts FROM autopilot_work WHERE message_id = ?").get(m.id) as { reason: string; next_at: number; attempts: number } | undefined
  assert.ok(w, 'still queued for autopilot, not handed back to the user')
  assert.equal(w.reason, 'connection_replaced'); assert.equal(w.attempts, 0, 'no provider-fault retry budget spent')
  assert.equal((db.prepare('SELECT paused FROM autopilot_settings WHERE tenant_id = ?').get('A') as { paused: number }).paused, 0)
  const r2 = await runAutopilot(db, 'A', 'Acme', { ...d, now: w.next_at + 1 })
  assert.equal(r2.sent, 1); assert.equal(calls.length, 1)
})
