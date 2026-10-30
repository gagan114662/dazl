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
import { applyPendingLifecycle, forgetLifecycleUser, lifecycleHold, reconcileLifecycle, recordLifecycleEvent } from '../lib/outreach/lifecycle.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { stopReasonWords } from '../lib/outreach/lifecycle-words.ts'

const NOW = 1800000000, DAY = 86400
const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', PUBLIC_BASE_URL: 'https://app.test' }
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v),{ status })
async function setup() {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
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


// #417: a prospect of dazl's own acquisition outreach (DAZL_ACQUISITION_TENANTS) who signs up or pays leaves it, with
// durable, private state and honest labels. Stub Gmail, synthetic accounts; off unless the workspace is named.
const ACQ = { DAZL_ACQUISITION_TENANTS: 'A' }
process.env.DAZL_ACQUISITION_TENANTS = 'A' // the send paths read the process configuration
const D = (db: Database.Database) => sqliteDb(db)
const seqRow = (db: Database.Database, lead: string) => db.prepare('SELECT status, stop_reason FROM sequences WHERE lead_id = ?').get(lead) as { status: string; stop_reason: string | null }
const holdRow = (db: Database.Database) => db.prepare('SELECT status FROM acquisition_holds').all()
const user = (db: Database.Database, id: string, email: string) => db.prepare("INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, 'x', 'y')").run(id, email)
const signup = async (db: Database.Database, id: string, email: string) => { user(db, id, email); await recordLifecycleEvent(D(db), { key: `signup:${id}`, kind: 'signup_unverified', userId: id, email }, ACQ); return applyPendingLifecycle(D(db), ACQ, NOW + DAY) }

test('#417 an unverified sign-up is a hold, never a customer; Google verification, then payment, promote it; weaker evidence never relabels', async () => {
  const db = await setup(), s = add(db, 'owner@prospect.example'), m = mock(); await start(db, s, m)
  await signup(db, 'u1', 'Owner@Prospect.example')
  assert.deepEqual(holdRow(db), [{ status: 'unverified_signup_hold' }])
  assert.deepEqual(seqRow(db, s.lead), { status: 'stopped', stop_reason: 'unverified_signup_hold' })
  assert.equal(stopReasonWords('unverified_signup_hold'), 'on hold: someone signed up for dazl with this address (not verified yet)')
  for (const at of [NOW + 3 * DAY, NOW + 7 * DAY]) await runSequences(db, 'A', '', { ...m, now: at })
  assert.equal(m.calls.length, 1, 'held: no further sales email')
  // Google verification promotes it; the stopped sequence's reason follows.
  await recordLifecycleEvent(D(db), { key: 'verified:u1', kind: 'signup_verified', userId: 'u1', email: 'owner@prospect.example' }, ACQ); await applyPendingLifecycle(D(db), ACQ)
  assert.deepEqual([holdRow(db), seqRow(db, s.lead).stop_reason], [[{ status: 'signed_up' }], 'converted_signup'])
  // A paid checkout promotes it again; a later unverified or unpaid event never relabels it down.
  await recordLifecycleEvent(D(db), { key: 'stripe:evt_paid', kind: 'paid', userId: 'u1', email: 'owner@prospect.example' }, ACQ)
  await recordLifecycleEvent(D(db), { key: 'stripe:evt_late', kind: 'checkout_unpaid', userId: 'u1', email: 'owner@prospect.example' }, ACQ)
  await applyPendingLifecycle(D(db), ACQ)
  assert.deepEqual([holdRow(db), seqRow(db, s.lead).stop_reason], [[{ status: 'paid' }], 'converted_paid'])
  // The audit line this workspace sees names the status, never an address.
  assert.ok((db.prepare("SELECT detail FROM autopilot_audit WHERE action = 'acquisition_hold'").all() as { detail: string }[]).every(r => !r.detail.includes('@')))
})

test('#417 a checkout that took no payment (trial or unpaid) is not a paying customer', async () => {
  const db = await setup(), s = add(db, 'owner@prospect.example'), m = mock(); await start(db, s, m)
  user(db, 'u2', 'owner@prospect.example')
  await recordLifecycleEvent(D(db), { key: 'stripe:evt_trial', kind: 'checkout_unpaid', userId: 'u2', email: 'owner@prospect.example' }, ACQ); await applyPendingLifecycle(D(db), ACQ)
  assert.deepEqual([holdRow(db), seqRow(db, s.lead).stop_reason], [[{ status: 'checkout_unpaid' }], 'checkout_unpaid'])
  assert.doesNotMatch(stopReasonWords('checkout_unpaid'), /paying|customer/)
})

test('#417 durable: a recorded event holds sends at once; a failed apply stays pending and is applied later; a hook that never ran is reconciled; retries never skip it', async () => {
  // Recorded, not applied yet (the apply step failed or has not run): the send path already refuses (fail closed).
  { const db = await setup(), s = add(db, 'owner@prospect.example'), m = mock(); await start(db, s, m)
    user(db, 'u3', 'owner@prospect.example')
    await recordLifecycleEvent(D(db), { key: 'signup:u3', kind: 'signup_unverified', userId: 'u3', email: 'owner@prospect.example' }, ACQ)
    assert.equal(lifecycleHold(db, 'A', 'owner@prospect.example', ACQ), 'unverified_signup_hold')
    await runSequences(db, 'A', '', { ...m, now: NOW + 3 * DAY })
    assert.equal(m.calls.length, 1)
    // An apply that throws leaves the event pending; the next pass applies it.
    const broken = { ...D(db), tx: async () => { throw new Error('store unavailable') } } as ReturnType<typeof D>
    await assert.rejects(applyPendingLifecycle(broken, ACQ), /store unavailable/)
    assert.equal((db.prepare('SELECT count(*) AS n FROM lifecycle_events WHERE applied_at IS NULL').get() as { n: number }).n, 1, 'still pending, not marked processed')
    const r = await reconcileLifecycle(D(db), ACQ, NOW + 4 * DAY)
    assert.equal(r.applied >= 1, true); assert.equal(seqRow(db, s.lead).status, 'stopped')
    // The same event key again (a retried hook): no duplicate row, nothing re-applied.
    assert.equal(await recordLifecycleEvent(D(db), { key: 'signup:u3', kind: 'signup_unverified', userId: 'u3', email: 'owner@prospect.example' }, ACQ), false) }
  // The account was created but the hook never ran (a crash after the commit): the scheduler's reconciliation records and applies it.
  { const db = await setup(), s = add(db, 'owner@prospect.example'), m = mock(); await start(db, s, m)
    user(db, 'u4', 'owner@prospect.example')
    const r = await reconcileLifecycle(D(db), ACQ, NOW + DAY)
    assert.ok(r.recorded >= 1)
    assert.deepEqual(seqRow(db, s.lead), { status: 'stopped', stop_reason: 'unverified_signup_hold' }) }
})

test('#417 privacy: an unmatched sign-up leaves nothing any workspace can read, yet a later cold play to it is refused', async () => {
  const db = await setup()
  await signup(db, 'u5', 'new@customer.example')
  assert.deepEqual(holdRow(db), [], 'no hold row: this workspace never emailed the address')
  assert.equal((db.prepare("SELECT count(*) AS n FROM autopilot_audit WHERE action LIKE 'acquisition%' OR action LIKE 'lifecycle%'").get() as { n: number }).n, 0)
  assert.ok((db.prepare('SELECT * FROM lifecycle_events').all() as Record<string, unknown>[]).every(r => !JSON.stringify(r).includes('@')), 'the private history keeps a hash, never the address')
  assert.equal(lifecycleHold(db, 'A', 'NEW@customer.example', ACQ), 'unverified_signup_hold', 'the private lookup still protects a future campaign')
  // An approved email to that address is refused by the send path.
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare("INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,human_confirmed_at,human_confirmed_from) VALUES ('L1',?,'New Co','new@customer.example','Hiring','https://n.example/jobs','New Co is hiring',90,?, 'test_review')").run(job, NOW)
  db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body) VALUES ('M1','A','L1','new@customer.example','Hi','This is a draft message for review.')").run()
  const m = mock(); approve(db, 'A', 'M1', true)
  await assert.rejects(sendMessage(db, 'A', 'M1', m), /acquisition_hold/)
  assert.equal(m.calls.length, 0)
})

