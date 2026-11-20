import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import Database from 'better-sqlite3'
import { qaClaudeOnlyBudget, QA_LOCAL_EXECUTION } from '../lib/scan/qa-provider-policy.ts'
import { authorizeScorecardSubject, SCORECARD_ANCHOR, verifyScorecardTicket } from '../lib/company-first/scorecard-admission.ts'
import { dispatchScorecardAware } from '../lib/company-first/scorecard-dispatch.ts'
import { armProtectedScorecardJobSqlite } from '../lib/company-first/scorecard-producer.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { reserveScanSpend, runWithScanSpend, scanCapConfig, outsideScanSpend } from '../lib/scan/spend-cap.ts'

test('protected scorecard producer rolls back a bad signed subject and arms a single strict claimed job with canonical spend guard', async () => {
  const db = new Database(':memory:')
  const hex=(n:number,width=64)=>n.toString(16).padStart(width,'0')
  const tenantId='fixture-workspace', actorId='fixture-owner', jobId=hex(70,24), release=hex(71,40)
  const revision=hex(72), cohort=hex(73), nonce=hex(74), key=Buffer.alloc(32,11)
  const expire=Date.now()+30_000, presets=Array.from({length:7},(_,i)=>hex(i+1))
  const query='Fixture request',icp=JSON.stringify({summary:'Fixture only'})
  const input={query,icp,sources:'["fixture-source"]',seller:'private seller marker',offer:'private offer marker'}
  const budget=JSON.stringify({...JSON.parse(qaClaudeOnlyBudget(JSON.stringify({first5:true}),true)),execution:QA_LOCAL_EXECUTION})
  function issue(approvedQuery:string){
    const h=(data:string)=>createHmac('sha256',key).update(data).digest('hex')
    const mac=h(JSON.stringify(['legacy-observation-v1',actorId,tenantId,jobId,1,Math.floor(expire/1000),approvedQuery,icp,input.offer,input.seller,input.sources,budget]))
    const payload=Buffer.from(JSON.stringify([tenantId,actorId,jobId,1,revision,cohort,1,nonce,expire,presets,mac,release,'old'])).toString('base64url')
    const signedToken=payload+'.'+h('dazl-scorecard-ticket:v1\n'+payload)
    return { signedToken, signingKey:key, ticket:verifyScorecardTicket(signedToken,key,{tenantId,actorId,jobId,attempt:1,release},Date.now())! }
  }
  try {
    migrateAllSqlite(db)
    db.prepare("INSERT INTO users (id,email,name,business_name,password_hash,salt) VALUES (?,?,'','','','')").run(actorId,'fixture@example.test')
    db.prepare("INSERT INTO organizations (id,kind,created_by,created_at,company_first_scorecard_enabled,company_first_scorecard_revision) VALUES (?,'team',?,1,1,?)").run(tenantId,actorId,revision)
    db.prepare("INSERT INTO memberships (tenant_id,member_id,role,created_at) VALUES (?,?,'owner',1)").run(tenantId,actorId)
    db.prepare("INSERT INTO tenant_llm_keys (tenant_id,vendor,ciphertext,last4,validated_at) VALUES (?,'anthropic','fixture-not-a-key','0000',1)").run(tenantId)
    assert.deepEqual(armProtectedScorecardJobSqlite(db,issue('wrong signed subject').ticket,input),{ok:false})
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scan_jobs').pluck().get(),0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM company_scorecard_claims').pluck().get(),0)
    const signed=issue(query).ticket
    for(const change of [{query:'different fixture intent'},{icp:'{"summary":"different"}'},{sources:'["other-source"]'},
                          {offer:'different offer'},{seller:'different seller'}]) {
      assert.equal(authorizeScorecardSubject(signed,{...input,...change}),null)
      assert.deepEqual(armProtectedScorecardJobSqlite(db,signed,{...input,...change}),{ok:false})
    }
    db.exec(`CREATE TRIGGER synthetic_marker_failure BEFORE UPDATE OF company_scorecard_claim_nonce ON scan_jobs
      BEGIN SELECT RAISE(ABORT,'fixture refusal after staged registration'); END`)
    assert.deepEqual(armProtectedScorecardJobSqlite(db,signed,input),{ok:false})
    for(const table of ['scan_jobs','company_scorecard_claims','company_scorecard_cohorts'])
      assert.equal(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(),0)
    db.exec('DROP TRIGGER synthetic_marker_failure')
    assert.deepEqual(armProtectedScorecardJobSqlite(db,signed,input),{ok:true,jobId})
    assert.deepEqual(db.prepare('SELECT business_name,industry,location,query,icp,sources,seller,offer,icp_inferred FROM scan_jobs').get(),{
      ...SCORECARD_ANCHOR, industry:'(from request)', location:'-', query:null, icp:null, sources:null, seller:null, offer:null, icp_inferred:null,
    })
    assert.equal(db.prepare('SELECT subject_mac FROM company_scorecard_claims').pluck().get(),signed.subjectMac)
    for(const table of ['scan_jobs','company_scorecard_claims','company_scorecard_cohorts','company_scorecard_calls']) {
      const rowDump=JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())
      for(const secret of [query,'Fixture only','fixture-source', input.offer,input.seller]) assert.equal(rowDump.includes(secret),false)
    }
    assert.deepEqual(db.prepare('SELECT status,attempts,company_scorecard_claim_nonce AS nonce FROM scan_jobs').get(),
      {status:'running',attempts:1,nonce})
    assert.deepEqual(armProtectedScorecardJobSqlite(db,issue(query).ticket,input),{ok:false})
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM company_scorecard_claims').pluck().get(),1)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM scan_jobs WHERE status='pending' AND company_scorecard_claim_nonce IS NOT NULL").pluck().get(),0)
    const material = issue(query)
    const dbPort = sqliteDb(db)
    let ordinary=0, paidCallbacks=0
    const routed = await dispatchScorecardAware(dbPort,{id:jobId,user_id:tenantId,attempts:1},async()=>{ordinary++;return 'done'},{
      release,materialFor:async()=>material,
      async runPrivate({ticket}) {
        await runWithScanSpend({db:dbPort,jobId,tenantId,attempt:1,cap:scanCapConfig({}),
          accountLimits:{day:2,month:5},claudeOnly:true,scorecard:{ticket,lane:ticket.lane}},async()=>{
          assert.throws(()=>outsideScanSpend(()=>{paidCallbacks++}),/scorecard_spend_refused/)
          await assert.rejects(reserveScanSpend('tinyfish.search',()=>0))
          // Expected policy refusal vs a real database statement failure. Neither
          // can commit job/account/bridge reservations or reach transport.
          db.prepare("UPDATE memberships SET role='viewer' WHERE tenant_id=? AND member_id=?").run(tenantId,actorId)
          await assert.rejects(reserveScanSpend('llm.anthropic',()=>0.25),{reason:'scorecard_spend_refused'})
          db.prepare("UPDATE memberships SET role='owner' WHERE tenant_id=? AND member_id=?").run(tenantId,actorId)
          db.exec(`CREATE TRIGGER fail_spend_fixture BEFORE INSERT ON company_scorecard_calls
            BEGIN SELECT RAISE(ABORT, 'fixture ledger write failed'); END`)
          await assert.rejects(reserveScanSpend('llm.anthropic',()=>0.25),{reason:'ledger_unavailable'})
          db.exec('DROP TRIGGER fail_spend_fixture')
          assert.equal(db.prepare("SELECT COUNT(*) FROM scan_spend_calls WHERE status='reserved'").pluck().get(),0)
          assert.equal(db.prepare("SELECT COUNT(*) FROM company_scorecard_calls").pluck().get(),0)
          const hold=await reserveScanSpend('llm.anthropic',()=>0.25)
          assert.ok(hold)
          paidCallbacks++
          const joined = db.prepare('SELECT reservation_id FROM company_scorecard_calls WHERE nonce=?').pluck().get(nonce)
          assert.equal(joined,hold.id)
          await hold.settle(0.15)
        })
      },
    })
    assert.deepEqual(routed,{route:'scorecard',status:'callback_returned'})
    assert.equal(ordinary,0)
    assert.equal(paidCallbacks,1)
    assert.equal(db.prepare('SELECT company_scorecard_dispatch_release FROM scan_jobs WHERE id=?').pluck().get(jobId),release)
    assert.throws(()=>db.prepare('UPDATE scan_jobs SET company_scorecard_dispatch_release=? WHERE id=?').run('f'.repeat(40),jobId),/stamp immutable/)
    assert.equal(db.prepare("SELECT actual_usd FROM scan_spend_calls WHERE scan_job_id=? AND status='settled'").pluck().get(jobId),0.15)
  } finally {db.close()}
})
