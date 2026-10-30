import { migrateConnectors } from '../lib/connectors/store.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateAutopilot, getState } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { migrateReplies, acceptReadConsent } from '../lib/outreach/replies.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings, approve, sendMessage, editDraft, suppress } from '../lib/outreach/service.ts'
import { migrateSequences, createSequence, editSequenceStep, approveSequence, setTestAddresses, runSequences, sequenceAnalytics, sequenceStatusByLead } from '../lib/outreach/sequences.ts'
import { accountSendCount } from '../lib/outreach/send-budget.ts'

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

test('sequence approval covers all exact steps; editing drops the entire approval',async()=>{
  const db=await setup(),s=add(db)
  assert.throws(()=>approve(db,'A',s.mid),/approve_sequence_set/)
  approval(db,s)
  assert.equal((db.prepare('SELECT count(*) AS n FROM sequence_steps WHERE approved_hash IS NOT NULL').get() as {n:number}).n,3)
  editSequenceStep(db,'A',s.seq,2,{subject:'Re: changed',body:'A changed follow-up body for your review.'})
  assert.equal((db.prepare('SELECT status FROM sequences').get() as {status:string}).status,'draft')
  assert.equal((db.prepare('SELECT count(*) AS n FROM sequence_steps WHERE approved_hash IS NOT NULL').get() as {n:number}).n,0)
  await assert.rejects(sendMessage(db,'A',s.mid,mock()),/not_approved/)
})

test('ordinary first-step edit also invalidates all sequence approvals',async()=>{
  const db=await setup(),s=add(db);approval(db,s)
  editDraft(db,'A',s.mid,{subject:'New subject',body:'New first message body for review.'})
  assert.equal((db.prepare('SELECT status FROM sequences').get() as {status:string}).status,'draft')
  assert.equal((db.prepare('SELECT count(*) AS n FROM sequence_steps WHERE approved_hash IS NOT NULL').get() as {n:number}).n,0)
})

test('steps send at day 3 and day 7 from first send; repeat ticks cannot duplicate',async()=>{
  const db=await setup(),s=add(db),m=mock(); await start(db,s,m)
  assert.equal((await runSequences(db,'A','', {...m,now:NOW+179})).sent,0)
  assert.equal((await runSequences(db,'A','', {...m,now:NOW+3*DAY})).sent,1)
  assert.equal((await runSequences(db,'A','', {...m,now:NOW+3*DAY})).sent,0)
  assert.equal((await runSequences(db,'A','', {...m,now:NOW+7*DAY})).sent,1)
  assert.equal(m.calls.length,3)
  assert.equal(sequenceStatusByLead(db,'A').get(s.lead)?.status,'done')
  assert.ok(m.calls.every(raw=>raw.includes('unsubscribe')))
})

test('test timing is server allowlist only; no flag accelerates a prospect',async()=>{
  const db=await setup(),s=add(db),m=mock(); await start(db,s,m)
  assert.equal((await runSequences(db,'A','', {...m,now:NOW+180,flags:{SEQUENCES_ENABLED:'1',TEST_MODE:'1'}})).sent,0)
  setTestAddresses(db,'A',[s.email])
  assert.equal((await runSequences(db,'A','', {...m,now:NOW+180})).sent,1)
  setTestAddresses(db,'A',[])
  assert.equal((await runSequences(db,'A','', {...m,now:NOW+420})).sent,0)
})

test('any human reply stops sequence; failed reply sync never sends',async()=>{
  for (const reply of ['Who is this?','Sounds good','Not interested','Please unsubscribe']) {
    const db=await setup(),s=add(db),m=mock(); await start(db,s,m)
    await runSequences(db,'A','',{...mock(reply),now:NOW+3*DAY})
    assert.notEqual(sequenceStatusByLead(db,'A').get(s.lead)?.status,'active',reply)
    assert.equal(m.calls.length,1)
  }
  const db=await setup(),s=add(db),m=mock();await start(db,s,m)
  const broken=mock(undefined,true)
  assert.equal((await runSequences(db,'A','',{...broken,now:NOW+3*DAY})).stopped,'reply_sync_failed')
  assert.equal(broken.calls.length,0)
})

// #355: a sync that stops at its bound before reaching a sequence's thread is not a failure, and not a read either: the
// step waits for the thread to be read, then goes out.
test('a bounded reply sync that did not reach the thread sends no step until it is read',async()=>{
  const db=await setup(),s=add(db),m=mock(); await start(db,s,m)
  const r=await runSequences(db,'A','',{...m,now:NOW+3*DAY,maxThreads:0})
  assert.deepEqual([r.sent,r.stopped],[0,undefined])
  assert.equal(m.calls.length,1,'only step 1')
  assert.equal((await runSequences(db,'A','',{...m,now:NOW+3*DAY})).sent,1)
  assert.equal(m.calls.length,2)
})

