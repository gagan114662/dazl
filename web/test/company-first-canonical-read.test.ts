import assert from 'node:assert/strict'
import test from 'node:test'
import {createHmac} from 'node:crypto'
import Database from 'better-sqlite3'
import {migrateAllSqlite} from '../lib/db/sqlite-migrations.ts'
import {addEnrichment} from '../lib/connectors/store.ts'
import {recordTimingProof} from '../lib/scan/timing-proof.ts'
import {companyKey} from '../lib/scan/evidence.ts'
import {listedProfileLabel} from '../lib/people/site-profile.ts'
import {verifyScorecardTicket,scorecardPinnedBudget,SCORECARD_ANCHOR} from '../lib/company-first/scorecard-admission.ts'
import {readPrivateCompanyFirstProof} from '../lib/company-first/company-first-canonical-read.ts'

const now=Date.parse('2026-11-20T12:00:00Z'), sec=now/1000, expires=now+50_000
const h=(n:number,w=64)=>n.toString(16).padStart(w,'0')
const tenant='fixture-workspace', actor='fixture-owner', scratchTenant='private-scratch'
const job=h(50,24), lead=h(51,24), release=h(53,40), cohort=h(54), nonce=h(55), workspaceRevision=h(56)
const subject={query:'Find firms opening an office in the last 30 days',icp:JSON.stringify({who:['Owner'],window_days:30})}
const key={id:lead,revision:'fixture-evidence-version'}
const budget=scorecardPinnedBudget()
const org='Fixture Harbor', website='https://fixtureharbor.example', linkedin='https://www.linkedin.com/in/fixture-operator'
const expected={companyKey:companyKey(org),website,identitySource:website+'/news',event:'expansion',eventSource:website+'/event',
  eventDate:'2026-11-15',literalQuote:'Fixture Harbor opened a second office.',buyer:'Robin Example',title:'Owner',
  buyerBio:website+'/bio',linkedin,email:'robin.example@fixtureharbor.example',emailSource:website+'/bio'}
const roster=Array.from({length:7},(_,i)=>h(i+1))
function issue(actorId=actor,attempt=1){
 const k=Buffer.alloc(32,17), hash=(s:string)=>createHmac('sha256',k).update(s).digest('hex')
 const mac=hash(JSON.stringify(['legacy-observation-v1',actorId,tenant,job,attempt,Math.floor(expires/1000),subject.query,subject.icp,null,null,null,budget]))
 const raw=Buffer.from(JSON.stringify([tenant,actorId,job,attempt,workspaceRevision,cohort,1,nonce,expires,roster,mac,release,'new'])).toString('base64url')
 return verifyScorecardTicket(raw+'.'+hash('dazl-scorecard-ticket:v1\n'+raw),k,{tenantId:tenant,actorId,jobId:job,attempt,release},now)!
}
function fixture(){
 const p=new Database(':memory:'), db=new Database(':memory:')
 migrateAllSqlite(p);migrateAllSqlite(db)
 const ticket=issue()
 p.prepare("INSERT INTO users (id,email,name,business_name,password_hash,salt) VALUES (?,?,'','','','')").run(actor,'owner@fixture.test')
 p.prepare("INSERT INTO organizations (id,kind,created_by,created_at,company_first_scorecard_enabled,company_first_scorecard_revision) VALUES (?,'team',?,1,1,?)").run(tenant,actor,workspaceRevision)
 p.prepare("INSERT INTO memberships (tenant_id,member_id,role,created_at) VALUES (?,?,'owner',1)").run(tenant,actor)
 p.prepare('INSERT INTO company_scorecard_cohorts VALUES (?,?,?,?,?,?,1)').run(cohort,tenant,actor,workspaceRevision,release,JSON.stringify(roster))
 p.prepare(`INSERT INTO company_scorecard_claims (nonce,tenant_id,cohort,ordinal,job_id,subject_mac,attempt,expires_at,lane,status)
   VALUES (?,?,?,1,?,?,1,?,1,'running')`).run(nonce,tenant,cohort,job,ticket.subjectMac,expires)
 // Simulated already-dispatched primary anchor, no raw protected subject.
 p.prepare(`INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status,attempts,run_budget,
   company_scorecard_claim_nonce,company_scorecard_dispatch_started_at,company_scorecard_dispatch_release)
   VALUES (?,?,?,?,?,'running',1,?,?,?,?)`).run(job,tenant,SCORECARD_ANCHOR.business_name,'(from request)','-',budget,nonce,now,release)
 db.prepare(`INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status,attempts,query,icp,run_budget)
   VALUES (?,?,?,'-','-','running',1,?,?,?)`).run(job,scratchTenant,'private fixture',subject.query,subject.icp,budget)
 db.prepare(`INSERT INTO leads (id,scan_job_id,company,contact,signal,signal_kind,source_url,evidence_excerpt,
   confidence,score,fit,intent,action,source_kind,event_date,event_date_proof,company_domain)
   VALUES (?,?,?,?,'Opened a second office','expansion',?,?,80,75,4,4,3,'query',?,'page_bound',?)`)
   .run(lead,job,org,expected.email,expected.eventSource,expected.literalQuote,expected.eventDate,'fixtureharbor.example')
 const add=(connector:string,kind:string,value:string,url:string,label:string|null=null)=>
   addEnrichment(db,scratchTenant,lead,{connector,kind,value,label,confidence:null,source_url:url,source_date:'2026-11-20',retrieved_at:sec})
 add('sitecrawl','domain','fixtureharbor.example|evidence_own_domain',expected.identitySource,'domain-basis-v1:evidence_own_domain')
 add('sitecrawl','person','Robin Example, Owner',expected.buyerBio,listedProfileLabel(linkedin))
 add('sitecrawl','email',expected.email,expected.emailSource)
 add('scan:actionable','actionability','Actionable: domain, person and published contact confirmed',expected.eventSource,'Robin Example, Owner - email')
 db.prepare(`INSERT INTO email_candidates (tenant_id,lead_id,person,address,format,tier,source_url) VALUES (?,?,?,?,?,'published',?)`)
   .run(scratchTenant,lead,expected.buyer,expected.email,'first.last',expected.emailSource)
 assert.deepEqual(recordTimingProof(db,{id:job,user_id:scratchTenant},new Date(now)),{proven:1,held:0})
 db.prepare("UPDATE scan_jobs SET status='done' WHERE id=?").run(job)
 return {p,db,ticket,read:()=>readPrivateCompanyFirstProof(p,db,ticket,subject,key,expected,undefined,()=>now)}
}

