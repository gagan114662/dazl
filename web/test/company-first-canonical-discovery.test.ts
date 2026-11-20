import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { verifyScorecardTicket, scorecardPinnedBudget } from '../lib/company-first/scorecard-admission.ts'
import { armProtectedScorecardJobSqlite } from '../lib/company-first/scorecard-producer.ts'
import { dispatchScorecardAware } from '../lib/company-first/scorecard-dispatch.ts'
import {createCanonicalAtsSignal} from '../lib/company-first/company-first-canonical-ats-signal.ts'
import {runCompanyFirst} from '../lib/company-first/company-first-evidence.ts'
import {preverifyCompanyFirstDiscovery} from '../lib/company-first/company-first-canonical-discovery.ts'
import {recordFeedback} from '../lib/scan/feedback.ts'
import {withNewDiscoveryScratch} from '../lib/company-first/scorecard-evidence-scratch.ts'
import {createQueryJob} from '../lib/scan/store.ts'

test('only authentic own or exact bound ATS discovery reaches canonical verification without persistence',async()=>{
  const db=new Database(':memory:')
  const hex=(n:number,length=64)=>n.toString(16).padStart(length,'0')
  const actorId='fixture-actor',tenantId='fixture-tenant',key=Buffer.alloc(32,11),release=hex(101,40),revision=hex(102)
  const cohort=hex(103),expiry=Date.now()+60_000,presets=Array.from({length:7},(_,i)=>hex(i+1))
  const query='Find firms opening offices in Oslo',icp=JSON.stringify({summary:'Oslo businesses',where:['Oslo']})
  function auth(lane:'old'|'new'){
    const jobId=hex(lane==='old'?104:105,24),nonce=hex(lane==='old'?106:107)
    const h=(data:string)=>createHmac('sha256',key).update(data).digest('hex')
    const mac=h(JSON.stringify(['legacy-observation-v1',actorId,tenantId,jobId,1,Math.floor(expiry/1000),
      query,icp,null,null,null,scorecardPinnedBudget()]))
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
    assert.deepEqual(armProtectedScorecardJobSqlite(db,old.ticket,{query,icp}),{ok:true,jobId:old.jobId})
    // Prior lane complete is fixture setup; no baseline transport.
    db.prepare("UPDATE company_scorecard_claims SET status='complete' WHERE job_id=?").run(old.jobId)
    db.prepare("UPDATE scan_jobs SET status='done',claimed_at=NULL,finished_at=unixepoch() WHERE id=?").run(old.jobId)
    assert.deepEqual(armProtectedScorecardJobSqlite(db,fresh.ticket,{query,icp}),{ok:true,jobId:fresh.jobId})
    const port=sqliteDb(db)
    let calls=0
    const outcome=await dispatchScorecardAware(port,{id:fresh.jobId,user_id:tenantId,attempts:1},async()=>{assert.fail('no legacy')},{
      release,materialFor:async()=>fresh,
      async runPrivate(execution){
        calls++
        let captured:Database.Database|undefined
        const expected={tenantId,actorId,jobId:fresh.jobId,release,attempt:1 as const}
        assert.equal(await withNewDiscoveryScratch(db,expected,old.signedToken,key,{query,icp},()=>assert.fail('old ticket')),false)
        assert.equal(await withNewDiscoveryScratch(db,expected,fresh.signedToken,key,{query:'wrong private input',icp},()=>assert.fail('wrong scope')),false)
        assert.equal(await withNewDiscoveryScratch(db,expected,fresh.signedToken,key,{query,icp},async privateRun=>{
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
          const before=db.prepare('SELECT total_changes()').pluck().get()
          assert.deepEqual(await preverifyCompanyFirstDiscovery(db,scratch,execution,report.findings.map(f=>({...f})),read,signal),{state:'held'})
          const measured=await preverifyCompanyFirstDiscovery(db,scratch,execution,report.findings,read,signal)
          assert.equal(measured.state,'preverified')
          if(measured.state==='preverified'){
            assert.equal(measured.literalVerifierPassed,1)
            assert.equal(measured.verifiedPlace,1);assert.equal(measured.canonicalReady,null)
          }
          const changed=await preverifyCompanyFirstDiscovery(db,scratch,execution,report.findings,async(s,u)=>{
            const p=await read(s,u);return {...p,page:{...p.page,text:quote.replace('Oslo','Paris')}}
          },signal)
          assert.equal(changed.state,'preverified')
          if(changed.state==='preverified'){assert.equal(changed.literalVerifierPassed,0);assert.equal(changed.verifiedPlace,0)}
          assert.equal(scratch.prepare('SELECT COUNT(*) FROM leads').pluck().get(),0)
          assert.equal(db.prepare('SELECT total_changes()').pluck().get(),before)
          assert.equal(db.prepare('SELECT COUNT(*) FROM leads').pluck().get(),0)
          // Real canonical Greenhouse stage yields a one-attempt Page lease from its
          // guarded response. The downstream verifier consumes only that object.
          const posting='https://job-boards.greenhouse.io/fixture/jobs/111'
          const api='https://boards-api.greenhouse.io/v1/boards/fixture/jobs/111'
          const expires=Date.now()+30_000, title='Technical Account Executive'
          let stable=true,physicalReads=0
          const stage=createCanonicalAtsSignal(scope,{
            approvedRoleKey:'account-executive',
            readCurrentOwnedLink:async()=>stable?{scope,companyKey:'fixture-legal-key',companyName:name,websiteOrigin:site,version:'current-site-1',
              expiresAtMs:expires,kind:'observed_owned_link',literalPostingHref:posting,linkSource:site+'/careers'}:null,
            reserveCurrentPublisherRead:async r=>r.exactUrl===api,
            matchesRole:(k,t)=>k==='account-executive'&&t===title,
            matchesPlace:(k,p)=>k==='oslo'&&p.literal==='Oslo',
          },async u=>{ physicalReads++;assert.equal(u,api);return {status:200,complete:true,finalUrl:api,contentEncoding:'identity',
            contentType:'application/json',body:JSON.stringify({id:111,company_name:name,title,first_published:day+'T00:00:00Z',location:{name:'Oslo'}})} })
          const ats=await runCompanyFirst({enabled:true},scope,{category:'office firms',place:'oslo',event:'hiring_posting',from:day,through:day},{
            reserveBeforeDispatch:async()=>true,isCurrent:async()=>true,discover:async()=>[{name,hintUrl:url}],
            verifyWebsite:async()=>({status:'verified',companyKey:'fixture-legal-key',candidateName:name,website:site,identitySource:url,
              posting:{linkSource:site+'/careers',postingUrl:posting}}),verifyDatedSignal:stage,
          })
          assert.equal(ats.findings[0]?.state,'signal_verified')
          const never=async()=>assert.fail('ATS must never become a generic page/fallback request')
          const atsResult=await preverifyCompanyFirstDiscovery(db,scratch,execution,ats.findings,never,signal)
          assert.equal(atsResult.state,'preverified')
          if(atsResult.state==='preverified'){assert.equal(atsResult.literalVerifierPassed,1);assert.equal(atsResult.canonicalDated,1);assert.equal(atsResult.verifiedPlace,1);assert.equal(atsResult.canonicalReady,null)}
          stable=false
          const revoked=await preverifyCompanyFirstDiscovery(db,scratch,execution,ats.findings,never,signal)
          assert.equal(revoked.state,'preverified')
          if(revoked.state==='preverified'){assert.equal(revoked.literalVerifierPassed,0);assert.equal(revoked.unavailableExactSources,1)}
          assert.equal(physicalReads,1,'canonical read rechecks ownership without another transport')
          // Negative control: a real existing feedback gate—not a supplied
          // outcome boolean—blocks this business before the guarded reread.
          const history=createQueryJob(db,tenantId,{query:'fixture history'})
          db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(history)
          db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url) VALUES('fixture-rejected',?,?,?,?)").run(history,name,quote,url)
          await recordFeedback(port,tenantId,'fixture-rejected',{verdict:'reject',reason:'not_useful'})
          const rejected=await preverifyCompanyFirstDiscovery(db,scratch,execution,report.findings,async()=>assert.fail('feedback must prevent reread'),signal)
          assert.equal(rejected.state,'preverified')
          if(rejected.state==='preverified'){assert.equal(rejected.feedbackHeld,1);assert.equal(rejected.literalVerifierPassed,0)}

        }),true)
        assert.equal(captured?.open,false)
      },
    })
    assert.deepEqual(outcome,{route:'scorecard',status:'callback_returned'})
    assert.equal(calls,1)
    assert.equal(db.prepare('SELECT COUNT(*) FROM scan_spend_calls').pluck().get(),1)
    assert.equal(db.prepare('SELECT COUNT(*) FROM company_scorecard_calls').pluck().get(),1)
  }finally{db.close()}
})
