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
import {runWithScanSpend,scanCapConfig,modelCostUsd} from '../lib/scan/spend-cap.ts'
import { gradeCanonicalVerifiedDrafts, isCurrentCanonicalGrading, isFinalCanonicalGrading, takeCanonicalGradedDraft } from '../lib/company-first/company-first-protected-grading.ts'

for (const mode of ['settled','wrong-model','unknown-usage','revoked','over-budget','buyer-fit','buyer-fit-fabricated','buyer-fit-unknown','buyer-fit-challenge','buyer-fit-cross-origin'] as const) test('protected batch grading: '+mode,async()=>{
  const db=new Database(':memory:')
  const hex=(n:number,length=64)=>n.toString(16).padStart(length,'0')
  const actorId='fixture-actor',tenantId='fixture-tenant',key=Buffer.alloc(32,11),release=hex(101,40),revision=hex(102)
  const cohort=hex(103),expiry=Date.now()+60_000,presets=Array.from({length:7},(_,i)=>hex(i+1))
  const query='Find firms opening offices in Oslo',icp=JSON.stringify({summary:'Oslo businesses',where:['Oslo']})
  const offer='Fixture business support'
  const reviewed={query,icp,offer}
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
    assert.deepEqual(armProtectedScorecardJobSqlite(db,old.ticket,reviewed),{ok:true,jobId:old.jobId})
    // Prior lane complete is fixture setup; no baseline transport.
    db.prepare("UPDATE company_scorecard_claims SET status='complete' WHERE job_id=?").run(old.jobId)
    db.prepare("UPDATE scan_jobs SET status='done',claimed_at=NULL,finished_at=unixepoch() WHERE id=?").run(old.jobId)
    assert.deepEqual(armProtectedScorecardJobSqlite(db,fresh.ticket,reviewed),{ok:true,jobId:fresh.jobId})
    const port=sqliteDb(db)
    let calls=0
    const outcome=await dispatchScorecardAware(port,{id:fresh.jobId,user_id:tenantId,attempts:1},async()=>{assert.fail('no legacy')},{
      release,materialFor:async()=>fresh,
      async runPrivate(execution){try {
        calls++
        let captured:Database.Database|undefined
        const expected={tenantId,actorId,jobId:fresh.jobId,release,attempt:1 as const}
        assert.equal(await withNewDiscoveryScratch(db,expected,old.signedToken,key,reviewed,()=>assert.fail('old ticket')),false)
        assert.equal(await withNewDiscoveryScratch(db,expected,fresh.signedToken,key,{query:'wrong private input',icp},()=>assert.fail('wrong scope')),false)
        assert.equal(await withNewDiscoveryScratch(db,expected,fresh.signedToken,key,reviewed,async privateRun=>{ try {
          const scratch=captured=privateRun.db
          assert.equal(scratch.open,true)
          assert.throws(()=>scratch.prepare('SELECT * FROM tenant_llm_keys'),/no such table/)
          assert.throws(()=>scratch.prepare('SELECT * FROM scan_spend_calls'),/no such table/)
          const scope={tenant:tenantId,job:fresh.jobId,attempt:'1'}
          const cases=['Fixture Harbor','Fixture Ridge'].map((name,i)=>({name,site:`https://fixture-${i}.example`,key:`fixture-key-${i}`}))
          const day=new Date().toISOString().slice(0,10)
          const quoteFor=(name:string)=>name.endsWith('Ridge') ? `${name} is hiring a manager in Oslo on ${day}. Responsibilities include outreach.` : `${name} opened its second office in Oslo on ${day}.`
          const report=await runCompanyFirst({enabled:true},scope,{category:'office firms',place:'oslo',event:'expansion',from:day,through:day},{
            reserveBeforeDispatch:async()=>true,isCurrent:async()=>true,discover:async()=>cases.map(c=>({name:c.name,hintUrl:c.site+'/news'})),
            verifyWebsite:async ({input:candidate})=>{
              const c=cases.find(row=>row.name===candidate.name)!
              return {status:'verified',companyKey:c.key,candidateName:c.name,website:c.site,identitySource:c.site+'/news'}
            },
            verifyDatedSignal:async ({input:website})=>{
              const c=cases.find(row=>row.key===website.companyKey)!, url=c.site+'/news', quote=quoteFor(c.name)
              return {companyKey:c.key,place:'oslo',event:'expansion',date:day,sourceUrl:url,
                quote,literalSourceText:quote,dateProof:{kind:'first_party_event_date',sourceUrl:url,day,literalDate:day}}
            },
          })
          assert.equal(report.findings[0]?.state,'signal_verified')
          const read=async (_:unknown,u:string)=>{ const c=cases.find(row=>row.site+'/news'===u)!; return {requestedUrl:u,finalUrl:u,complete:true as const,page:{text:quoteFor(c.name),title:c.name,retrievedAt:1}} }
          assert.deepEqual(await preverifyCompanyFirstDiscovery(db,scratch,execution,report.findings,read,signal),{state:'held'})
          db.prepare(`INSERT INTO scan_spend_calls(id,user_id,scan_job_id,attempt,kind,reserve_usd,actual_usd,status,created_at,settled_at)
            VALUES('fixture-paid-1',?,?,1,'llm.anthropic.web_search',.22,.125,'settled',unixepoch(),unixepoch())`).run(tenantId,fresh.jobId)
          db.prepare("INSERT INTO company_scorecard_calls(reservation_id,tenant_id,nonce,lane) VALUES('fixture-paid-1',?,?,1)").run(tenantId,fresh.ticket.nonce)
          assert.deepEqual(await preverifyCompanyFirstDiscovery(db,scratch,execution,report.findings.map(f=>({...f})),read,signal),{state:'held'})
          const findings=report.findings.filter(f=>f.state==='signal_verified')
          assert.equal(findings.length,2)
          const fitMode=mode.startsWith('buyer-fit')
          const fitSend=fitMode && mode!=='buyer-fit-challenge' && mode!=='buyer-fit-cross-origin'
          const fitQuote='Fixture Ridge runs a network of regional communications offices'
          const rawHomepage=fitQuote+'. Learn more about our company services and organizational history today.'
          const items=await Promise.all(findings.map(async finding=>{
            const verification=await verifySingleCanonicalDraft(db,scratch,execution,finding,read,signal)
            assert.ok(verification)
            const root=new URL('/',finding.site.website).href
            return {finding,verification,homepage:fitMode&&finding.name.endsWith('Ridge') ? {
              url:root,finalUrl:mode==='buyer-fit-cross-origin'?'https://unrelated.example/':root, contentType:'text/html' as const,
              visibleText:mode==='buyer-fit-challenge'?'Access denied. Verify you are human. '+rawHomepage:rawHomepage,jsonLd:[],
            } : null}
          }))
          const model='claude-sonnet-4-5-20250929'
          let sends=0,callId:string|undefined,fitCallId:string|undefined
          const rows=()=>db.prepare(`SELECT s.id,s.kind,s.status,s.reserve_usd,s.actual_usd,s.settled_at,
            b.nonce,b.lane,s.attempt FROM scan_spend_calls s
            JOIN company_scorecard_calls b ON b.reservation_id=s.id AND b.tenant_id=s.user_id
            WHERE s.user_id=? AND s.scan_job_id=? AND s.attempt=1 ORDER BY s.created_at,s.id`).all(tenantId,fresh.jobId) as
            {id:string;kind:string;status:string;reserve_usd:number;actual_usd:number|null;settled_at:number|null;nonce:string;lane:number;attempt:number}[]
          const before=rows()
          const fixtureWire:typeof fetch=async(u,req)=>{
            sends++; assert.equal(u,'https://api.anthropic.com/v1/messages'); assert.equal(req?.redirect,'error')
            const body=JSON.parse(String(req?.body))
            assert.equal(body.model,model); assert.equal(body.messages.length,1)
            if (sends===2) {
              assert.equal(fitSend,true)
              assert.equal(body.max_tokens,600)
              const text=body.messages[0].content as string
              assert.ok(text.includes(rawHomepage) && text.includes(offer) && text.includes(query))
              assert.ok(!text.includes('Fixture Harbor'))
              const all=rows(); assert.equal(all.length,3)
              assert.equal(all.find(r=>r.id===callId)?.status,'settled')
              const fit=all.find(r=>r.kind==='llm.anthropic'&&r.id!==callId)
              assert.ok(fit); assert.equal(fit.status,'reserved'); assert.equal(fit.reserve_usd,modelCostUsd(model,text,600))
              fitCallId=fit.id
              return Response.json({model,stop_reason:'end_turn',usage:mode==='buyer-fit-unknown'?{}:{input_tokens:200,output_tokens:20},
                content:[{type:'text',text:'COMPANY 2 | fit yes | quote '+(mode==='buyer-fit-fabricated'?'We sell a product this company does not offer':fitQuote)}]})
            }
            assert.equal(sends,1);assert.equal(body.max_tokens,2500)
            const prompt=body.messages[0].content as string
            for (const c of cases) assert.ok(prompt.includes(quoteFor(c.name)))
            assert.ok(prompt.includes(query)); assert.ok(prompt.includes(offer))
            assert.equal(rows().length,2)
            assert.deepEqual(rows().filter(r=>r.kind==='llm.anthropic.web_search'),before)
            const row=rows().find(r=>r.kind==='llm.anthropic')
            assert.ok(row); assert.equal(row.status,'reserved'); assert.equal(row.reserve_usd,modelCostUsd(model,prompt,2500))
            assert.equal(row.nonce,execution.ticket.nonce); assert.equal(row.lane,1); assert.equal(row.attempt,1)
            callId=row.id
            if (mode==='revoked') db.prepare('UPDATE organizations SET company_first_scorecard_enabled=0 WHERE id=?').run(tenantId)
            return Response.json({model:mode==='wrong-model'?'claude-sonnet-4-5':model,stop_reason:'end_turn',
              usage:mode==='unknown-usage'?{}:{input_tokens:300,output_tokens:30},content:[{type:'text',text:
                'LEAD 1 | fit: 5 | intent: 5 | action: 5 | signals: expansion | match: yyyn | why: evidence-backed fixture\n'+
                'LEAD 2 | fit: 5 | intent: 5 | action: 5 | signals: expansion | match: yyyy | why: evidence-backed fixture'}]})
          }
          const perform=()=>gradeCanonicalVerifiedDrafts(db,scratch,execution,items,'fixture-local-never-sent',signal,fixtureWire)
          assert.equal(await perform(),null,'unbound phase must not dispatch')
          const grades=await runWithScanSpend({db,jobId:fresh.jobId,tenantId,attempt:1,cap:scanCapConfig({}),
            requestMaxUsd:mode==='over-budget'?.001:2,accountLimits:{day:2,month:5},claudeOnly:true,
            scorecard:{ticket:execution.ticket,lane:'new'}},perform)
          assert.equal(sends,mode==='over-budget'?0:fitSend?2:1)
          if (mode!=='settled' && (!fitMode || mode==='buyer-fit-unknown')) {
            assert.equal(grades,null)
            return
          }
          assert.ok(grades); assert.equal(grades.length,2); assert.equal(JSON.stringify(grades),'[{},{}]')
          const completion=rows().find(r=>r.id===callId)
          assert.ok(completion); assert.equal(completion.status,'settled'); assert.equal(completion.actual_usd,.00135);assert.ok(completion.settled_at)
          assert.ok(isCurrentCanonicalGrading(grades[0],db,scratch,execution,findings[0]))
          assert.equal(takeCanonicalGradedDraft(grades[0],db,scratch,execution,findings[1]),null)
          const first=takeCanonicalGradedDraft(grades[0],db,scratch,execution,findings[0])
          assert.ok(first); assert.equal(first.draft.fit,1); assert.equal(first.reservationId,callId); assert.equal(first.actualUsd,.00135)
          assert.equal(takeCanonicalGradedDraft(grades[0],db,scratch,execution,findings[0]),null)
          assert.ok(isCurrentCanonicalGrading(grades[0],db,scratch,execution,findings[0]))
          const second=takeCanonicalGradedDraft(grades[1],db,scratch,execution,findings[1])
          assert.ok(second); assert.equal(second.reservationId,callId); assert.equal(second.evidenceGated,true)
          assert.ok((second.draft.intent??9)<=1)
          assert.equal(first.buyerFit,'not_required')
          assert.equal(second.buyerFit,mode==='buyer-fit'?'confirmed':'held')
          assert.equal(second.draft.fit,mode==='buyer-fit'?5:3)
          if (fitSend) {
            assert.equal(second.buyerFitReservationId,fitCallId)
            assert.equal(rows().find(r=>r.id===fitCallId)?.actual_usd,.0009)
          } else assert.equal(second.buyerFitReservationId,null)
          assert.deepEqual(await preverifyCompanyFirstDiscovery(db,scratch,execution,report.findings,
            async()=>assert.fail('post-grade must not read discovery again'),signal),{state:'held'})
          assert.equal(isFinalCanonicalGrading(grades[0],db,scratch,execution,findings[0]),false)
          scratch.prepare("UPDATE scan_jobs SET status='done', claimed_at=NULL, finished_at=unixepoch() WHERE id=?").run(fresh.jobId)
          assert.equal(isCurrentCanonicalGrading(grades[0],db,scratch,execution,findings[0]),false)
          assert.equal(isFinalCanonicalGrading(grades[0],db,scratch,execution,findings[0]),true)
          assert.equal(takeCanonicalGradedDraft(grades[0],db,scratch,execution,findings[0]),null)
          db.prepare('UPDATE scan_spend_calls SET actual_usd=0 WHERE id=?').run(fitCallId??callId)
          assert.equal(isFinalCanonicalGrading(grades[0],db,scratch,execution,findings[0]),false)
          assert.equal(scratch.prepare('SELECT COUNT(*) FROM leads').pluck().get(),0)
          assert.equal(db.prepare('SELECT COUNT(*) FROM leads').pluck().get(),0)
          } catch(e) { console.error(e); throw e }
        }),mode!=='revoked')
        assert.equal(captured?.open,false)
        } catch(e) { console.error(e); throw e }
      },
    })
    assert.deepEqual(outcome,{route:'scorecard',status:'callback_returned'})
    assert.equal(calls,1)
    const twoPaid=mode==='buyer-fit'||mode==='buyer-fit-fabricated'||mode==='buyer-fit-unknown'
    assert.equal(db.prepare('SELECT COUNT(*) FROM scan_spend_calls').pluck().get(),twoPaid?3:2)
    assert.equal(db.prepare('SELECT COUNT(*) FROM company_scorecard_calls').pluck().get(),mode==='over-budget'?1:twoPaid?3:2)
  }finally{db.close()}
})
