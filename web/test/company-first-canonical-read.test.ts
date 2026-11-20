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
import {createOfficialEntityReader,officialCompanyEntityKey,type ReviewedOfficialRegistry} from '../lib/company-first/company-first-official-entity.ts'
import {issueCompanyFirstWebsite} from '../lib/company-first/company-first-origin-issuer.ts'
import {readPrivateCompanyFirstProof} from '../lib/company-first/company-first-canonical-read.ts'

const now=Date.parse('2026-11-20T12:00:00Z'), sec=now/1000, expires=now+50_000
const h=(n:number,w=64)=>n.toString(16).padStart(w,'0')
const tenant='fixture-workspace', actor='fixture-owner', scratchTenant='private-scratch'
const job=h(50,24), lead=h(51,24), release=h(53,40), cohort=h(54), nonce=h(55), workspaceRevision=h(56)
const subject={query:'Find firms opening an office in the last 30 days',icp:JSON.stringify({who:['Owner'],window_days:30})}
const key={id:lead,revision:'fixture-evidence-version'}
const budget=scorecardPinnedBudget()
const org='Fixture Harbor', website='https://fixtureharbor.example', linkedin='https://www.linkedin.com/in/fixture-operator'
const legalIdentity={issuerKey:'fixture.registry',jurisdictionKey:'fixture.jurisdiction',legalId:'FIX-991172'}
const expected={companyKey:officialCompanyEntityKey(legalIdentity),website,identitySource:website+'/news',event:'expansion',eventSource:website+'/event',
  eventDate:'2026-11-15',literalQuote:'Fixture Harbor opened a second office.',buyer:'Robin Example',title:'Owner',
  buyerBio:website+'/bio',linkedin,email:'robin.example@fixtureharbor.example',emailSource:website+'/bio'}
const roster=Array.from({length:7},(_,i)=>h(i+1))
function issue(actorId=actor,attempt=1){
 const k=Buffer.alloc(32,17), hash=(s:string)=>createHmac('sha256',k).update(s).digest('hex')
 const mac=hash(JSON.stringify(['legacy-observation-v1',actorId,tenant,job,attempt,Math.floor(expires/1000),subject.query,subject.icp,null,null,null,budget]))
 const raw=Buffer.from(JSON.stringify([tenant,actorId,job,attempt,workspaceRevision,cohort,1,nonce,expires,roster,mac,release,'new'])).toString('base64url')
 return verifyScorecardTicket(raw+'.'+hash('dazl-scorecard-ticket:v1\n'+raw),k,{tenantId:tenant,actorId,jobId:job,attempt,release},now)!
}
async function issueSite(tenantName=tenant, ownOrigin=website, plainRecord=false) {
 const scope={tenant:tenantName,job,attempt:'1'}, identityUrl=ownOrigin+'/news'
 const ownerBlock=`<p>${org} · ${legalIdentity.legalId}</p>`
 const html=`<html><head><title>${org}</title></head><body>${ownerBlock}</body></html>`
 const expiresAtMs=Math.max(Date.now(),now)+60_000, authorityOrigin='https://fixture-registry.example'
 const exactRecordUrl=authorityOrigin+'/entities/FIX-991172'
 const registry:ReviewedOfficialRegistry={issuerKey:legalIdentity.issuerKey,jurisdictionKey:legalIdentity.jurisdictionKey,reviewVersion:'fixture-review',expiresAtMs,
  authorityOrigin,recordPathPrefix:'/entities/',recordList:['entities'],activeState:'active',establishmentRole:'establishment',
  fields:{id:['id'],legalName:['name'],revision:['revision'],state:['status'],validUntilMs:['validTo'],homepage:['website'],
    establishmentRole:['role'],officeCode:['office'],countryCode:['countryCode'],street:['street'],locality:['locality'],region:['region'],postal:['postal'],country:['country']}}
 const record={id:legalIdentity.legalId,name:org,revision:'fixture-entity-rev',status:'active',validTo:expiresAtMs,website:ownOrigin+'/',
  role:'establishment',office:'fixture-office',countryCode:'fixture-country',street:'Fixture Road',locality:'Fixture City',
  region:'Fixture Province',postal:'AB100',country:'Fixture Republic'}
 const readIndependentRecords=createOfficialEntityReader(registry,{scope,issuerKey:registry.issuerKey,jurisdictionKey:registry.jurisdictionKey,
   registryReviewVersion:registry.reviewVersion,expiresAtMs,legalId:legalIdentity.legalId,legalName:org,recordRevision:record.revision,
   exactRecordUrl,exactHomepage:ownOrigin+'/',exactOwnedIdentityUrl:identityUrl,placeKey:'city',countryKey:'country',
   officialOfficeCode:record.office,officialCountryCode:record.countryCode}, {isCurrent:async()=>true,reserveCurrentRegistryRead:async()=>true},
   async url=>({finalUrl:url,status:200,complete:true,contentEncoding:'identity',contentType:'application/json',body:JSON.stringify({entities:[record]})}))
 const r=await issueCompanyFirstWebsite({enabled:true},scope,{name:org,hintUrl:identityUrl},undefined,{
  readIndependentRecords:plainRecord?async(q,s)=>(await readIndependentRecords(q,s))?.map(record=>({...record}))??null:readIndependentRecords,
  readOwnedIdentityBlocks:body=>[{start:body.indexOf(ownerBlock),end:body.indexOf(ownerBlock)+ownerBlock.length,
   legalName:org,legalIdentity}],authorizeAndReserve:async()=>true,parseRobots:()=>({allows:()=>true,delayMs:0}),
  parsePage:()=>({title:org}),read:async u=>u===identityUrl?{status:200,body:html}:{status:404,body:''},
 })
 assert.equal(r.state,'verified')
 if(r.state!=='verified')throw new Error('fixture issuer failed')
 return r.site
}
async function fixture(){
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
 const owned=await issueSite()
 return {p,db,ticket,read:(site=owned)=>readPrivateCompanyFirstProof(p,db,ticket,subject,key,expected,undefined,()=>now,site),owned}

}

