import { migrateConnectors } from '../lib/connectors/store.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateReplies } from '../lib/outreach/replies.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { saveSettings } from '../lib/outreach/service.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'
import { createReopenDraft, migrateReopen, sendReopen } from '../lib/outreach/reopen.ts'
import { enable, pause, resume, CONSENT_VERSION, ATTESTATIONS } from '../lib/outreach/autopilot.ts'
const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const idToken = (e: string) => 'x.' + Buffer.from(JSON.stringify({ email: e, email_verified: true })).toString('base64url') + '.y'
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 })
async function seed(db: Database.Database) {
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateReplies(db); migrateLedger(db); migrateReopen(db); migrateAutopilot(db); migrateSequences(db)
  saveSettings(db, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  const state = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'code', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  db.prepare("INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status) VALUES ('job-x','A','b','i','l','running')").run()
  db.prepare("INSERT INTO leads (id,scan_job_id,name,company,contact,signal,source_url) VALUES ('lead-x','job-x','Pat','Acme','pat@acme.com','hiring','https://n.com/a')").run()
  db.prepare("INSERT INTO leads (id,scan_job_id,name,company,contact,signal,source_url) VALUES ('lead-y','job-x','Q','Other','z@acme.com','hiring','https://n.com/b')").run(); 
  db.prepare("UPDATE scan_jobs SET status='done' WHERE id='job-x'").run()
  db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body,status,sent_at) VALUES ('m1','A','lead-x','pat@acme.com','Quick question','Hi Pat, body text here for the first mail.','sent',?)").run(NOW - 86400 * 50)
  db.prepare("INSERT INTO followup_threads (tenant_id,thread_id,lead_id,to_email,root_message_id,last_activity_at,last_lead_reply_at,followups_sent) VALUES ('A','t1','lead-x','pat@acme.com','r@x',?,?,2)").run(NOW - 86400 * 45, NOW - 86400 * 45)
  db.prepare("INSERT INTO inbound_messages (gmail_id,tenant_id,thread_id,lead_id,from_email,excerpt,classification,received_at) VALUES ('g','A','t1','lead-x','pat@acme.com','sounds interesting','positive',?)").run(NOW - 86400 * 45)
  db.prepare("UPDATE leads SET human_confirmed_at = 1 WHERE id = 'lead-x'").run()
  createReopenDraft(db, 'A', 't1', 'Dazl')
}
const tf = (async () => ({ ok: true, json: async () => ({ access_token: 'x' }) })) as never
async function attempt(db: Database.Database) {
  let sends = 0
  const fake = (async () => { sends++; return { id: 'g' } }) as never
  let err = ''
  try { await sendReopen(db, 'A', 't1', { env, now: NOW, master, sendFn: fake, fetchImpl: tf }) } catch (e) { err = (e as Error).message }
  return { sends, err }
}
const turnOn = (db: Database.Database) => enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS] })
const draft = (db: Database.Database) => (db.prepare("SELECT status FROM reopen_messages WHERE thread_id='t1'").get() as { status: string }).status
// Parity with sendMessage: any autopilot pause holds a re-open send too (0 sends, draft kept).
for (const reason of ['paused_by_user', 'bounces', 'uncertain_send', 'gmail_reconnect_needed']) {
  test(`autopilot paused (${reason}) stops a re-open send: 0 sends, draft kept`, async () => {
    const db = new Database(':memory:'); await seed(db); turnOn(db); pause(db, 'A', reason)
    const r = await attempt(db)
    assert.equal(r.sends, 0); assert.match(r.err, /paused/); assert.equal(draft(db), 'draft')
  })
}
test('autopilot on and not paused, no autopilot row, and another tenant paused: the re-open sends once', async () => {
  for (const setup of [(db: Database.Database) => turnOn(db), (_db: Database.Database) => {}, (db: Database.Database) => { db.prepare("INSERT INTO autopilot_settings (tenant_id, enabled, paused, pause_reason) VALUES ('B',1,1,'paused_by_user')").run() }]) {
    const db = new Database(':memory:'); await seed(db); setup(db)
    const r = await attempt(db); assert.equal(r.sends, 1); assert.equal(r.err, ''); assert.equal(draft(db), 'sent')
  }
})
test('resume lets the same re-open go out exactly once', async () => {
  const db = new Database(':memory:'); await seed(db); turnOn(db); pause(db, 'A')
  assert.equal((await attempt(db)).sends, 0)
  resume(db, 'A'); assert.equal((await attempt(db)).sends, 1)
})
test('a pause that lands while the token is being fetched still holds the send', async () => {
  const db = new Database(':memory:'); await seed(db); turnOn(db)
  let sends = 0, err = ''
  const slowTf = (async () => { pause(db, 'A'); return { ok: true, json: async () => ({ access_token: 'x' }) } }) as never
  try { await sendReopen(db, 'A', 't1', { env, now: NOW, master, sendFn: (async () => { sends++; return { id: 'g' } }) as never, fetchImpl: slowTf }) } catch (e) { err = (e as Error).message }
  assert.equal(sends, 0); assert.match(err, /paused/); assert.equal(draft(db), 'draft')
})
