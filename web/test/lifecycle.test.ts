import { migrateConnectors } from '../lib/connectors/store.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { migrateReplies, acceptReadConsent } from '../lib/outreach/replies.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings, approve, sendMessage, createDraft } from '../lib/outreach/service.ts'
import { migrateSequences, createSequence, approveSequence, runSequences, sequenceStatusByLead } from '../lib/outreach/sequences.ts'
import { convertedContact, recordLifecycle as record } from '../lib/outreach/lifecycle.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { stopReasonWords } from '../lib/outreach/lifecycle-words.ts'

const NOW = 1800000000, DAY = 86400
const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', PUBLIC_BASE_URL: 'https://app.test' }
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v),{ status })
async function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db)
  const state = new URL(startOAuth(db,'A',{ env,now: NOW,withRead: true })).searchParams.get('state')!
  await completeOAuth(db,'A','c',state,{ env,master,now: NOW,fetchImpl: (async () => json({ refresh_token: 'test-token', scope: `https://www.googleapis.com/auth/gmail.send ${GMAIL_READ_SCOPE}`, id_token: 'x.'+Buffer.from(JSON.stringify({email:'me@acme.example',email_verified:true})).toString('base64url')+'.y' })) as typeof fetch })
  saveSettings(db,'A',{sender_name:'Pat',postal_address:'1 King St W, Toronto ON M5H 1A1'})
  acceptReadConsent(db,'A')
  return db
}
function add(db: Database.Database, email = 'lead@acme.example') {
  const job = createJob(db,'A',{business_name:'Acme',industry:'x',location:'y'})
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex'), mid = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence) VALUES (?,?,?,?,?,?,?,?)').run(lead,job,'Acme',email,'Hiring roofers','https://acme.example/jobs','Hiring roofers',90)
  // Test baseline is explicitly human-reviewed; no machine timing inference.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run()
  db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body) VALUES (?,'A',?,?,'A quick question','This is a draft message for review.')").run(mid,lead,email)
  const seq = createSequence(db,'A',mid)
  return {job,lead,mid,seq,email}
}
function approval(db: Database.Database, s: ReturnType<typeof add>) { approveSequence(db,'A',s.seq,id => approve(db,'A',id,true),NOW) }
function mock(reply?: string, syncFail = false) {
  const calls: string[] = []
  const fetchImpl = (async (u: unknown) => {
    const url = String(u)
    if (url.includes('oauth2')) return json({ access_token: 'at' })
    if (url.includes('/threads/')) return syncFail ? json({},500) : json({messages: reply ? [{id:'reply-1',internalDate:String((NOW+1)*1000),payload:{mimeType:'text/plain',headers:[{name:'From',value:'lead@acme.example'}],body:{data:Buffer.from(reply).toString('base64url')}}}] : []})
    return json({},404)
  }) as typeof fetch
  const sendFn = (async (_t: string,raw: string) => { calls.push(Buffer.from(raw,'base64url').toString('utf8')); return {id:`gm${calls.length}`,threadId:'thread-1'} })
  return {calls,fetchImpl,sendFn,env,master,now:NOW,flags:{SEQUENCES_ENABLED:'1'}}
}
async function start(db: Database.Database,s: ReturnType<typeof add>,m: ReturnType<typeof mock>) {
  approval(db,s)
  await sendMessage(db,'A',s.mid,m)
}


// #417: a prospect of dazl's own acquisition outreach (DAZL_ACQUISITION_TENANTS) who signs up or pays leaves it:
// whatever is still queued for that exact address stops at once and stays stopped. Stub Gmail, synthetic data.
const ACQ = { DAZL_ACQUISITION_TENANTS: 'A' }
process.env.DAZL_ACQUISITION_TENANTS = 'A' // the send paths read the process configuration
const recordLifecycle = (db: Database.Database, e: Parameters<typeof record>[1], env: Record<string, string | undefined>) => record(sqliteDb(db), e, env)
const seqRow = (db: Database.Database, lead: string) => db.prepare('SELECT status, stop_reason FROM sequences WHERE lead_id = ?').get(lead) as { status: string; stop_reason: string | null }

test('#417 signup while step 2 is queued: the sales step is cancelled, retries and restarts cannot bring it back', async () => {
  const db = await setup(), s = add(db, 'owner@prospect.example'), m = mock(); await start(db, s, m)
  assert.equal(m.calls.length, 1)
  const [r] = await recordLifecycle(db, { kind: 'signup', email: 'Owner@Prospect.example', eventId: 'signup:u1', at: NOW + DAY }, ACQ)
  assert.deepEqual([r.matched, r.duplicate, r.stopped.sequences], [true, false, 1])
  assert.deepEqual(seqRow(db, s.lead), { status: 'stopped', stop_reason: 'converted_signup' })
  for (const at of [NOW + 3 * DAY, NOW + 3 * DAY, NOW + 7 * DAY]) await runSequences(db, 'A', '', { ...m, now: at })
  assert.equal(m.calls.length, 1, 'no further sales email')
  assert.equal(seqRow(db, s.lead).status, 'stopped', 'a restart does not reactivate it')
  // The same event again (a retry) is a no-op.
  assert.equal((await recordLifecycle(db, { kind: 'signup', email: 'owner@prospect.example', eventId: 'signup:u1' }, ACQ))[0].duplicate, true)
})