test('all actual canonical read predicates may pass but missing owner stages still hold',async()=>{
 const f=fixture()
 try{
  const r=await f.read()
  assert.deepEqual(r,{state:'held',reason:'authoritative_stages_missing',observed:['required_hold','timing_currentness','owned_buyer_listed_profile','named_published_work_email']})
  assert.equal(JSON.stringify(r).includes(expected.buyer),false)
 }finally{f.db.close();f.p.close()}
})
test('stored stale quote, no named email or timing and a wrong actor/attempt never produce proof',async()=>{
 const f=fixture()
 try{
   const read=(x=f.ticket)=>readPrivateCompanyFirstProof(f.p,f.db,x,subject,key,expected,undefined,()=>now)
   assert.equal(await read(issue('other-owner')).then(r=>r.state==='held'&&r.reason),'wrong_claim')
   assert.equal(await read(issue(actor,2)).then(r=>r.state==='held'&&r.reason),'wrong_claim')
   f.db.prepare("UPDATE leads SET review_reason='sales_hiring_check_failed' WHERE id=?").run(lead)
   assert.equal(await read().then(r=>r.state==='held'&&r.reason),'required_hold')
   f.db.prepare("UPDATE leads SET review_reason=NULL WHERE id=?").run(lead)
   f.db.prepare("UPDATE leads SET evidence_excerpt='Different excerpt' WHERE id=?").run(lead)
   assert.equal(await read().then(r=>r.state==='held'&&r.reason),'evidence_mismatch')
   f.db.prepare('UPDATE leads SET evidence_excerpt=? WHERE id=?').run(expected.literalQuote,lead)
   f.db.prepare("UPDATE email_candidates SET tier='guessed' WHERE lead_id=?").run(lead)
   assert.equal(await read().then(r=>r.state==='held'&&r.reason),'published_email_missing')
   f.db.prepare("DELETE FROM lead_enrichments WHERE connector='scan:timing-proof'").run()
   assert.equal(await read().then(r=>r.state==='held'&&r.reason),'timing_currentness')
 }finally{f.db.close();f.p.close()}
})
