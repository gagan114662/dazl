import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { scorecardPinnedBudget, verifyScorecardTicket } from '../lib/company-first/scorecard-admission.ts'
import { launchReviewedLocalScorecardArm } from '../lib/company-first/scorecard-local-launch.ts'
import { armProtectedScorecardJobSqlite } from '../lib/company-first/scorecard-producer.ts'
import { reserveStrictLocalSlot } from '../lib/scan/strict-local-launch.ts'

test('protected launcher checks signer, subject and owner before preparation, rechecks on admission, and calls the actual guarded worker once', async () => {
  const db = new Database(':memory:')
  const hex = (n:number, size=64) => n.toString(16).padStart(size, '0')
  const key = Buffer.alloc(32,41), workspaceRevision=hex(42), jobId=hex(44,24), nonce=hex(45)
  const scope={tenantId:'workspace',actorId:'owner',release:hex(43,40)}
  const subject={query:'Synthetic approved input',icp:JSON.stringify({summary:'Synthetic profile'})}
  const exp=Date.now()+30000
  const h=(x:string)=>createHmac('sha256',key).update(x).digest('hex')
  function issue(id:string, ticketNonce:string, lane:'old'|'new') {
    const mac=h(JSON.stringify(['legacy-observation-v1',scope.actorId,scope.tenantId,id,1,Math.floor(exp/1000),subject.query,subject.icp,null,null,null,scorecardPinnedBudget()]))
    const body=Buffer.from(JSON.stringify([scope.tenantId,scope.actorId,id,1,workspaceRevision,hex(46),1,ticketNonce,exp,Array.from({length:7},(_,i)=>hex(i+1)),mac,scope.release,lane])).toString('base64url')
    return body+'.'+h('dazl-scorecard-ticket:v1\n'+body)
  }
  const material={jobId,signedToken:issue(jobId,nonce,'new'),reviewedInput:subject}
  const signal=new AbortController().signal
  const env=process.env.SCAN_MAX_CONCURRENT
  process.env.SCAN_MAX_CONCURRENT='1'
  let loaded=0, called=0
  let change=false
  const loader=async (x:unknown)=>{
    loaded++
    assert.deepEqual(x,{...scope,jobId,lane:'new'})
    if(change) db.prepare("UPDATE organizations SET company_first_scorecard_enabled=0 WHERE id=?").run(scope.tenantId)
    return ()=>{
      called++
      assert.equal(reserveStrictLocalSlot(),null,'canonical worker holds the same single slot')
      return null // exercise real dispatch without a paid provider binding
    }
  }
  const launch=(patch:Partial<typeof scope>={}, p:Partial<Parameters<typeof launchReviewedLocalScorecardArm>[2]>={}, i:Partial<typeof material>={})=>
    launchReviewedLocalScorecardArm(db,{...scope,...patch},{signer:key,loadBinding:loader,...p},{...material,...i},signal)
  try {
    migrateAllSqlite(db)
    db.prepare("INSERT INTO users (id,email,name,business_name,password_hash,salt) VALUES (?,?,'','','','')").run(scope.actorId,'owner@example.test')
    db.prepare("INSERT INTO organizations (id,kind,created_by,created_at,company_first_scorecard_enabled,company_first_scorecard_revision) VALUES (?,'team',?,1,0,?)").run(scope.tenantId,scope.actorId,workspaceRevision)
    db.prepare("INSERT INTO memberships (tenant_id,member_id,role,created_at) VALUES (?,?,'owner',1)").run(scope.tenantId,scope.actorId)
    db.prepare("INSERT INTO tenant_llm_keys (tenant_id,vendor,ciphertext,last4,validated_at) VALUES (?,'anthropic','fixture-not-a-key','0000',1)").run(scope.tenantId)
    const count=()=>db.prepare('SELECT COUNT(*) FROM scan_jobs').pluck().get()
    for(const result of [await launch(),await launch({tenantId:'other'}),await launch({actorId:'other'}),await launch({release:hex(1,40)}),
      await launch({}, {signer:null}),await launch({}, {}, {signedToken:'bad'}),await launch({}, {}, {reviewedInput:{...subject,query:'Wrong subject'}})])
      assert.equal(result.state,'held')
    assert.equal(loaded,0)
    assert.equal(count(),0)
    const enable=()=>db.prepare("UPDATE organizations SET company_first_scorecard_enabled=1 WHERE id=?").run(scope.tenantId)
    enable()
    assert.equal((await launch({}, {loadBinding:async()=>null})).state,'held')
    change=true
    assert.equal((await launch()).state,'held')
    assert.equal(count(),0,'revocation while loading was rechecked inside producer')
    change=false
    enable()
    const slot=reserveStrictLocalSlot()
    assert.ok(slot)
    try { assert.equal((await launch()).state,'held'); assert.equal(count(),0) } finally { slot() }
    assert.equal((await launch()).state,'held','candidate cannot begin without the prior baseline')
    const oldId=hex(47,24)
    const prior=verifyScorecardTicket(issue(oldId,hex(48),'old'),key,{...scope,jobId:oldId,attempt:1},Date.now())
    assert.ok(prior)
    assert.equal(armProtectedScorecardJobSqlite(db,prior,subject).ok,true)
    // Fixture input only: provide the prior completed ordinal, not a simulated paid success in the adapter.
    db.prepare("UPDATE scan_jobs SET status='done' WHERE id=?").run(oldId)
    db.prepare("UPDATE company_scorecard_claims SET status='complete' WHERE job_id=?").run(oldId)
    assert.deepEqual(await launch(),{state:'held',reason:'candidate_unbound'})
    assert.equal(called,1)
    assert.equal(count(),2)
    assert.deepEqual(db.prepare('SELECT query, icp, attempts, company_scorecard_dispatch_release AS release FROM scan_jobs WHERE id=?').get(jobId),
      {query:null,icp:null,attempts:1,release:scope.release})
    assert.equal(db.prepare('SELECT COUNT(*) FROM scan_spend_calls').pluck().get(),0)
    assert.equal((await launch()).state,'held')
    assert.equal(called,1)
    assert.equal(count(),2)
    const after=reserveStrictLocalSlot()
    assert.ok(after,'slot restored after refusal')
    after()
  } finally {
    if(env===undefined) delete process.env.SCAN_MAX_CONCURRENT
    else process.env.SCAN_MAX_CONCURRENT=env
    db.close()
  }
})
