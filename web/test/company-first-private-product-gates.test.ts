import { provisionPrivatePolicyContext, privatePolicyContextCurrent } from '../lib/company-first/company-first-private-policy-context.ts'
import { loadPlayDemandRubric } from '../lib/scan/demand-rubric-play.ts'
import { saveMemory } from '../lib/memory.ts'
import { setCompetitors } from '../lib/signals/competitor-reddit.ts'
import { runPrivateCompanyFirstProductGates } from '../lib/company-first/company-first-private-product-gates.ts'
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
import {preverifyCompanyFirstDiscovery,verifySingleCanonicalDraft,readCanonicalVerifiedDraftFacts} from '../lib/company-first/company-first-canonical-discovery.ts'
import {withNewDiscoveryScratch} from '../lib/company-first/scorecard-evidence-scratch.ts'
import {runWithScanSpend,scanCapConfig} from '../lib/scan/spend-cap.ts'
import {gradeCanonicalVerifiedDraft} from '../lib/company-first/company-first-protected-grading.ts'
import {proveCompanyFirstContact, isIssuedCompanyFirstContact} from '../lib/company-first/company-first-contact-proof.ts'
import {prepareCanonicalContact,stageCanonicalContactRow,verifyCanonicalContact} from '../lib/company-first/company-first-final-proof-adapter.ts'
import type {WebsiteProof} from '../lib/company-first/company-first-website-proof.ts'

test('private protected product gates accept genuine bound input but hold missing identity or fabricated proof',async()=>{
  const db=new Database(':memory:')
  const hex=(n:number,length=64)=>n.toString(16).padStart(length,'0')
  const actorId='fixture-actor',tenantId='fixture-tenant',key=Buffer.alloc(32,11),release=hex(101,40),revision=hex(102)
  const cohort=hex(103),expiry=Date.now()+60_000,presets=Array.from({length:7},(_,i)=>hex(i+1))
  const offer='Office communications services for growing businesses',query='Find firms opening offices in Oslo',icp=JSON.stringify({summary:'Oslo businesses',where:['Oslo']})
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
          const day=new Date().toISOString().slice(0,10), quote=`${name} opened its second office in Oslo on ${day}.`
          const report=await runCompanyFirst({enabled:true},scope,{category:'office firms',place:'oslo',event:'expansion',from:day,through:day},{
            reserveBeforeDispatch:async()=>true,isCurrent:async()=>true,discover:async()=>[{name,hintUrl:url}],
            verifyWebsite:async()=>({status:'verified',companyKey:'fixture-legal-key',candidateName:name,website:site,identitySource:url}),
            verifyDatedSignal:async()=>({companyKey:'fixture-legal-key',place:'oslo',event:'expansion',date:day,sourceUrl:url,
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
          const facts=readCanonicalVerifiedDraftFacts(receipt,scratch,execution,finding)
          assert.ok(facts)
          // Directory, own bio and independently observed profile fixtures are
          // consumed from the real product contact function before grading.
          const buyer='Robin Example',role='Founder',bioUrl=site+'/team/robin',directory=site+'/team'
          const linkedIn='https://www.linkedin.com/in/example-fixture'
          const email='robin.example@fixtureharbor.example',literalLine='Work email: '+email
          let contactReads=0
          const contact=await proveCompanyFirstContact(finding,[role],scope,{
            isCurrent:async(s,f)=>s.job===scope.job&&f===finding,
            reserveBeforeDispatch:async()=>true,
            readDirectory:async()=>{contactReads++;return {url:directory,navigation:{sourceUrl:url,linkedUrl:directory},people:[{name:buyer,title:role,bioUrl}]}},
            readBio:async()=>{contactReads++;return {url:bioUrl,company:name,name:buyer,title:role,text:[buyer,role,literalLine].join('\n'),
              profiles:[{named:buyer,url:linkedIn}],publications:[{named:buyer,address:email,literalLine}]}},
            corroborateProfile:async()=>{contactReads++;return {url:linkedIn,company:name,name:buyer,title:role,current:true}},
          },signal)
          assert.equal(contact.status,'contact_proof')
          if(contact.status!=='contact_proof')assert.fail('expected genuine contact proof')
          assert.equal(isIssuedCompanyFirstContact({...contact},scope,finding),false)
          assert.equal(isIssuedCompanyFirstContact(contact,scope,{...finding}),false)
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
          assert.equal(contactReads,3,'no contact read may run after the grade')
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
            const runGates=(staged=[{id,finding,facts}])=>runPrivateCompanyFirstProductGates(db,scratch,execution,{query,icp,offer},staged,signal)
            assert.deepEqual(await runGates([{id,finding:{...finding},facts}]),{state:'held',reason:'source_binding_unavailable'})
            assert.deepEqual(await runGates([{id,finding,facts:{...facts}}]),{state:'held',reason:'source_binding_unavailable'})
            assert.deepEqual(await runGates(),{state:'checked',admitted:1,salesProofHeld:0,rubricAvailable:false,actionable:0,timingProven:0,held:1,qualifiedIds:[]})
            // The opaque primary anchor must not expose the private arm's
            // offer. The same signed subject DOES populate scratch's exact
            // reviewed offer; the product rubric consumes that row.
            assert.equal(db.prepare('SELECT offer FROM scan_jobs WHERE id=?').pluck().get(fresh.jobId),null)
            assert.equal(scratch.prepare('SELECT offer FROM scan_jobs WHERE id=?').pluck().get(fresh.jobId),offer)
            db.prepare(`INSERT INTO users(id,email,business_name,website,password_hash,salt,email_verified_at)
              VALUES(?,?,?,?,'','',1)`).run(tenantId,'policy-fixture@example.test','Fixture Seller','https://seller.example')
            saveMemory(db,tenantId,{exclusions:['Unrelated Excluded Supplier']})
            await setCompetitors(sqliteDb(db),tenantId,['Fixture Rival'])
            const policy=await provisionPrivatePolicyContext(db,scratch,execution,{query,icp,offer},signal)
            assert.ok(policy,'authorize the private policy projection for this exact offer')
            const rubric=await loadPlayDemandRubric(sqliteDb(scratch),'private-scratch',fresh.jobId)
            assert.ok(rubric.rubric,'normal canonical loader sees the reviewed private offer')
            assert.deepEqual(await runGates(),{state:'checked',admitted:1,salesProofHeld:0,rubricAvailable:true,
              actionable:0,timingProven:0,held:1,qualifiedIds:[]})
            assert.equal(await privatePolicyContextCurrent(policy,db,scratch,execution,{query,icp,offer},signal),true)
            const dbRow=scratch.prepare('SELECT status FROM scan_jobs WHERE id=?').pluck().get(fresh.jobId)
            assert.equal(dbRow,'running')
            db.prepare("UPDATE organizations SET company_first_scorecard_enabled=0 WHERE id=?").run(tenantId)
            assert.deepEqual(await runGates(),{state:'held',reason:'authority_unavailable'})
            db.prepare("UPDATE organizations SET company_first_scorecard_enabled=1 WHERE id=?").run(tenantId)
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