test('all actual canonical read predicates may pass but missing owner stages still hold',async()=>{
 const f=await fixture()
 try{
  const r=await f.read()
  assert.deepEqual(r,{state:'held',reason:'authoritative_stages_missing',observed:['required_hold','timing_currentness','owned_buyer_listed_profile','named_published_work_email']})
  assert.equal(JSON.stringify(r).includes(expected.buyer),false)
 }finally{f.db.close();f.p.close()}
})
test('stored stale quote, no named email or timing and a wrong actor/attempt never produce proof',async()=>{
 const f=await fixture()
 try{
   const read=(x=f.ticket)=>readPrivateCompanyFirstProof(f.p,f.db,x,subject,key,expected,undefined,()=>now,f.owned)
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

test('legal identity maps to the exact canonical display row; forged objects, another tenant and another host do not',async()=>{
 const f=await fixture()
 try{
  assert.notEqual(expected.companyKey,companyKey(org))
  const held=(r:Awaited<ReturnType<typeof f.read>>)=>r.state==='held'?r.reason:null
  assert.equal(held(await f.read({...f.owned})),'evidence_mismatch','same bytes are not a branded issuer object')
  assert.equal(held(await f.read(await issueSite(tenant,website,true))),'evidence_mismatch','the genuine issuer cannot promote cloned registry bytes')
  assert.equal(held(await f.read(await issueSite('other-tenant'))),'evidence_mismatch')
  assert.equal(held(await f.read(await issueSite(tenant,'https://other.example'))),'evidence_mismatch')
  f.db.prepare("UPDATE leads SET company='Fixture Harbor Subsidiary' WHERE id=?").run(lead)
  assert.equal(held(await f.read()),'evidence_mismatch')
  f.db.prepare("UPDATE leads SET company=?,company_domain='branch.fixtureharbor.example' WHERE id=?").run(org,lead)
  assert.equal(held(await f.read()),'evidence_mismatch','registrable-domain equality is not this exact ownership proof')
 }finally{f.db.close();f.p.close()}
})


test('current canonical ownership rejects the right token with an unrecognized provenance label',async()=>{
  const f=await fixture()
  try{
    f.db.prepare("UPDATE lead_enrichments SET label=? WHERE lead_id=? AND kind='domain'").run('domain-basis-v1:old_or_unknown',lead)
    const checked=await f.read()
    assert.equal(checked.state,'held')
    if(checked.state==='held')assert.ok(!checked.observed.includes('owned_buyer_listed_profile'))
  }finally{f.db.close();f.p.close()}
})
