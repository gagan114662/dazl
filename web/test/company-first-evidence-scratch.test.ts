import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHmac } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAuth } from '../lib/auth-db.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateKeys } from '../lib/llm/key-store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateTenantLifecycle } from '../lib/db/tenant-guard.ts'
import { qaClaudeOnlyBudget, QA_LOCAL_EXECUTION } from '../lib/scan/qa-provider-policy.ts'
import { verifyScorecardTicket, SCORECARD_ADMISSION_DDL } from '../lib/company-first/scorecard-admission.ts'
import { migrateScorecardWorkspaceSqlite } from '../lib/company-first/scorecard-workspace.ts'
import { migrateScorecardDispatchSqlite } from '../lib/company-first/scorecard-dispatch.ts'
import { armProtectedScorecardJobSqlite } from '../lib/company-first/scorecard-producer.ts'
import { openPrivateEvidenceScratch } from '../lib/company-first/scorecard-evidence-scratch.ts'

function fixture(){
  const primary=new Database(':memory:')
  const hex=(n:number,w=64)=>n.toString(16).padStart(w,'0')
  const tenantId='fixture-workspace',actorId='fixture-owner',jobId=hex(70,24),release=hex(71,40)
  const revision=hex(72),cohort=hex(73),nonce=hex(74),key=Buffer.alloc(32,11)
  const epoch=Date.now(), expires=epoch+30_000, presets=Array.from({length:7},(_,i)=>hex(i+1))
  let now=epoch
  const clock=()=>now
  const query='Fixture request',icp=JSON.stringify({summary:'Fixture only'})
  const budget=JSON.stringify({...JSON.parse(qaClaudeOnlyBudget(JSON.stringify({first5:true}),true)),execution:QA_LOCAL_EXECUTION})
  const mac=createHmac('sha256',key).update(JSON.stringify(['legacy-observation-v1',actorId,tenantId,jobId,1,Math.floor(expires/1000),
    query,icp,null,null,null,budget])).digest('hex')
  const payload=Buffer.from(JSON.stringify([tenantId,actorId,jobId,1,revision,cohort,1,nonce,expires,presets,mac,release,'old'])).toString('base64url')
  const token=payload+'.'+createHmac('sha256',key).update('dazl-scorecard-ticket:v1\n'+payload).digest('hex')
  const expected={tenantId,actorId,jobId,attempt:1 as const,release}
  migrateAuth(primary);migrateScan(primary);migrateKeys(primary);migratePlans(primary);migrateConnectors(primary)
  migrateScorecardWorkspaceSqlite(primary)
  for(const q of SCORECARD_ADMISSION_DDL)primary.exec(q)
  migrateScorecardDispatchSqlite(primary);migrateTenantLifecycle(primary)
  primary.prepare("INSERT INTO users(id,email,name,business_name,password_hash,salt,email_verified_at) VALUES (?,?,'','','','',1)")
    .run(actorId,'private-actor-address@example.test')
  primary.prepare("INSERT INTO organizations(id,kind,created_by,created_at,company_first_scorecard_enabled,company_first_scorecard_revision) VALUES (?,'team',?,1,1,?)")
    .run(tenantId,actorId,revision)
  primary.prepare("INSERT INTO memberships(tenant_id,member_id,role,created_at) VALUES (?,?,'owner',1)").run(tenantId,actorId)
  primary.prepare("INSERT INTO tenant_llm_keys (tenant_id,vendor,ciphertext,last4,validated_at) VALUES (?,'anthropic','fixture-never-copy-key','0000',1)").run(tenantId)
  const ticket=verifyScorecardTicket(token,key,expected,epoch)!
  assert.deepEqual(armProtectedScorecardJobSqlite(primary,ticket,{query,icp},clock),{ok:true,jobId})
  const start=()=>primary.prepare("UPDATE scan_jobs SET company_scorecard_dispatch_started_at=?,company_scorecard_dispatch_release=? WHERE id=?").run(epoch,release,jobId)
  const input={query,icp}
  const open=()=>openPrivateEvidenceScratch(primary,expected,token,key,input,clock)
  return {primary,clock,start,open,token,expected,key,input,expire:()=>{now=expires}}
}
const candidate={candidateOrdinal:1,eventQuote:'Fictional public business signal',sourceUrl:'https://example.test/news',eventDay:'2026-11-20'}
test('actual SQLite physical isolation and bounded private transfer; no unproven Ready or place promoted',()=>{
  const f=fixture()
  try{
    assert.equal(f.open(),null);f.start()
    // Ordinary primary rows are never copied into the evidence store.
    f.primary.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url) VALUES('ordinary',?,'PRIVATE history','signal','https://example.test/ordinary')").run(f.expected.jobId)
    const before=f.primary.prepare('SELECT total_changes()').pluck().get()
    const s=f.open()!
    assert.ok(s);assert.equal(s.add(candidate),'recorded');assert.equal(s.add(candidate),'invalid_evidence')
    assert.equal(s.add({...candidate,candidateOrdinal:2,requiredGateFailed:true}),'recorded')
    assert.equal(s.add({...candidate,candidateOrdinal:3,eventQuote:'person@example.test'}),'invalid_evidence')
    assert.equal(s.add({...candidate,candidateOrdinal:3,sourceUrl:'https://127.0.0.1/'}),'invalid_evidence')
    assert.equal(s.add({...candidate,candidateOrdinal:6}),'invalid_evidence')
    const receipt=s.seal()!
    assert.deepEqual(receipt.candidates,[{ordinal:1,canonicalReady:false,rightPlace:null},{ordinal:2,canonicalReady:false,rightPlace:null}])
    assert.match(receipt.seal,/^[0-9a-f]{64}$/)
    assert.doesNotMatch(JSON.stringify(receipt),/ordinary|Fixture|example|actor-address|tenant|job|signal/i)
    assert.equal(s.seal(),null);assert.equal(s.add(candidate),'not_authorized')
    assert.equal(f.primary.prepare('SELECT COUNT(*) FROM leads').pluck().get(),1)
    assert.equal(f.primary.prepare('SELECT COUNT(*) FROM scan_spend_calls').pluck().get(),0)
    assert.equal(f.primary.prepare('SELECT total_changes()').pluck().get(),before)
  }finally{f.primary.close()}
})
test('bad signed scope and wrong deployment are refused; revocation and expiry destroy scratch',()=>{
  const f=fixture()
  try{
    f.start()
    assert.equal(openPrivateEvidenceScratch(f.primary,f.expected,f.token+'x',f.key,f.input,f.clock),null)
    assert.equal(openPrivateEvidenceScratch(f.primary,{...f.expected,release:'a'.repeat(40)},f.token,f.key,f.input,f.clock),null)
    const s=f.open()!;assert.equal(s.add(candidate),'recorded')
    f.primary.exec('UPDATE organizations SET company_first_scorecard_enabled=0')
    assert.equal(s.add({...candidate,candidateOrdinal:2}),'not_authorized')
    f.primary.exec('UPDATE organizations SET company_first_scorecard_enabled=1')
    assert.equal(s.seal(),null)
    const e=f.open()!;assert.equal(e.add(candidate),'recorded');f.expire()
    assert.equal(e.seal(),null);assert.equal(e.add(candidate),'not_authorized');assert.equal(f.open(),null)
  }finally{f.primary.close()}
})

