import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { verifyScorecardTicket, scorecardPinnedBudget } from '../lib/company-first/scorecard-admission.ts'
import { armProtectedScorecardJobSqlite } from '../lib/company-first/scorecard-producer.ts'
import { dispatchScorecardAware } from '../lib/company-first/scorecard-dispatch.ts'
import { runProtectedCompanyFirstCandidate } from '../lib/company-first/company-first-protected-candidate.ts'
import { runWithScanSpend, scanCapConfig } from '../lib/scan/spend-cap.ts'

test('protected current ticket refuses unbound independent/canonical proof before discovery, reads or a spend row',async()=>{
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
  const syntheticPort=async()=>{assert.fail('unbound run must never invoke upstream ports')}
  const independentOwner={
    readCurrentAuthorizedSource:syntheticPort,readIndependentRecords:syntheticPort,readOwnedIdentityBlocks:()=>{assert.fail('unbound reader')},authorizeAndReserve:syntheticPort,
  }
  const canonical={readCurrentProtectedSession:syntheticPort,reviewedSubject:{query,icp},readStages:()=>null,finishStagedCandidates:syntheticPort}
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
        assert.deepEqual(await runProtectedCompanyFirstCandidate(execution,null,signal),{state:'held',reason:'not_authorized'})
        await runWithScanSpend({db:port,jobId:fresh.jobId,tenantId,attempt:1,cap:scanCapConfig({}),
          accountLimits:{day:2,month:5},claudeOnly:true,scorecard:{ticket:execution.ticket,lane:'new'}},async()=>{
          assert.deepEqual(await runProtectedCompanyFirstCandidate(execution,{canonical,readReviewedPublicDiscovery:syntheticPort},signal),
            {state:'held',reason:'independent_authority_unbound'})
          assert.deepEqual(await runProtectedCompanyFirstCandidate(execution,{independentOwner,readReviewedPublicDiscovery:syntheticPort},signal),
            {state:'held',reason:'canonical_proof_unbound'})
          assert.deepEqual(await runProtectedCompanyFirstCandidate(execution,{independentOwner,canonical},signal),
            {state:'held',reason:'protected_ports_unbound'})
          const completePorts = {
            readReviewedPublicDiscovery:syntheticPort,verifyDatedSignal:syntheticPort,
            publicRead:{reserveCurrentRead:syntheticPort,isCurrent:syntheticPort},
            contact:{isCurrent:syntheticPort,reserveBeforeDispatch:syntheticPort,readDirectory:syntheticPort,
              readBio:syntheticPort,corroborateProfile:syntheticPort},
          }
          const authoritativeScope = { scope:{tenant:tenantId,job:fresh.jobId,attempt:'1'},workspaceRevision:revision,expiresAtMs:expiry,lane:'new' as const }
          const noOwner={...independentOwner,readCurrentAuthorizedSource:async()=>null}
          assert.deepEqual(await runProtectedCompanyFirstCandidate(execution,{...completePorts,independentOwner:noOwner,canonical},signal),
            {state:'held',reason:'independent_authority_unbound'})
          const presentOwner={...independentOwner,readCurrentAuthorizedSource:async()=>authoritativeScope}
          const staleCanonical={...canonical,readCurrentProtectedSession:async()=>({...authoritativeScope,expiresAtMs:0})}
          assert.deepEqual(await runProtectedCompanyFirstCandidate(execution,{...completePorts,independentOwner:presentOwner,canonical:staleCanonical},signal),
            {state:'held',reason:'canonical_proof_unbound'})
          const spoof={...execution,ticket:{...execution.ticket}}
          assert.deepEqual(await runProtectedCompanyFirstCandidate(spoof,{independentOwner,canonical},signal),
            {state:'held',reason:'not_authorized'})
          db.prepare("UPDATE organizations SET company_first_scorecard_enabled=0 WHERE id=?").run(tenantId)
          assert.deepEqual(await runProtectedCompanyFirstCandidate(execution,{independentOwner,canonical},signal),
            {state:'held',reason:'not_authorized'})
        })
      },
    })
    assert.deepEqual(outcome,{route:'scorecard',status:'callback_returned'})
    assert.equal(calls,1)
    assert.equal(db.prepare('SELECT COUNT(*) FROM scan_spend_calls').pluck().get(),0)
    assert.equal(db.prepare('SELECT COUNT(*) FROM company_scorecard_calls').pluck().get(),0)
  }finally{db.close()}
})