test('suppression and unapproved mutations cannot send',async()=>{
  const db=await setup(),s=add(db),m=mock();await start(db,s,m)
  suppress(db,'A',s.email,'unsubscribe')
  assert.equal((await runSequences(db,'A','',{...m,now:NOW+3*DAY})).sent,0)
  const db2=await setup(),s2=add(db2),m2=mock();await start(db2,s2,m2)
  db2.prepare("UPDATE sequence_steps SET body = 'tampered body after the approval' WHERE step = 2").run()
  assert.equal((await runSequences(db2,'A','',{...m2,now:NOW+3*DAY})).sent,0)
})

test('uncertain sequence send pauses account and never retries; all senders share budget',async()=>{
  const db=await setup(),s=add(db),m=mock();await start(db,s,m)
  const failing={...m,now:NOW+3*DAY,sendFn:async()=>{throw new Error('timeout')}}
  assert.equal((await runSequences(db,'A','',failing)).stopped,'uncertain_send')
  assert.equal(getState(db,'A').paused,true)
  assert.equal((await runSequences(db,'A','',failing)).sent,0)
  assert.equal(accountSendCount(db,'A',NOW+3*DAY),1)
})

test('analytics are tenant/campaign scoped and contain no opens',async()=>{
  const db=await setup(),s=add(db),m=mock();await start(db,s,m)
  assert.equal(sequenceAnalytics(db,'A',[s.lead]).sent,1)
  assert.equal(sequenceAnalytics(db,'A',[]).sent,0)
  assert.equal(sequenceAnalytics(db,'B').sent,0)
  assert.ok(!('opened' in sequenceAnalytics(db,'A')))
})

test('20-account budget counts first touch, warm follow-ups and sequence claims once',async()=>{
  const db=await setup(),s=add(db),m=mock();await start(db,s,m)
  for(let n=0;n<19;n++) db.prepare("INSERT INTO followup_messages (tenant_id,thread_id,step,status,created_at) VALUES ('A',?,0,'sent',?)").run('warm-'+n,NOW+3*DAY)
  assert.equal(accountSendCount(db,'A',NOW+3*DAY),19)
  await runSequences(db,'A','',{...m,now:NOW+3*DAY})
  assert.equal(accountSendCount(db,'A',NOW+3*DAY),20)
  const s2=add(db,'second@acme.example');approval(db,s2)
  await assert.rejects(sendMessage(db,'A',s2.mid,{...m,now:NOW+3*DAY}),/daily_cap/)
})

test('overlapping scheduler ticks cannot send the same step twice or advance step 3 first',async()=>{
  const db=await setup(),s=add(db),m=mock();await start(db,s,m)
  const rows=await Promise.all([runSequences(db,'A','',{...m,now:NOW+7*DAY}),runSequences(db,'A','',{...m,now:NOW+7*DAY})])
  assert.equal(rows.reduce((n,r)=>n+r.sent,0),1)
  assert.equal(m.calls.length,2)
})

test('unreadable/disabled reply reading, operator kill switch and disabled scheduler fail closed',async()=>{
  const db=await setup(),s=add(db),m=mock();await start(db,s,m)
  assert.equal((await runSequences(db,'A','',{...m,now:NOW+3*DAY,flags:{SEQUENCES_ENABLED:'0'}})).sent,0)
  assert.equal((await runSequences(db,'A','',{...m,now:NOW+3*DAY,flags:{SEQUENCES_ENABLED:'1',AUTOPILOT_KILL:'1'}})).sent,0)
  db.prepare('DELETE FROM mail_read_consent').run()
  assert.equal((await runSequences(db,'A','',{...m,now:NOW+3*DAY})).stopped,'reading_not_enabled')
})

test('tenant isolation and tampered later step cannot pass step-1 send approval',async()=>{
  const db=await setup(),s=add(db),m=mock()
  assert.throws(()=>editSequenceStep(db,'B',s.seq,2,{subject:'x',body:'An unauthorized edit of the body.'}),/not_found/)
  approval(db,s)
  db.prepare("UPDATE sequence_steps SET body = 'An unapproved third message body' WHERE step = 3").run()
  await assert.rejects(sendMessage(db,'A',s.mid,m),/changed_since_approval/)
  assert.equal(m.calls.length,0)
})

test('editing while first-step token refresh is in flight cannot change approved words',async()=>{
  const db=await setup(),s=add(db),m=mock();approval(db,s)
  let release!:()=>void
  const gate=new Promise<void>(r=>{release=r})
  const sending=sendMessage(db,'A',s.mid,{...m,fetchImpl:(async()=>{await gate;return json({access_token:'at'})}) as typeof fetch})
  await new Promise(r=>setTimeout(r,0))
  assert.throws(()=>editSequenceStep(db,'A',s.seq,2,{subject:'New subject',body:'This edit must not be allowed while sending.'}),/not_editable/)
  release();await sending
  assert.equal(m.calls.length,1)
})