test('canonical finish and enrichment use isolated SQLite, discard callback payloads, and close captured handles',async()=>{
  const {withCanonicalEvidenceScratch}=await import('../lib/company-first/scorecard-evidence-scratch.ts')
  const {sqliteDb}=await import('../lib/db/client.ts')
  const {finishJob}=await import('../lib/scan/store-db.ts')
  const {addEnrichment}=await import('../lib/connectors/store.ts')
  const f=fixture()
  let captured:Database.Database|undefined
  try{
    assert.deepEqual(f.primary.prepare('SELECT query,icp,sources,seller,offer FROM scan_jobs').get(),
      {query:null,icp:null,sources:null,seller:null,offer:null})
    let entered=false
    const run=(work:Parameters<typeof withCanonicalEvidenceScratch>[5])=>withCanonicalEvidenceScratch(f.primary,f.expected,f.token,f.key,f.input,work,f.clock)
    assert.equal(await run(()=>{entered=true}),null);assert.equal(entered,false)
    f.start()
    assert.equal(await withCanonicalEvidenceScratch(f.primary,f.expected,f.token,f.key,{...f.input,query:'wrong subject'},()=>{entered=true},f.clock),null)
    assert.equal(entered,false)
    const before=f.primary.prepare('SELECT total_changes()').pluck().get()
    const receipt=await run(async ({db,job,signal})=>{
      entered=true; captured=db
      assert.equal(signal.aborted,false)
      assert.deepEqual(db.prepare('SELECT query,icp,icp_inferred,status,attempts FROM scan_jobs').get(),
        {...f.input,icp_inferred:0,status:'running',attempts:1})
      assert.equal(db.prepare('SELECT COUNT(*) FROM leads').pluck().get(),0)
      assert.deepEqual(db.pragma('database_list'),[{seq:0,name:'main',file:''}])
      assert.throws(()=>db.prepare('SELECT * FROM tenant_llm_keys'),/no such table/)
      assert.throws(()=>db.prepare('SELECT * FROM scan_spend_calls'),/no such table/)
      const now=Math.floor(f.clock()/1000),date=new Date(now*1000).toISOString().slice(0,10)
      assert.deepEqual(await finishJob(sqliteDb(db),job,{status:'done',error:null,now,candidates:8,review:[{
        name:'PRIVATE fixture person',company:'PRIVATE fixture company',signal:'PRIVATE fixture quote',source_url:'https://example.test/news',
        score:70,evidence_excerpt:'PRIVATE fixture excerpt',event_date:date,dedup_key:'private-opaque',review_reason:'needs review',
      }]}),{owned:true,inserted:['private-opaque|https://example.test/news']})
      const id=db.prepare('SELECT id FROM leads').pluck().get() as string
      addEnrichment(db,job.user_id,id,{connector:'scan:gate',kind:'gate_failed',value:'PRIVATE fixture marker',label:null,
        confidence:null,source_url:'https://example.test/news',source_date:date,retrieved_at:now})
    })
    assert.equal(entered,true);assert.ok(receipt);assert.equal(receipt.candidateCount,8)
    assert.deepEqual(receipt.candidates,[{ordinal:1,canonicalReady:false,rightPlace:null,ownedSource:false,namedBuyer:false,publishedWorkEmail:false}])
    assert.doesNotMatch(JSON.stringify(receipt),/PRIVATE fixture|fixture-|example\.test|private-opaque|actor|tenant|job/i)
    assert.equal(captured?.open,false)
    assert.throws(()=>captured!.prepare('SELECT 1'),/not open/i)
    assert.equal(f.primary.prepare('SELECT total_changes()').pluck().get(),before)
    assert.equal(f.primary.prepare('SELECT COUNT(*) FROM leads').pluck().get(),0)
  }finally{f.primary.close()}
})

