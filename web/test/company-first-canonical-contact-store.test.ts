import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { verifyScorecardTicket, scorecardPinnedBudget } from '../lib/company-first/scorecard-admission.ts'
import { armProtectedScorecardJobSqlite } from '../lib/company-first/scorecard-producer.ts'
import { dispatchScorecardAware } from '../lib/company-first/scorecard-dispatch.ts'
import {runCompanyFirst} from '../lib/company-first/company-first-evidence.ts'
import {preverifyCompanyFirstDiscovery,verifySingleCanonicalDraft} from '../lib/company-first/company-first-canonical-discovery.ts'
import {withNewDiscoveryScratch} from '../lib/company-first/scorecard-evidence-scratch.ts'
import {runWithScanSpend,scanCapConfig} from '../lib/scan/spend-cap.ts'
import {gradeCanonicalVerifiedDraft} from '../lib/company-first/company-first-protected-grading.ts'
import {proveCompanyFirstContact, isIssuedCompanyFirstContact, type OfficialBio} from '../lib/company-first/company-first-contact-proof.ts'
import {prepareCanonicalContact,stageCanonicalContactRow,verifyCanonicalContact} from '../lib/company-first/company-first-final-proof-adapter.ts'
import { bindGuardedCompanyFirstContact, readGuardedOwnRolePage, readGuardedOwnRoleReceipt } from '../lib/company-first/company-first-guarded-contact.ts'
import type { ObservedSafeGet } from '../lib/sources/http.ts'
import { stageCanonicalSiteContact } from '../lib/company-first/company-first-canonical-contact-store.ts'
import { companyFirstPublicReader } from '../lib/company-first/company-first-public-reader.ts'
import { createOfficialEntityReader, officialCompanyEntityKey, type ReviewedOfficialRegistry } from '../lib/company-first/company-first-official-entity.ts'
import { issueCompanyFirstWebsite } from '../lib/company-first/company-first-origin-issuer.ts'
import type {WebsiteProof} from '../lib/company-first/company-first-website-proof.ts'

