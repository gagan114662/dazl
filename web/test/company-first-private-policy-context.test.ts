import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { saveMemory, getMemory, isExcluded } from '../lib/memory.ts'
import { readCompetitorsStrict, setCompetitors } from '../lib/signals/competitor-reddit.ts'
import { loadPlayDemandRubric } from '../lib/scan/demand-rubric-play.ts'
import { scorecardPinnedBudget, verifyScorecardTicket } from '../lib/company-first/scorecard-admission.ts'
import { armProtectedScorecardJobSqlite } from '../lib/company-first/scorecard-producer.ts'
import { dispatchScorecardAware } from '../lib/company-first/scorecard-dispatch.ts'
import { withNewDiscoveryScratch } from '../lib/company-first/scorecard-evidence-scratch.ts'
import { provisionPrivatePolicyContext, privatePolicyContextCurrent } from '../lib/company-first/company-first-private-policy-context.ts'

test('authenticated private scratch receives only current canonical seller/exclusion data and refuses stale proof',async()=>{
  const db=new Database(':memory:')
  const origStage=process.env.DAZL_ENV, origRelease=process.env.DAZL_COMMIT_SHA
  const hex=(n:number,w=64)=>n.toString(16).padStart(w,'0')
  // A workspace with the same-id canonical seller record: don't fall back to
  // another owner's personal business for a workspace missing this record.
  const tenantId='policy-tenant',actorId='policy-owner',revision=hex(1),release=hex(2,40),cohort=hex(3),secret=Buffer.alloc(32,8)
  const expiresAt=Date.now()+60_000,presets=Array.from({length:7},(_,i)=>hex(20+i))
  const query='Find firms opening offices in Oslo',icp=JSON.stringify({summary:'Oslo firms',where:['Oslo']}),offer='Office telephone installation services for workplaces'
  const reviewed={query,icp,offer}
  function issue(lane:'old'|'new'){
    const jobId=hex(lane==='old'?10:11,24),nonce=hex(lane==='old'?12:13)
    const h=(s:string)=>createHmac('sha256',secret).update(s).digest('hex')
    const subject=h(JSON.stringify(['legacy-observation-v1',actorId,tenantId,jobId,1,Math.floor(expiresAt/1000),query,icp,offer,null,null,scorecardPinnedBudget()]))
    const payload=Buffer.from(JSON.stringify([tenantId,actorId,jobId,1,revision,cohort,1,nonce,expiresAt,presets,subject,release,lane])).toString('base64url')
    const signedToken=payload+'.'+h('dazl-scorecard-ticket:v1\n'+payload)
    const ticket=verifyScorecardTicket(signedToken,secret,{tenantId,actorId,jobId,attempt:1,release},Date.now())
    assert.ok(ticket)
    return {ticket,jobId,signedToken}
  }
  try{
    migrateAllSqlite(db)
    const port=sqliteDb(db)
    const addUser=db.prepare("INSERT INTO users(id,email,name,business_name,website,password_hash,salt,email_verified_at) VALUES(?,?,'Private Person',?,?, 'PRIVATE_HASH','PRIVATE_SALT',1)")
    addUser.run(actorId,'owner@example.test','Unrelated Owner Personal Business','https://owner.example')
    db.prepare("INSERT INTO organizations(id,kind,created_by,created_at,company_first_scorecard_enabled,company_first_scorecard_revision) VALUES(?,'team',?,1,1,?)").run(tenantId,actorId,revision)
    db.prepare("INSERT INTO memberships(tenant_id,member_id,role,created_at) VALUES(?,?,'owner',1)").run(tenantId,actorId)
    db.prepare("INSERT INTO tenant_llm_keys(tenant_id,vendor,ciphertext,last4,validated_at) VALUES(?,'anthropic','PRIVATE_KEY','0000',1)").run(tenantId)
    const old=issue('old'),next=issue('new')
    assert.deepEqual(armProtectedScorecardJobSqlite(db,old.ticket,reviewed),{ok:true,jobId:old.jobId})
    db.prepare("UPDATE company_scorecard_claims SET status='complete' WHERE job_id=?").run(old.jobId)
    db.prepare("UPDATE scan_jobs SET status='done',claimed_at=NULL,finished_at=unixepoch() WHERE id=?").run(old.jobId)
    assert.deepEqual(armProtectedScorecardJobSqlite(db,next.ticket,reviewed),{ok:true,jobId:next.jobId})
    let tested=false
    const routed=await dispatchScorecardAware(port,{id:next.jobId,user_id:tenantId,attempts:1},async()=>assert.fail('legacy'),{
      release,materialFor:async()=>({signedToken:next.signedToken,signingKey:secret}),
      async runPrivate(execution){
        assert.equal(await withNewDiscoveryScratch(db,{tenantId,actorId,jobId:next.jobId,release,attempt:1},
          next.signedToken,secret,reviewed,async({db:scratch,signal})=>{
            const provision=()=>provisionPrivatePolicyContext(db,scratch,execution,reviewed,signal)
            process.env.DAZL_ENV='staging'; process.env.DAZL_COMMIT_SHA=release
            assert.equal(await provision(),null,'do not substitute actor identity for missing tenant identity')
            addUser.run(tenantId,'tenant@example.test','Fixture Seller Company','https://seller.example/about')
            assert.equal(await provision(),null,'absent memory is not an empty exclusion list')
            await setCompetitors(port,tenantId,['Rival Company'])
            saveMemory(db,tenantId,{tone:'NEVER_COPY_TONE',icp:'NEVER_COPY_ICP',positioning:'NEVER_COPY_POSITIONING',
              objections:[{q:'NEVER_COPY_Q',a:'NEVER_COPY_A'}],exclusions:['Excluded Supplier']})
            db.prepare('UPDATE tenant_memory SET exclusions=? WHERE tenant_id=?').run('{bad',tenantId)
            assert.equal(await provision(),null,'malformed exclusions are not an empty exclusion list')
            db.prepare('UPDATE tenant_memory SET exclusions=? WHERE tenant_id=?').run('["Excluded Supplier"]',tenantId)
            process.env.DAZL_ENV='production'
            assert.equal(await provision(),null)
            process.env.DAZL_ENV='staging'
            const context=await provision()
            assert.ok(context)
            assert.equal(JSON.stringify(context),'{}')
            assert.equal(await provision(),null,'only one immutable policy projection')
            const check=()=>privatePolicyContextCurrent(context,db,scratch,execution,reviewed,signal)
            assert.equal(await check(),true)
            assert.deepEqual(scratch.prepare('SELECT * FROM users').all(),[
              {id:'private-scratch',business_name:'Fixture Seller Company',website:'https://seller.example'}])
            assert.throws(()=>scratch.prepare('SELECT email FROM users'),/no such column/)
            assert.throws(()=>scratch.prepare('SELECT * FROM tenant_llm_keys'),/no such table/)
            const memory=getMemory(scratch,'private-scratch')
            assert.ok(memory)
            assert.deepEqual({exclusions:memory.exclusions,icp:memory.icp,tone:memory.tone,positioning:memory.positioning,objections:memory.objections},
              {exclusions:['Excluded Supplier'],icp:'',tone:'',positioning:'',objections:[]})
            assert.equal(isExcluded(memory,{company:'Excluded Supplier',company_domain:null}),true)
            const scoped=sqliteDb(scratch)
            assert.deepEqual(await readCompetitorsStrict(scoped,'private-scratch'),['Rival Company'])
            const rubric=await loadPlayDemandRubric(scoped,'private-scratch',next.jobId)
            assert.ok(rubric.rubric)
            assert.equal(await privatePolicyContextCurrent({...context},db,scratch,execution,reviewed,signal),false)
            assert.equal(await privatePolicyContextCurrent(context,db,scratch,{...execution},reviewed,signal),false)
            assert.equal(await privatePolicyContextCurrent(context,db,scratch,execution,{...reviewed,query:'different'},signal),false)
            await setCompetitors(port,tenantId,['New Rival'])
            assert.equal(await check(),false,'live competitor changes invalidate projected proof')
            await setCompetitors(port,tenantId,['Rival Company'])
            assert.equal(await check(),true)
            saveMemory(scratch,'private-scratch',{exclusions:['Tampered']})
            assert.equal(await check(),false,'scratch exclusion edits also invalidate proof')
            tested=true
        }),true)
      },
    })
    assert.deepEqual(routed,{route:'scorecard',status:'callback_returned'})
    assert.equal(tested,true)
  }finally{
    db.close()
    if(origStage===undefined)delete process.env.DAZL_ENV;else process.env.DAZL_ENV=origStage
    if(origRelease===undefined)delete process.env.DAZL_COMMIT_SHA;else process.env.DAZL_COMMIT_SHA=origRelease
  }
})
