// Shared post-await send-authority recheck (Refs #739, #925, #405, #467). Converted from the audit's fenced reproducer: synthetic
// tenant and addresses, injected fetch and send functions, no provider and no real send. Each case changes authority DURING the
// token await; the send handoff must then refuse. The control case (nothing changes) must still send, so a pass is not an inert test.
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
import { saveSettings, approve, sendMessage } from '../lib/outreach/service.ts'
import { migrateSequences, createSequence, approveSequence, runSequences } from '../lib/outreach/sequences.ts'

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
    if (url.includes('messages?q=')) return json({ messages: [] }) // no daemon notices in these fixtures
    return json({},404)
  }) as typeof fetch
  const sendFn = (async (_t: string,raw: string) => { calls.push(Buffer.from(raw,'base64url').toString('utf8')); return {id:`gm${calls.length}`,threadId:'thread-1'} })
  return {calls,fetchImpl,sendFn,env,master,now:NOW,flags:{SEQUENCES_ENABLED:'1'}}
}
async function start(db: Database.Database,s: ReturnType<typeof add>,m: ReturnType<typeof mock>) {
  approval(db,s)
  await sendMessage(db,'A',s.mid,m)
}



for (const mode of ['control', 'sender', 'revoke', 'unreadable', 'other_sequence'] as const) {
  test(`sequence step 2, authority ${mode === 'control' ? 'unchanged' : 'changed during the token await'}: ${mode === 'control' ? 'sends' : 'refused, step returns to approved, no handoff'}`, async () => {
    const db = await setup(), s = add(db), m = mock(); await start(db, s, m)
    let tokens = 0; const f = m.fetchImpl
    const d = { ...m, now: NOW + 3 * DAY, fetchImpl: (async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes('oauth2')) {
        tokens++
        if (tokens === 2) {
          if (mode === 'sender') db.prepare("UPDATE gmail_accounts SET email = 'other@other.example' WHERE tenant_id = 'A'").run()
          if (mode === 'revoke') db.prepare("UPDATE consent_ledger SET revoked_at = ? WHERE tenant_id = 'A'").run(NOW + 3 * DAY)
          if (mode === 'unreadable') db.exec('DROP TABLE suppressions')
          // the only live grant now belongs to a different sequence for the same recipient: it must not authorise this step
          if (mode === 'other_sequence') db.prepare("UPDATE consent_ledger SET evidence_ref = 'sequence:another' WHERE tenant_id = 'A' AND scope = 'sequence'").run()
        }
      }
      return f(...args)
    }) as typeof fetch }
    const r = await runSequences(db, 'A', '', d)
    if (mode === 'control') { assert.equal(r.sent, 1); assert.equal(m.calls.length, 2) }
    else {
      assert.equal(r.sent, 0); assert.equal(m.calls.length, 1, 'only step 1 ever left')
      assert.equal((db.prepare("SELECT status FROM sequence_steps WHERE tenant_id = 'A' AND step = 2").get() as { status: string }).status === 'sent', false, 'step 2 not recorded as sent')
    }
    db.close()
  })
}
