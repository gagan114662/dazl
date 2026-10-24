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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { domainReviewFor } from '../lib/outreach/domain-review.ts'
import { setDomainReview } from '../lib/scan/domain-review-action.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { createReopenDraft, migrateReopen, sendReopen } from '../lib/outreach/reopen.ts'

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
const draft = (db: Database.Database) => (db.prepare("SELECT status FROM reopen_messages WHERE thread_id='t1'").get() as { status: string }).status
const cases: [string, (db: Database.Database) => void, RegExp][] = [
  ['non-sales contact address (support@)', db => { db.prepare("UPDATE followup_threads SET to_email='support@acme.com'").run(); db.prepare("UPDATE reopen_messages SET to_email='support@acme.com'").run() }, /not_sales_contact/],
  ['currentness unconfirmed (machine-graded, not human confirmed)', db => { db.prepare("UPDATE leads SET evidence_excerpt='hiring AEs', confidence=0.9, human_confirmed_at=NULL WHERE id='lead-x'").run() }, /lead_currentness_unconfirmed/],
  ['evidence withdrawn (no excerpt, no human confirmation)', db => { db.prepare("UPDATE leads SET human_confirmed_at=NULL WHERE id='lead-x'").run() }, /lead_evidence_withdrawn/],
]
for (const [name, mut, re] of cases) {
  test(`${name} stops a re-open send: 0 sends, draft kept`, async () => {
    const db = new Database(':memory:'); await seed(db); mut(db)
    const r = await attempt(db); assert.equal(r.sends, 0); assert.match(r.err, re); assert.equal(draft(db), 'draft')
  })
}
test('a confirmed, sales-addressed lead sends once', async () => {
  const db = new Database(':memory:'); await seed(db)
  const r = await attempt(db); assert.equal(r.sends, 1); assert.equal(r.err, ''); assert.equal(draft(db), 'sent')
})
test('evidence withdrawn while the token is being fetched still holds the send (0 sends, draft kept, no claim)', async () => {
  const db = new Database(':memory:'); await seed(db)
  let sends = 0, err = ''
  const slowTf = (async () => { db.prepare("UPDATE leads SET human_confirmed_at=NULL WHERE id='lead-x'").run(); return { ok: true, json: async () => ({ access_token: 'x' }) } }) as never
  try { await sendReopen(db, 'A', 't1', { env, now: NOW, master, sendFn: (async () => { sends++; return { id: 'g' } }) as never, fetchImpl: slowTf }) } catch (e) { err = (e as Error).message }
  assert.equal(sends, 0); assert.match(err, /lead_evidence_withdrawn/); assert.equal(draft(db), 'draft')
})

test('a crawl-sourced address whose website confirmation is missing or withdrawn stops a re-open send (0 sends, draft kept)', async () => {
  const db = new Database(':memory:'); await seed(db); migrateConnectors(db)
  db.prepare("UPDATE leads SET contact = NULL WHERE id = 'lead-x'").run()
  const ins = db.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('A', 'lead-x', 'sitecrawl', ?, ?, ?, ?, '2026-10-24', 10)")
  ins.run('email', 'pat@acme.com', null, 'https://acme.com/contact'); ins.run('domain', 'acme.com|name_probe', 'domain-basis-v1:name_probe', 'https://acme.com/')
  const r = await attempt(db); assert.equal(r.sends, 0); assert.match(r.err, /domain_unconfirmed/); assert.equal(draft(db), 'draft')
})

function crawlLead(db: Database.Database) {
  migrateConnectors(db)
  db.prepare("UPDATE leads SET contact = NULL WHERE id = 'lead-x'").run()
  const ins = db.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('A', 'lead-x', 'sitecrawl', ?, ?, ?, ?, '2026-10-24', 10)")
  ins.run('email', 'pat@acme.com', null, 'https://acme.com/contact'); ins.run('domain', 'acme.com|name_probe', 'domain-basis-v1:name_probe', 'https://acme.com/')
  const rows = () => db.prepare('SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ?').all('lead-x') as never
  setDomainReview(db, 'A', 'lead-x', 'confirm', domainReviewFor({ id: 'lead-x', contact: null }, rows()).binding!)
}
test('reopen: a website confirmation withdrawn during the token fetch holds the send (0 sends, draft kept)', async () => {
  const db = new Database(':memory:'); await seed(db); crawlLead(db)
  let sends = 0, err = ''
  const tfw = (async () => { setDomainReview(db, 'A', 'lead-x', 'withdraw'); return { ok: true, json: async () => ({ access_token: 'x' }) } }) as never
  try { await sendReopen(db, 'A', 't1', { env, now: NOW, master, sendFn: (async () => { sends++; return { id: 'g' } }) as never, fetchImpl: tfw }) } catch (e) { err = (e as Error).message }
  assert.equal(sends, 0); assert.match(err, /domain_unconfirmed/); assert.equal(draft(db), 'draft')
})
test('reopen: the lead gates and the claim share the write lock (a second connection holding it blocks the claim, nothing sends)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ro-')); const f = join(dir, 'a.db')
  const a = new Database(f); await seed(a); crawlLead(a)
  const b = new Database(f, { timeout: 0 })
  let sends = 0, err = ''
  const tfLock = (async () => { a.exec('BEGIN IMMEDIATE'); return { ok: true, json: async () => ({ access_token: 'x' }) } }) as never
  try { await sendReopen(b, 'A', 't1', { env, now: NOW, master, sendFn: (async () => { sends++; return { id: 'g' } }) as never, fetchImpl: tfLock }) } catch (e) { err = (e as Error).message }
  a.exec('COMMIT')
  assert.equal(sends, 0); assert.match(err, /locked|busy/i); assert.equal(draft(a), 'draft')
})