test('permanent bounce stops, auto replies do not, and no real sends occur in tests',async()=>{
  const db=await setup(),s=add(db),m=mock();await start(db,s,m)
  const bounced={...mock(),now:NOW+3*DAY}
  const base=bounced.fetchImpl
  bounced.fetchImpl=(async(u:unknown)=>String(u).includes('/threads/')?json({messages:[{id:'bounce',internalDate:String((NOW+1)*1000),payload:{mimeType:'text/plain',headers:[{name:'From',value:'mailer-daemon@example.invalid'}],body:{data:Buffer.from('Delivery failed 5.1.1 recipient not found').toString('base64url')}}}]}):base(u as string)) as typeof fetch
  assert.equal((await runSequences(db,'A','',bounced)).sent,0)
  assert.equal(sequenceStatusByLead(db,'A').get(s.lead)?.status,'stopped')
})

test('autoreply does not count as a human reply or stop the sequence',async()=>{
  const db=await setup(),s=add(db),m=mock();await start(db,s,m)
  const auto=mock();const base=auto.fetchImpl
  auto.fetchImpl=(async(u:unknown)=>String(u).includes('/threads/')?json({messages:[{id:'auto',internalDate:String((NOW+1)*1000),payload:{mimeType:'text/plain',headers:[{name:'From',value:s.email},{name:'Auto-Submitted',value:'auto-replied'}],body:{data:Buffer.from('Out of office').toString('base64url')}}}]}):base(u as string)) as typeof fetch
  assert.equal((await runSequences(db,'A','',{...auto,now:NOW+3*DAY})).sent,1)
  assert.equal(sequenceAnalytics(db,'A',[s.lead]).replied,0)
})

test('already approved active sequence stops when lead becomes held',async()=>{
 const db=await setup(),s=add(db),m=mock()
 await start(db,s,m)
 await runSequences(db,'A','', {...m,now:NOW+1})
 db.prepare('UPDATE leads SET fit=0,intent=NULL WHERE id=?').run(s.lead)
 assert.equal((await runSequences(db,'A','', {...m,now:NOW+3*DAY})).sent,0)
 assert.equal(m.calls.length,1)
 assert.equal((db.prepare('SELECT stop_reason FROM sequences WHERE id=?').get(s.seq) as {stop_reason:string}).stop_reason,'lead_ungraded')
})

test('removing test grant blocks an already approved consumer sequence',async()=>{
 const db=await setup(); setTestAddresses(db,'A',['instinct114114@gmail.com'])
 const s=add(db,'instinct114114@gmail.com'),m=mock()
 process.env.OUTREACH_TEST_TENANT_ID='A'
 try {
  await start(db,s,m)
  await runSequences(db,'A','', {...m,now:NOW+1})
  delete process.env.OUTREACH_TEST_TENANT_ID
  assert.equal((await runSequences(db,'A','', {...m,now:NOW+180})).sent,0)
  assert.equal(m.calls.length,1)
  assert.equal((db.prepare('SELECT stop_reason FROM sequences WHERE id=?').get(s.seq) as {stop_reason:string}).stop_reason,'personal_email')
 } finally { delete process.env.OUTREACH_TEST_TENANT_ID }
})

test('known recruitment context holds sequence approval/execution without cancel or history rewrite',async()=>{
 const db=await setup(),s=add(db),m=mock()
 db.prepare("UPDATE leads SET evidence_excerpt='Send your CV to lead@acme.example' WHERE id=?").run(s.lead)
 assert.throws(()=>approval(db,s),/not_sales_contact/)
 db.prepare("UPDATE leads SET evidence_excerpt='Hiring roofers' WHERE id=?").run(s.lead);await start(db,s,m)
 await runSequences(db,'A','',{...m,now:NOW+1})
 const original=db.prepare('SELECT subject,body,status,approved_hash FROM sequence_steps ORDER BY step').all()
 db.prepare("UPDATE leads SET evidence_excerpt='Send your CV to lead@acme.example' WHERE id=?").run(s.lead)
 assert.equal((await runSequences(db,'A','',{...m,now:NOW+3*DAY})).sent,0)
 assert.equal(m.calls.length,1);assert.deepEqual(db.prepare('SELECT subject,body,status,approved_hash FROM sequence_steps ORDER BY step').all(),original)
 assert.equal(sequenceStatusByLead(db,'A').get(s.lead)?.status,'active')
})

test('sequence context restriction appearing during token await releases step without send',async()=>{
 const db=await setup(),s=add(db),m=mock();await start(db,s,m);await runSequences(db,'A','',{...m,now:NOW+1})
 const fetchImpl=(async(u:unknown)=>{if(String(u).includes('oauth2')){db.prepare("UPDATE leads SET evidence_excerpt='Send your CV to lead@acme.example' WHERE id=?").run(s.lead);return json({access_token:'at'})}return json({messages:[]})}) as typeof fetch
 assert.equal((await runSequences(db,'A','',{...m,fetchImpl,now:NOW+3*DAY})).sent,0)
 assert.equal(m.calls.length,1);assert.deepEqual(db.prepare('SELECT status,claimed_at FROM sequence_steps WHERE step=2').get(),{status:'approved',claimed_at:null})
})
