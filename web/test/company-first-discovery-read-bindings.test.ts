import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { verifyScorecardTicket, scorecardPinnedBudget, authorizeScorecardSubject } from '../lib/company-first/scorecard-admission.ts'
import { armProtectedScorecardJobSqlite } from '../lib/company-first/scorecard-producer.ts'
import { dispatchScorecardAware } from '../lib/company-first/scorecard-dispatch.ts'
import { bindReviewedDiscoveryReads } from '../lib/company-first/scorecard-discovery-read-bindings.ts'

test('reviewed discovery ports enforce live same ticket, settled call, exact read budget and reviewed literal role/place',async()=>{
  const db=new Database(':memory:')
  const hex=(n:number,length=64)=>n.toString(16).padStart(length,'0')
  const actorId='fixture-actor',tenantId='fixture-tenant',key=Buffer.alloc(32,11),release=hex(101,40),revision=hex(102)
  const cohort=hex(103),expiry=Date.now()+60_000,presets=Array.from({length:7},(_,i)=>hex(i+1))
  const query='Private synthetic fixture intent',icp='{"policy":"synthetic"}'
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
    db.prepare("INSERT INTO users (id,email,name,business_name,password_hash,salt) VALUES (?,?,'','','','')").run(actorId,'fixture@example.test')
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
        const {ticket}=execution
        const proof=authorizeScorecardSubject(ticket,{query,icp})!
        const scope={tenant:tenantId,job:fresh.jobId,attempt:'1'}
        const titles=['Account Director'], places=['Fixture Market']
        const policy={tenantId,actorId,jobId:fresh.jobId,nonce:ticket.nonce,release,workspaceRevision:revision,
          expiresAtMs:expiry-1000,source:'greenhouse_reciprocal' as const,roleKey:'role-key',placeKey:'place-key',
          literalTitles:titles,literalOnsitePlaces:places}
        assert.equal(bindReviewedDiscoveryReads(port,proof,execution,{...policy,nonce:old.ticket.nonce}),null)
        assert.equal(bindReviewedDiscoveryReads(port,proof,{...execution,ticket:{...ticket}},policy),null)
        const bindings=bindReviewedDiscoveryReads(port,proof,execution,policy)!
        assert.ok(bindings)
        assert.equal(bindReviewedDiscoveryReads(port,proof,execution,policy),null)
        assert.equal((await bindings.reciprocalOwner.readCurrentAuthorizedSource({tenant:tenantId,job:fresh.jobId,attempt:1,actor:actorId},signal))?.expiresAtMs,expiry-1000)
        const api='https://boards-api.greenhouse.io/v1/boards/fixture/jobs/123'
        const request={scope,exactUrl:api,signal,settledCallId:'fenced-call',step:'publisher' as const}
        assert.equal(await bindings.reciprocalOwner.reserveCurrentRead(request),false,'no settled lender')
        db.prepare("INSERT INTO scan_spend_calls(id,scan_job_id,user_id,attempt,status,reserve_usd,actual_usd,kind,settled_at) VALUES('fenced-call',?,?,1,'settled',1,0,'llm.anthropic.web_search',unixepoch())").run(fresh.jobId,tenantId)
        assert.equal(await bindings.reciprocalOwner.reserveCurrentRead(request),false,'unjoined raw ledger is not approval')
        db.prepare("INSERT INTO company_scorecard_calls VALUES('fenced-call',?,?,1)").run(tenantId,ticket.nonce)
        assert.equal(await bindings.reciprocalOwner.reserveCurrentRead({...request,scope:{...scope,attempt:'2'}}),false)
        assert.equal(await bindings.reciprocalOwner.reserveCurrentRead({...request,exactUrl:'https://wrong.example/v1/boards/fixture/jobs/123'}),false)
        const canonical={scope,exactUrl:api,signal,reviewVersion:'fenced-call'}
        assert.equal(await bindings.canonicalAts.reserveCurrentPublisherRead(canonical),false,'must go through reciprocal read first')
        const reserves=await Promise.all([bindings.reciprocalOwner.reserveCurrentRead(request),bindings.reciprocalOwner.reserveCurrentRead(request)])
        assert.deepEqual(reserves,[true,false])
        assert.equal(await bindings.canonicalAts.reserveCurrentPublisherRead({...canonical,exactUrl:api.replace('/123','/321')}),false)
        assert.equal(await bindings.canonicalAts.reserveCurrentPublisherRead(canonical),true)
        assert.equal(await bindings.canonicalAts.reserveCurrentPublisherRead(canonical),false)
        titles[0]='Wrong title';places[0]='Wrong place'
        assert.equal(bindings.canonicalAts.matchesRole('role-key','Account Director'),true)
        assert.equal(bindings.canonicalAts.matchesRole('wrong-key','Account Director'),false)
        assert.equal(bindings.canonicalAts.matchesPlace('place-key',{literal:'Fixture Market',workplace:'onsite'}),true)
        assert.equal(bindings.canonicalAts.matchesPlace('place-key',{literal:'Wrong place',workplace:'onsite'}),false)
        assert.equal(await bindings.publicRead.reserveCurrentRead({scope,signal,exactUrl:'https://company.example/robots.txt',step:'robots'}),true)
        for(let i=0;i<29;i++) assert.equal(await bindings.publicRead.reserveCurrentRead({scope,signal,exactUrl:`https://company.example/p/${i}`,step:'html'}),true)
        assert.equal(await bindings.publicRead.reserveCurrentRead({scope,signal,exactUrl:'https://company.example/overflow',step:'html'}),false)
        db.prepare("UPDATE organizations SET company_first_scorecard_enabled=0 WHERE id=?").run(tenantId)
        assert.equal(await bindings.publicRead.isCurrent(scope),false)
        assert.equal(await bindings.reciprocalOwner.reserveCurrentRead({...request,step:'homepage',exactUrl:'https://company.example/'}),false)
      },
    })
    assert.equal(calls,1)
    assert.equal(outcome.route,'scorecard')
  }finally{db.close()}
})