test('#417 off by default; enabling later reconciles the sign-ups missed while off; a deleted account forgets its history', async () => {
  const db = await setup(), s = add(db, 'owner@prospect.example'), m = mock(); await start(db, s, m)
  user(db, 'u6', 'owner@prospect.example')
  assert.equal(await recordLifecycleEvent(D(db), { key: 'signup:u6', kind: 'signup_unverified', userId: 'u6', email: 'owner@prospect.example' }, {}), false)
  assert.deepEqual(await reconcileLifecycle(D(db), {}), { recorded: 0, applied: 0, stopped: { held: 0, drafts: 0, sequences: 0, followups: 0 } })
  assert.equal((db.prepare('SELECT count(*) AS n FROM lifecycle_events').get() as { n: number }).n, 0, 'off: nothing recorded')
  assert.equal(lifecycleHold(db, 'A', 'owner@prospect.example', {}), null)
  const r = await reconcileLifecycle(D(db), ACQ, NOW + DAY)
  assert.equal(r.recorded, 1); assert.equal(seqRow(db, s.lead).stop_reason, 'unverified_signup_hold')
  assert.equal(await forgetLifecycleUser(D(db), 'u6'), 1)
  assert.equal((db.prepare('SELECT count(*) AS n FROM lifecycle_events').get() as { n: number }).n, 0)
  assert.deepEqual(holdRow(db), [{ status: 'unverified_signup_hold' }], 'the stop stays, as an opt-out does')
})