test('#417 the conversion lands during a step\'s token refresh: that step is not sent', async () => {
  const db = await setup(), s = add(db, 'owner@prospect.example'), m = mock(); await start(db, s, m)
  const fetchImpl = (async (u: unknown) => { if (String(u).includes('oauth2')) await recordLifecycle(db, { kind: 'paid', email: 'owner@prospect.example', eventId: 'stripe:evt_1' }, ACQ); return m.fetchImpl(u as never) }) as typeof fetch
  await runSequences(db, 'A', '', { ...m, fetchImpl, now: NOW + 3 * DAY })
  assert.equal(m.calls.length, 1)
  assert.equal(seqRow(db, s.lead).status, 'stopped')
})

test('#417 queued first touches and approved drafts stop; a later cold play to the customer is refused', async () => {
  const db = await setup()
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare("INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,human_confirmed_at,human_confirmed_from) VALUES ('L1',?,'Prospect','owner@prospect.example','Hiring','https://p.example/jobs','Prospect is hiring',90,?, 'test_review')").run(job, NOW)
  db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body,status,approved_hash) VALUES ('M1','A','L1','owner@prospect.example','Hi','This is a draft message for review.','approved','h')").run()
  db.prepare("CREATE TABLE IF NOT EXISTS autopilot_work (message_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL, reason TEXT NOT NULL, next_at INTEGER, authority TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER, created_at INTEGER NOT NULL)").run()
  db.prepare("INSERT INTO autopilot_work (message_id, tenant_id, lead_id, reason, next_at, authority, created_at) VALUES ('M1','A','L1','daily_cap',?, 'x', ?)").run(NOW + DAY, NOW)
  const [r] = await recordLifecycle(db, { kind: 'signup', email: 'owner@prospect.example', eventId: 'signup:u2' }, ACQ)
  assert.deepEqual(r.stopped, { held: 1, drafts: 1, sequences: 0, followups: 0 })
  assert.deepEqual(db.prepare("SELECT status, approved_hash FROM outreach_messages WHERE id = 'M1'").get(), { status: 'draft', approved_hash: null })
  // Approved again (by hand or by a later play): the send path refuses it.
  const m = mock(); approve(db, 'A', 'M1', true)
  await assert.rejects(sendMessage(db, 'A', 'M1', m), /converted_customer/)
  assert.equal(m.calls.length, 0)
  // A customer who signs up before ever being emailed is excluded too.
  await recordLifecycle(db, { kind: 'signup', email: 'new@customer.example', eventId: 'signup:u3' }, ACQ)
  assert.equal(convertedContact(db, 'A', 'NEW@customer.example', ACQ), true)
})

test('#417 no guessing: a same-domain or same-name signup, or one in a non-acquisition workspace, changes nothing', async () => {
  const db = await setup(), s = add(db, 'owner@prospect.example'), m = mock(); await start(db, s, m)
  for (const email of ['other@prospect.example', 'owner@prospect.example.evil', 'owner@prospect-example.com']) await recordLifecycle(db, { kind: 'signup', email, eventId: `signup:${email}` }, ACQ)
  // Without the operator naming this workspace as dazl's acquisition sender, nothing is recorded or stopped.
  assert.deepEqual(await recordLifecycle(db, { kind: 'signup', email: 'owner@prospect.example', eventId: 'signup:x' }, {}), [])
  assert.equal(convertedContact(db, 'A', 'owner@prospect.example', {}), false)
  assert.deepEqual(seqRow(db, s.lead), { status: 'approved', stop_reason: null }, 'not stopped')
  await runSequences(db, 'A', '', { ...m, now: NOW + 3 * DAY })
  assert.equal(m.calls.length, 2, 'the sequence carries on as approved')
  assert.equal(sequenceStatusByLead(db, 'A').get(s.lead)?.status, 'active')
})

test('#417 the terminal conversion reason reads in words', () => {
  assert.deepEqual(['converted_signup', 'converted_paid', 'converted', 'evidence_withdrawn', 'reply'].map(stopReasonWords), ['signed up for dazl', 'became a paying customer', 'became a customer', 'lead confirmation withdrawn', 'reply'])
})
