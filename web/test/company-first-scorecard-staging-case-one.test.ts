import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { scorecardPinnedBudget, stagingCaseOneCohort, verifyScorecardTicket } from '../lib/company-first/scorecard-admission.ts'
import { launchReviewedLocalScorecardArm } from '../lib/company-first/scorecard-local-launch.ts'

const hex = (n:number,size=64) => n.toString(16).padStart(size,'0')
test('staging case-one runs the real guarded worker once, cannot start old or be replayed, and charges nothing on missing binding', async () => {
  const root=mkdtempSync(join(tmpdir(),'staging-case-one-'))
  const file=join(root,'app.db')
  const db=new Database(file)
  const key=Buffer.alloc(32,57), proofKey=Buffer.alloc(32,58)
  const scope={tenantId:'fixture-workspace',actorId:'fixture-owner',release:hex(43,40)}
  const host={webRoot:root,privateSqlitePath:file,servingRelease:scope.release,runtime:'staging' as const}
  const revision=hex(42), cohort=stagingCaseOneCohort(scope.tenantId,scope.release)
  const reviewedInput={query:'Synthetic approved input',icp:JSON.stringify({summary:'Synthetic profile'})}
  const expiresAt=Date.now()+30_000
  const mac=(x:string, k=key)=>createHmac('sha256',k).update(x).digest('hex')
  const grants=(jobId:string,nonce:string,lane:'old'|'new'='new', ordinal=1, presets=[hex(59)])=>{
    const subjectMac=mac(JSON.stringify(['legacy-observation-v1',scope.actorId,scope.tenantId,jobId,1,Math.floor(expiresAt/1000),
      reviewedInput.query,reviewedInput.icp,null,null,null,scorecardPinnedBudget()]))
    const bytes=Buffer.from(JSON.stringify([scope.tenantId,scope.actorId,jobId,1,revision,cohort,ordinal,nonce,expiresAt,presets,subjectMac,scope.release,lane]))
    const body=bytes.toString('base64url')
    return {
      input:{jobId,signedToken:body+'.'+mac('dazl-staging-case-one-ticket:v1\n'+body),reviewedInput},
      proofRequest:{expiresAt,mac:mac(JSON.stringify(['dazl-staging-scorecard-proof/v1',scope.tenantId,
        scope.actorId,jobId,1,scope.release,revision,cohort,ordinal,nonce,subjectMac,expiresAt]),proofKey)},
    }
  }
  const patch={DAZL_ENV:'staging',DAZL_COMMIT_SHA:scope.release,DAZL_STAGING_SCORECARD_PROOF_KEY:proofKey.toString('hex'),SCAN_MAX_CONCURRENT:'1'}
  const previously=Object.keys(patch).map(name=>[name,process.env[name]] as const)
  Object.assign(process.env,patch)
  let bound=0, prepared=0
  try{
    writeFileSync(join(root,'.build-commit'),scope.release+'\n')
    migrateAllSqlite(db)
    db.prepare("INSERT INTO users (id,email,name,business_name,password_hash,salt) VALUES (?,?,'','','','')").run(scope.actorId,'owner@example.test')
    db.prepare("INSERT INTO organizations (id,kind,created_by,created_at,company_first_scorecard_enabled,company_first_scorecard_revision) VALUES (?,'team',?,1,1,?)").run(scope.tenantId,scope.actorId,revision)
    db.prepare("INSERT INTO memberships (tenant_id,member_id,role,created_at) VALUES (?,?,'owner',1)").run(scope.tenantId,scope.actorId)
    db.prepare("INSERT INTO tenant_llm_keys (tenant_id,vendor,ciphertext,last4,validated_at) VALUES (?,'anthropic','fixture-not-a-key','0000',1)").run(scope.tenantId)
    const first=grants(hex(45,24),hex(46))
    const launch=(x:ReturnType<typeof grants>, releaseHost=host)=>launchReviewedLocalScorecardArm(db,scope,{
      signer:key,stagingCaseOne:{host:releaseHost,proofRequest:x.proofRequest},
      async loadBinding(){
        prepared++
        return ()=>{bound++;return null}
      },
    },x.input,new AbortController().signal)
    assert.equal(verifyScorecardTicket(first.input.signedToken,key,{...scope,jobId:first.input.jobId,attempt:1},Date.now()),null)
    assert.equal((await launch(grants(hex(45,24),hex(46),'old'))).state,'held')
    assert.equal((await launch(grants(hex(45,24),hex(46),'new',2))).state,'held')
    assert.equal((await launch(grants(hex(45,24),hex(46),'new',1,[hex(12),hex(13)]))).state,'held')
    assert.equal((await launch(first,{...host,servingRelease:hex(999,40)})).state,'held')
    assert.equal((await launch({...first,proofRequest:{...first.proofRequest,mac:hex(1)}})).state,'held')
    process.env.DAZL_ENV='production'
    assert.equal((await launch(first)).state,'held')
    process.env.DAZL_ENV='staging'
    assert.equal(prepared,0)
    assert.equal(db.prepare('SELECT COUNT(*) FROM scan_jobs').pluck().get(),0)
    assert.deepEqual(await launch(first),{state:'held',reason:'candidate_unbound'})
    assert.equal(bound,1)
    assert.deepEqual(db.prepare('SELECT lane,ordinal FROM company_scorecard_claims').all(),[{lane:1,ordinal:1}])
    assert.deepEqual(db.prepare('SELECT query,icp,company_scorecard_dispatch_release AS release FROM scan_jobs').all(),[{query:null,icp:null,release:scope.release}])
    assert.equal((await launch(first)).state,'held')
    assert.equal((await launch(grants(hex(48,24),hex(49)))).state,'held')
    assert.equal(bound,1)
    assert.equal(db.prepare('SELECT COUNT(*) FROM scan_jobs').pluck().get(),1)
    assert.equal(db.prepare('SELECT COUNT(*) FROM scan_spend_calls').pluck().get(),0)
  }finally{
    for(const [name,before] of previously){if(before===undefined)delete process.env[name];else process.env[name]=before}
    db.close();rmSync(root,{recursive:true,force:true})
  }
})

test('operator stdin parser accepts only the bounded signed envelope, not runtime overrides', async()=>{
  const {parseStagingCaseOneMaterial:parse}=await import('../lib/company-first/scorecard-staging-case-one-entry.ts')
  const valid={tenantId:'scope',actorId:'owner',jobId:hex(1,24),signedToken:'token.'+hex(2),
    reviewedInput:{query:'Synthetic fixture inquiry',icp:'{}'},proofRequest:{expiresAt:123,mac:hex(3)}}
  const encode=(x:unknown)=>Buffer.from(JSON.stringify(x))
  assert.deepEqual(parse(encode(valid)),valid)
  assert.equal(parse(encode({...valid,database:'/tmp/different.db'})),null)
  assert.equal(parse(encode({...valid,reviewedInput:{...valid.reviewedInput,endpoint:'https://not-permitted.example'}})),null)
  assert.equal(parse(encode({...valid,reviewedInput:{...valid.reviewedInput,seller:[]} })),null)
  assert.equal(parse(Buffer.concat([encode(valid),Buffer.from([0xc3])])),null)
  assert.equal(parse(Buffer.alloc(46_001)),null)
})