for(const market of [
  {place:'Seattle',where:'Seattle, Washington, United States',postal:'Seattle, WA 98101',published:'candidate',route:true},
  {place:'Toronto',where:'Toronto, Ontario, Canada',postal:'Toronto, ON M5S 1T8',published:'display_only',route:false},
  {place:'York',where:'York, United Kingdom',postal:'York YO1 8RS',published:'display_only',route:true},
]) test('scope-bound scratch contact store: '+market.where,async()=>{
  const db=new Database(':memory:')
  const hex=(n:number,length=64)=>n.toString(16).padStart(length,'0')
  const actorId='fixture-actor',tenantId='fixture-tenant',key=Buffer.alloc(32,11),release=hex(101,40),revision=hex(102)
  const cohort=hex(103),expiry=Date.now()+60_000,presets=Array.from({length:7},(_,i)=>hex(i+1))
  const offer='Office communications services for growing businesses',query='Find firms opening offices in '+market.where,icp=JSON.stringify({summary:'Office buyers',where:[market.where]})
  function auth(lane:'old'|'new'){
    const jobId=hex(lane==='old'?104:105,24),nonce=hex(lane==='old'?106:107)
    const h=(data:string)=>createHmac('sha256',key).update(data).digest('hex')
    const mac=h(JSON.stringify(['legacy-observation-v1',actorId,tenantId,jobId,1,Math.floor(expiry/1000),
      query,icp,offer,null,null,scorecardPinnedBudget()]))
    const b=Buffer.from(JSON.stringify([tenantId,actorId,jobId,1,revision,cohort,1,nonce,expiry,presets,mac,release,lane])).toString('base64url')
    const signedToken=b+'.'+h('dazl-scorecard-ticket:v1\n'+b)
    const ticket=verifyScorecardTicket(signedToken,key,{tenantId,actorId,jobId,attempt:1,release},Date.now())
    assert.ok(ticket)
    return {ticket,signedToken,signingKey:key,jobId}
  }
  const signal=new AbortController().signal
  try {
    migrateAllSqlite(db)
    db.prepare("INSERT INTO users (id,email,name,business_name,password_hash,salt,email_verified_at) VALUES (?,?,'','','','',1)").run(actorId,'fixture@example.test')
    db.prepare("INSERT INTO organizations (id,kind,created_by,created_at,company_first_scorecard_enabled,company_first_scorecard_revision) VALUES (?,'team',?,1,1,?)").run(tenantId,actorId,revision)
    db.prepare("INSERT INTO memberships (tenant_id,member_id,role,created_at) VALUES (?,?,'owner',1)").run(tenantId,actorId)
    db.prepare("INSERT INTO tenant_llm_keys (tenant_id,vendor,ciphertext,last4,validated_at) VALUES (?,'anthropic','fixture-presence-only','0000',1)").run(tenantId)
    const old=auth('old'), fresh=auth('new')
    assert.deepEqual(armProtectedScorecardJobSqlite(db,old.ticket,{query,icp,offer}),{ok:true,jobId:old.jobId})
    // Prior lane complete is fixture setup; no baseline transport.
    db.prepare("UPDATE company_scorecard_claims SET status='complete' WHERE job_id=?").run(old.jobId)
    db.prepare("UPDATE scan_jobs SET status='done',claimed_at=NULL,finished_at=unixepoch() WHERE id=?").run(old.jobId)
    assert.deepEqual(armProtectedScorecardJobSqlite(db,fresh.ticket,{query,icp,offer}),{ok:true,jobId:fresh.jobId})
    const port=sqliteDb(db)
    let calls=0
    const outcome=await dispatchScorecardAware(port,{id:fresh.jobId,user_id:tenantId,attempts:1},async()=>{assert.fail('no legacy')},{
      release,materialFor:async()=>fresh,
      async runPrivate(execution){try {
        calls++
        let captured:Database.Database|undefined
        const expected={tenantId,actorId,jobId:fresh.jobId,release,attempt:1 as const}
        assert.equal(await withNewDiscoveryScratch(db,expected,old.signedToken,key,{query,icp,offer},()=>assert.fail('old ticket')),false)
        assert.equal(await withNewDiscoveryScratch(db,expected,fresh.signedToken,key,{query:'wrong private input',icp},()=>assert.fail('wrong scope')),false)
        assert.equal(await withNewDiscoveryScratch(db,expected,fresh.signedToken,key,{query,icp,offer},async privateRun=>{ try {
          const scratch=captured=privateRun.db
          assert.equal(scratch.open,true)
          assert.throws(()=>scratch.prepare('SELECT * FROM tenant_llm_keys'),/no such table/)
          assert.throws(()=>scratch.prepare('SELECT * FROM scan_spend_calls'),/no such table/)
          const scope={tenant:tenantId,job:fresh.jobId,attempt:'1'}
          const name='Fixture Harbor',site='https://fixtureharbor.example',url=site+'/news'
          const day=new Date().toISOString().slice(0,10), quote=`${name} opened its second office in ${market.where} on ${day}.`
          const legal={issuerKey:'fixture.registry',jurisdictionKey:'fixture.place',legalId:'FIX-5544'}
          const registryOrigin='https://fixture-authority.example'
          const listing=registryOrigin+'/entities/'+legal.legalId
          const registry:ReviewedOfficialRegistry={issuerKey:legal.issuerKey,jurisdictionKey:legal.jurisdictionKey,reviewVersion:'fixture-review',expiresAtMs:expiry,
            authorityOrigin:registryOrigin,recordPathPrefix:'/entities/',recordList:['entities'],activeState:'active',establishmentRole:'establishment',
            fields:{id:['id'],legalName:['name'],revision:['revision'],state:['status'],validUntilMs:['validTo'],homepage:['website'],
              establishmentRole:['role'],officeCode:['office'],countryCode:['countryCode'],street:['street'],locality:['locality'],region:['region'],postal:['postal'],country:['country']}}
          const legalPage={id:legal.legalId,name,revision:'current',status:'active',validTo:expiry,website:site+'/',role:'establishment',
            office:'office',countryCode:'country',street:'Fixture Road',locality:market.place,region:'District',postal:'POST',country:'Fixture Jurisdiction'}
          const independent=createOfficialEntityReader(registry,{scope,issuerKey:registry.issuerKey,jurisdictionKey:registry.jurisdictionKey,
            registryReviewVersion:registry.reviewVersion,expiresAtMs:expiry,legalId:legal.legalId,legalName:name,recordRevision:legalPage.revision,
            exactRecordUrl:listing,exactHomepage:site+'/',exactOwnedIdentityUrl:url,placeKey:'market',countryKey:'country',
            officialOfficeCode:'office',officialCountryCode:'country'},{isCurrent:async()=>true,reserveCurrentRegistryRead:async()=>true},
            async u=>({finalUrl:u,status:200,complete:true,contentEncoding:'identity',contentType:'application/json',body:JSON.stringify({entities:[legalPage]})}))
          const block='<p>'+name+' '+legal.legalId+'</p>',html='<html><head><title>'+name+'</title></head><body>'+block+'</body></html>'
          const issued=await issueCompanyFirstWebsite({enabled:true},scope,{name,hintUrl:url},undefined,{
            readIndependentRecords:independent,readOwnedIdentityBlocks:body=>[{start:body.indexOf(block),end:body.indexOf(block)+block.length,legalName:name,legalIdentity:legal}],
            authorizeAndReserve:async()=>true,parseRobots:()=>({allows:()=>true,delayMs:0}),parsePage:()=>({title:name}),
            read:async u=>u===url?{status:200,body:html}:{status:404,body:''},
          })
          assert.equal(issued.state,'verified',JSON.stringify(issued))
          if(issued.state!=='verified')assert.fail('fixture ownership')
          const entity=officialCompanyEntityKey(legal)
          const report=await runCompanyFirst({enabled:true},scope,{category:'office firms',place:market.place,event:'expansion',from:day,through:day},{
            reserveBeforeDispatch:async()=>true,isCurrent:async()=>true,discover:async()=>[{name,hintUrl:url}],
            verifyWebsite:async()=>({status:'verified',companyKey:entity,candidateName:name,website:site,identitySource:url}),
            verifyDatedSignal:async()=>({companyKey:entity,place:market.place,event:'expansion',date:day,sourceUrl:url,
              quote,literalSourceText:quote,dateProof:{kind:'first_party_event_date',sourceUrl:url,day,literalDate:day}}),
          })
          assert.equal(report.findings[0]?.state,'signal_verified')
          const read=async (_:unknown,u:string)=>({requestedUrl:u,finalUrl:u,complete:true as const,page:{text:quote,title:name,retrievedAt:1}})
          assert.deepEqual(await preverifyCompanyFirstDiscovery(db,scratch,execution,report.findings,read,signal),{state:'held'})
          db.prepare(`INSERT INTO scan_spend_calls(id,user_id,scan_job_id,attempt,kind,reserve_usd,actual_usd,status,created_at,settled_at)
            VALUES('fixture-paid-1',?,?,1,'llm.anthropic.web_search',.22,.125,'settled',1,1)`).run(tenantId,fresh.jobId)
          db.prepare("INSERT INTO company_scorecard_calls(reservation_id,tenant_id,nonce,lane) VALUES('fixture-paid-1',?,?,1)").run(tenantId,fresh.ticket.nonce)
          assert.deepEqual(await preverifyCompanyFirstDiscovery(db,scratch,execution,report.findings.map(f=>({...f})),read,signal),{state:'held'})
          const measured=await preverifyCompanyFirstDiscovery(db,scratch,execution,report.findings,read,signal)
          assert.equal(measured.state,'preverified')
          if(measured.state==='preverified'){
            assert.equal(measured.literalVerifierPassed,1)
            assert.equal(measured.verifiedPlace,1);assert.equal(measured.canonicalReady,null)
          }
          const finding=report.findings[0]
          assert.ok(finding?.state==='signal_verified')
          const receipt=await verifySingleCanonicalDraft(db,scratch,execution,finding,read,signal)
          assert.ok(receipt)
          // Directory, own bio and independently observed profile fixtures are
          // consumed from the real product contact function before grading.
          const buyer='Robin Example',role='Founder',bioUrl=site+'/team/robin',directory=site+'/team'
          const linkedIn='https://www.linkedin.com/in/example-fixture'
          const email='robin.example@fixtureharbor.example'
          let contactReads=0
          const telephone=market.place==='York'?'<p><a href="tel:+441904123456">+44 1904 123456</a></p>':''
          const wire:ObservedSafeGet=async u=>{
            if(u.startsWith('https://www.linkedin.com'))assert.fail('role is proved from employer site')
            const robots=u.endsWith('/robots.txt')
            if(!robots)contactReads++
            const body=u===site+'/'?'<p>'+name+'</p><p>Address: 42 Fixture Road, '+market.postal+'</p>':
              u===url?'<p>This is the exact verified company website and about page.</p><a href="/team">Our team</a>':
              u===directory?'<article><h2>'+buyer+'</h2><p>'+role+'</p><a href="/team/robin">'+buyer+'</a></article>':
              '<article><h2>'+buyer+'</h2><p>'+role+'</p><p itemprop="worksFor">'+name+'</p>'+(market.place==='York'?'':'<a href="'+linkedIn+'">'+buyer+' on LinkedIn</a>')+
                '<a href="mailto:'+email+'">'+email+'</a></article><p>'+buyer+' email: '+email+'</p>'+telephone
            return {status:robots?404:200,body:robots?'':body,contentType:robots?'text/plain':'text/html',
              finalUrl:u,complete:true,contentEncoding:'identity'}
          }
          const publicRead={isCurrent:async()=>true,reserveCurrentRead:async()=>true}
          const guarded=bindGuardedCompanyFirstContact(scope,{isCurrent:async()=>true,reserveBeforeDispatch:async()=>true,publicRead},wire)
          const observations:OfficialBio[]=[]
          const contact=await proveCompanyFirstContact(finding,[role],scope,{...guarded,async readBio(u,s){
            const p=await guarded.readBio(u,s);if(p)observations.push(p);return p
          }},signal)
          assert.equal(contact.status,'contact_proof',JSON.stringify(contact)+' reads '+contactReads)
          
          assert.equal(contact.buyer.linkedin,market.place==='York'?null:linkedIn)
          assert.equal(isIssuedCompanyFirstContact({...contact},scope,finding),false)
          assert.equal(isIssuedCompanyFirstContact(contact,scope,{...finding}),false)
          const ownRoleBio=observations[0]
          const bio=readGuardedOwnRolePage(ownRoleBio,scope,finding)
          const roleProof=readGuardedOwnRoleReceipt(ownRoleBio,scope,finding)
          const capturedBy=companyFirstPublicReader(scope,publicRead,wire)
          const homepage=await capturedBy.readContactHtml(site+'/',signal)
          assert.ok(homepage&&bio&&roleProof)
          assert.equal(roleProof.observedAtMs,bio.observedAtMs)
          let sends=0
          const grade=await runWithScanSpend({db,jobId:fresh.jobId,tenantId,attempt:1,cap:scanCapConfig({}),
            accountLimits:{day:2,month:5},claudeOnly:true,scorecard:{ticket:execution.ticket,lane:'new'}},
            ()=>gradeCanonicalVerifiedDraft(db,scratch,execution,finding,receipt,'fixture-local-never-sent',signal,async(u,req)=>{
              assert.equal(++sends,1)
              assert.equal(u,'https://api.anthropic.com/v1/messages')
              const body=JSON.parse(String(req?.body))
              return Response.json({model:body.model,stop_reason:'end_turn',usage:{input_tokens:300,output_tokens:30},content:[{type:'text',
                text:'LEAD 1 | fit: 5 | intent: 5 | action: 5 | signals: expansion | match: yyyy | why: evidence-backed fixture'}]})
            }))
          assert.ok(grade)
          const adapterScope={primary:db,scratch,execution,finding,signal}
          assert.equal(prepareCanonicalContact(adapterScope,grade,{...contact}),null,'copied contact is not proof')
          assert.equal(prepareCanonicalContact({...adapterScope,finding:{...finding}},grade,contact),null)
          const packet=prepareCanonicalContact(adapterScope,grade,contact)
          assert.ok(packet)
          assert.deepEqual(JSON.stringify(packet),'{}')
          assert.equal(prepareCanonicalContact(adapterScope,grade,contact),null,'cannot consume a settled grade twice')
          assert.equal(contactReads,4,'no contact read may run after the grade')
          const previousStage=process.env.DAZL_ENV,previousRelease=process.env.DAZL_COMMIT_SHA
          try {
            process.env.DAZL_ENV='production'
            process.env.DAZL_COMMIT_SHA=release
            assert.equal(stageCanonicalContactRow(packet,adapterScope),null)
            process.env.DAZL_ENV='staging'
            process.env.DAZL_COMMIT_SHA='a'.repeat(40)
            assert.equal(stageCanonicalContactRow(packet,adapterScope),null)
            process.env.DAZL_COMMIT_SHA=release
            assert.equal(stageCanonicalContactRow({...packet},adapterScope),null)
            assert.equal(stageCanonicalContactRow(packet,{...adapterScope,scratch:db}),null)
            assert.equal(stageCanonicalContactRow(packet,{...adapterScope,execution:{...execution}}),null)
            db.prepare("UPDATE organizations SET company_first_scorecard_enabled=0 WHERE id=?").run(tenantId)
            assert.equal(stageCanonicalContactRow(packet,adapterScope),null)
            db.prepare("UPDATE organizations SET company_first_scorecard_enabled=1 WHERE id=?").run(tenantId)
            const id=stageCanonicalContactRow(packet,adapterScope)
            assert.ok(id)
            assert.deepEqual(scratch.prepare(`SELECT scan_job_id,source_url,evidence_excerpt,event_date,event_date_proof,date_status,source_kind,fit
              FROM leads WHERE id=?`).get(id),{scan_job_id:fresh.jobId,source_url:url,evidence_excerpt:quote,event_date:day,
              event_date_proof:'page_bound',date_status:'unverified',source_kind:'query',fit:5})
            assert.equal(stageCanonicalSiteContact(packet,adapterScope,issued.site,{homepage,bio:{...bio}}),null)
            assert.equal(stageCanonicalSiteContact(packet,adapterScope,{...issued.site},{homepage,bio}),null)
            db.prepare("INSERT INTO suppressions(tenant_id,email,reason) VALUES(?,?,'manual')").run(tenantId,email)
            assert.equal(stageCanonicalSiteContact(packet,adapterScope,issued.site,{homepage,bio}),null)
            db.prepare("DELETE FROM suppressions WHERE tenant_id=? AND email=?").run(tenantId,email)
            assert.equal(scratch.prepare('SELECT company_domain FROM leads WHERE id=?').pluck().get(id),null)
            if(market.published==='candidate'){
              assert.equal(stageCanonicalSiteContact(packet,adapterScope,issued.site,{homepage:{...homepage},bio}),null)
              assert.equal(scratch.prepare('SELECT company_domain FROM leads WHERE id=?').pluck().get(id),null)
            }
            const persisted=stageCanonicalSiteContact(packet,adapterScope,issued.site,{homepage})
            assert.deepEqual(scratch.prepare(`SELECT value,source_url,retrieved_at,label FROM lead_enrichments WHERE kind='current_role'`).get(),
              {value:role,source_url:bioUrl,retrieved_at:Math.floor(roleProof.observedAtMs/1000),label:String(roleProof.observedAtMs)})
            assert.deepEqual(persisted,{published:market.published,currentRoute:market.route})
            assert.equal(stageCanonicalSiteContact(packet,adapterScope,issued.site,{homepage,bio}),null)
            assert.equal(scratch.prepare("SELECT COUNT(*) FROM lead_enrichments WHERE kind='email'").pluck().get(),market.published==='candidate'?1:0)
            assert.equal(db.prepare('SELECT COUNT(*) FROM email_candidates').pluck().get(),0)
            assert.equal(stageCanonicalContactRow(packet,adapterScope),null)
            assert.equal(scratch.prepare('SELECT status FROM scan_jobs WHERE id=?').pluck().get(fresh.jobId),'running')
            assert.equal(db.prepare('SELECT count(*) FROM leads').pluck().get(),0)
          } finally {
            if(previousStage===undefined)delete process.env.DAZL_ENV;else process.env.DAZL_ENV=previousStage
            if(previousRelease===undefined)delete process.env.DAZL_COMMIT_SHA;else process.env.DAZL_COMMIT_SHA=previousRelease
          }
          const fakeSite={} as Extract<WebsiteProof,{state:'verified'}>['site']
          const key={id:hex(123,24),revision:'fixture-current'}
          const missing=()=>assert.fail('must not ask stage owner without a canonical row')
          assert.equal(await verifyCanonicalContact(packet,{...adapterScope,execution:{...execution}},{query,icp,offer},key,fakeSite,missing),null)
          assert.equal(await verifyCanonicalContact(packet,adapterScope,{query,icp,offer},key,fakeSite,missing),null)
          assert.equal(await verifyCanonicalContact(packet,adapterScope,{query,icp,offer},key,fakeSite,missing),null)
          assert.equal(sends,1)
          assert.equal(scratch.prepare('SELECT COUNT(*) FROM leads').pluck().get(),1)
          assert.equal(db.prepare('SELECT COUNT(*) FROM leads').pluck().get(),0)
          } catch(e) { console.error(e); throw e }
        }),true)
        assert.equal(captured?.open,false)
        } catch(e) { console.error(e); throw e }
      },
    })
    assert.deepEqual(outcome,{route:'scorecard',status:'callback_returned'})
    assert.equal(calls,1)
    assert.equal(db.prepare('SELECT COUNT(*) FROM scan_spend_calls').pluck().get(),2)
    assert.equal(db.prepare('SELECT COUNT(*) FROM company_scorecard_calls').pluck().get(),2)
  }finally{db.close()}
})