test('#417 the sign-up lands during a step\'s token refresh: that step is not sent', async () => {
  const db = await setup(), s = add(db, 'owner@prospect.example'), m = mock(); await start(db, s, m)
  user(db, 'u7', 'owner@prospect.example')
  const fetchImpl = (async (u: unknown) => { if (String(u).includes('oauth2')) await recordLifecycleEvent(D(db), { key: 'stripe:evt_1', kind: 'paid', userId: 'u7', email: 'owner@prospect.example' }, ACQ); return m.fetchImpl(u as never) }) as typeof fetch
  await runSequences(db, 'A', '', { ...m, fetchImpl, now: NOW + 3 * DAY })
  assert.equal(m.calls.length, 1)
})

test('#417 no guessing: a same-domain or look-alike sign-up changes nothing', async () => {
  const db = await setup(), s = add(db, 'owner@prospect.example'), m = mock(); await start(db, s, m)
  let n = 0
  for (const email of ['other@prospect.example', 'owner@prospect.example.evil', 'owner@prospect-example.com']) await signup(db, `x${n++}`, email)
  assert.deepEqual(holdRow(db), [])
  await runSequences(db, 'A', '', { ...m, now: NOW + 3 * DAY })
  assert.equal(m.calls.length, 2, 'the sequence carries on as approved')
  assert.equal(sequenceStatusByLead(db, 'A').get(s.lead)?.status, 'active')
})

test('#417 stop reasons read in words', () => {
  assert.deepEqual(['converted_signup', 'converted_paid', 'checkout_unpaid', 'evidence_withdrawn', 'reply'].map(stopReasonWords), ['signed up for dazl (verified)', 'became a paying dazl customer', 'started a dazl checkout (no payment yet)', 'lead confirmation withdrawn', 'reply'])
})