test('revocation within callback discards private data and closes scratch on refusal',async()=>{
  const {withCanonicalEvidenceScratch}=await import('../lib/company-first/scorecard-evidence-scratch.ts')
  const f=fixture()
  let captured:Database.Database|undefined, signal:AbortSignal|undefined
  try{
    f.start()
    const receipt=await withCanonicalEvidenceScratch(f.primary,f.expected,f.token,f.key,f.input,async x=>{
      captured=x.db;signal=x.signal
      await Promise.resolve()
      f.primary.exec('UPDATE organizations SET company_first_scorecard_enabled=0')
      return {raw:'private result is not treated as evidence'} as never
    },f.clock)
    assert.equal(receipt,null);assert.equal(signal?.aborted,true);assert.equal(captured?.open,false)
  }finally{f.primary.close()}
})

test('canonical currentness and strict named publication distinguish proven, guessed and wrong-origin rows',async()=>{
  const {withCanonicalEvidenceScratch}=await import('../lib/company-first/scorecard-evidence-scratch.ts')
  const {addEnrichment}=await import('../lib/connectors/store.ts')
  const {migrateEmailGuess}=await import('../lib/people/email-pattern.ts')
  const {recordTimingProof}=await import('../lib/scan/timing-proof.ts')
  const f=fixture()
  try{
    f.start()
    const result=await withCanonicalEvidenceScratch(f.primary,f.expected,f.token,f.key,f.input,({db,job})=>{
      const s=Math.floor(f.clock()/1000), day=new Date(s*1000).toISOString().slice(0,10)
      migrateEmailGuess(db)
      const ids=['1','2','3'].map(x=>x.repeat(24))
      for(const [i,id] of ids.entries()){
        const source=i===2?'https://news.example/news':'https://acme-dental.test/news'
        db.prepare(`INSERT INTO leads(id,scan_job_id,company,name,contact,signal,source_url,evidence_excerpt,confidence,
          score,fit,intent,action,signal_kind,event_date,event_date_proof,company_domain)
          VALUES(?,?,'Acme Dental','Dana Lee','dana.lee@acme-dental.test','Opened new clinic',?,
            'Acme Dental opened its second clinic.',80,70,4,4,3,'expansion',?,'page_bound','acme-dental.test')`).run(id,job.id,source,day)
        const site=(kind:string,value:string,url:string,label:string|null=null)=>
          addEnrichment(db,job.user_id,id,{connector:'sitecrawl',kind,value,label,source_url:url,confidence:null,source_date:day,retrieved_at:s})
        site('domain','acme-dental.test|evidence_own_domain','https://acme-dental.test/news','domain-basis-v1:evidence_own_domain')
        site('person','Dana Lee, Owner','https://acme-dental.test/team')
        site('email','dana.lee@acme-dental.test','https://acme-dental.test/team')
        addEnrichment(db,job.user_id,id,{connector:'scan:actionable',kind:'actionability',value:'Actionable: domain, person and published contact confirmed',
          label:'Dana Lee, Owner - email: dana.lee@acme-dental.test',source_url:'https://invalid.example/',confidence:null,source_date:day,retrieved_at:s})
        // Synthetic capture of the only stored tier the real strict reader accepts.
        db.prepare(`INSERT INTO email_candidates(tenant_id,lead_id,person,address,format,country_basis,tier,source_url)
          VALUES(?,?, 'Dana Lee, Owner','dana.lee@acme-dental.test',?,'site',?,?)`).run(job.user_id,id,i===1?'first.last':'published',
            i===1?'guessed':'published',i===1?null:'https://acme-dental.test/team')
      }
      assert.deepEqual(recordTimingProof(db,job),{proven:3,held:0})
      db.prepare("UPDATE scan_jobs SET status='done',claimed_at=NULL,finished_at=? WHERE id=?").run(s,job.id)
    },f.clock)
    assert.ok(result);assert.equal(result.candidateCount,null)
    assert.deepEqual(result.candidates,[
      {ordinal:1,canonicalReady:true,rightPlace:null,ownedSource:true,namedBuyer:true,publishedWorkEmail:true},
      {ordinal:2,canonicalReady:true,rightPlace:null,ownedSource:true,namedBuyer:true,publishedWorkEmail:false},
      {ordinal:3,canonicalReady:true,rightPlace:null,ownedSource:false,namedBuyer:false,publishedWorkEmail:false},
    ])
    assert.doesNotMatch(JSON.stringify(result),/acme|dana|https/i)
  }finally{f.primary.close()}
})
