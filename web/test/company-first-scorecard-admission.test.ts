import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createRequire } from 'node:module'
import type { Db, Tx, TxBody, Param } from '../lib/db/client.ts'
import { requireScorecardWorkspace as gate, SCORECARD_WORKSPACE_COLUMNS } from '../lib/company-first/scorecard-workspace.ts'
import { verifyScorecardTicket, consumeScorecardTicket, authorizeScorecardSubject, scorecardPinnedBudget, SCORECARD_ANCHOR, requireCombinedScorecardReservation, completeScorecardBilling,
  verifyExistingScorecardClaim, SCORECARD_ADMISSION_DDL, type ScorecardLane } from '../lib/company-first/scorecard-admission.ts'

// The repository's Node 20 types predate this built-in; hosted tests use Node 24.
type SQLiteFixture = {
  exec(sql:string):void; close():void;
  prepare(sql:string):{
    all(...params:Param[]):unknown[]; get(...params:Param[]):Record<string,unknown>|undefined;
    run(...params:Param[]):{changes:number|bigint};
  };
}
const {DatabaseSync}=createRequire(process.cwd()+'/package.json')('node:sqlite') as {
  DatabaseSync: new(path:string)=>SQLiteFixture
}
const now = 1_800_000_000_000
const clock = () => now
const key = Buffer.alloc(32,17)
const hex = (n:number,w=64) => n.toString(16).padStart(w,'0')
const tenantId = 'sample-tenant', actorId = 'sample-owner', workspaceRevision=hex(100), release=hex(1,40), cohort=hex(101)
const presets = Array.from({length:7},(_,i)=>hex(i+1))
const subject={query:'fixture intent',icp:'{}'}
const fields = [subject.query,subject.icp,null,null,null,scorecardPinnedBudget()]
const lanes = ['old','new','judge'] as const
const claim = (ordinal:number,lane:ScorecardLane='old') => ({tenantId,actorId,jobId:hex(ordinal*3+lanes.indexOf(lane),24),attempt:1,release})
function token(ordinal:number, over: Partial<ReturnType<typeof claim>> = {}, expiresAt=now+30_000, values=fields, lane:ScorecardLane='old') {
  const x={...claim(ordinal,lane),...over}
  const mac=createHmac('sha256',key).update(JSON.stringify(['legacy-observation-v1',x.actorId,x.tenantId,x.jobId,x.attempt,
    Math.floor(expiresAt/1000),...values])).digest('hex')
  const b=Buffer.from(JSON.stringify([x.tenantId,x.actorId,x.jobId,x.attempt,workspaceRevision,cohort,ordinal,hex(ordinal*3+200+lanes.indexOf(lane)),expiresAt,presets,mac,x.release,lane])).toString('base64url')
  return b+'.'+createHmac('sha256',key).update('dazl-scorecard-ticket:v1\n').update(b).digest('hex')
}
const verified=(ordinal:number,lane:ScorecardLane='old') => verifyScorecardTicket(token(ordinal,{},now+30_000,fields,lane),key,claim(ordinal,lane),now)!
const consume=(db:Db,x:ReturnType<typeof verified>)=>consumeScorecardTicket(db,x,gate,authorizeScorecardSubject(x,subject),clock)
function setup() {
  const s=new DatabaseSync(':memory:')
  s.exec(`CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE organizations(id TEXT PRIMARY KEY);
    CREATE TABLE memberships(tenant_id TEXT, member_id TEXT, role TEXT); CREATE TABLE tenant_tombstones(deleted_tenant TEXT);
    CREATE TABLE scan_jobs(id TEXT PRIMARY KEY,user_id TEXT,business_name TEXT,industry TEXT,location TEXT,icp_inferred INT,attempts INT,status TEXT,error TEXT,query TEXT,icp TEXT,offer TEXT,seller TEXT,sources TEXT,run_budget TEXT,funded_by TEXT,csv_domain TEXT,watch_id TEXT);
    CREATE TABLE scan_spend_calls(id TEXT PRIMARY KEY,scan_job_id TEXT,user_id TEXT,attempt INT,status TEXT,reserve_usd REAL,actual_usd REAL,kind TEXT,settled_at BIGINT);
  `)
  for(const sql of [...SCORECARD_WORKSPACE_COLUMNS,...SCORECARD_ADMISSION_DDL])s.exec(sql)
  s.prepare("INSERT INTO users VALUES(?)").run(actorId)
  s.prepare("INSERT INTO organizations VALUES(?,1,?)").run(tenantId,workspaceRevision)
  s.prepare("INSERT INTO memberships VALUES(?,?,'owner')").run(tenantId,actorId)
  for(let i=1;i<=7;i++) for (const lane of lanes) s.prepare(`INSERT INTO scan_jobs
    (id,user_id,business_name,industry,location,attempts,status,run_budget,funded_by)
    VALUES(?,?,?,?,?,1,'running',?,'user')`).run(claim(i,lane).jobId,tenantId,SCORECARD_ANCHOR.business_name,
      '(from request)','-',scorecardPinnedBudget())
  // Actual SQLite transactions and constraints with the repo's exact Tx generator
  // port. No fake result counts or made-up SQL driver responses.
  const op=(op:'all'|'get'|'run',sql:string,params:Param[] = [])=>s.prepare(sql)[op](...params)
  const db:Db={kind:'sqlite',
    async all<T>(sql:string,p?:Param[]){return op('all',sql,p) as T[]},
    async get<T>(sql:string,p?:Param[]){return op('get',sql,p) as T|undefined},
    async run(sql,p){return {changes:Number((op('run',sql,p) as {changes:number|bigint}).changes)}},
    async close(){s.close()},
    async tx<T>(body:(t:Tx)=>TxBody<T>){
      const t:Tx={kind:'sqlite',
        *get<T>(sql:string,params:Param[]=[]):TxBody<T|undefined>{return (yield {op:'get',sql,params}) as T|undefined},
        *all<T>(sql:string,params:Param[]=[]):TxBody<T[]>{return (yield {op:'all',sql,params}) as T[]},
        *run(sql,params=[]):TxBody<{changes:number}>{return (yield {op:'run',sql,params}) as {changes:number}},
      }
      s.exec('BEGIN IMMEDIATE')
      try {
        const g=body(t)
        let n=g.next()
        while(!n.done){
          const {op:kind,sql,params}=n.value
          const r=op(kind,sql,params)
          n=g.next(kind==='run'?{changes:Number((r as {changes:number|bigint}).changes)}:r)
        }
        s.exec('COMMIT')
        return n.value
      } catch(e){s.exec('ROLLBACK');throw e}
    },
  }
  const spend=(x:ReturnType<typeof verified>,id:string,lane:ScorecardLane,usd:number,kind='llm.anthropic')=>db.tx(function* (t){
    yield* t.run("INSERT INTO scan_spend_calls VALUES(?,?,?,?,'reserved',?,NULL,?,NULL)",[id,x.jobId,x.tenantId,x.attempt,usd,kind])
    yield* requireCombinedScorecardReservation(t,x,gate,lane,id,clock)
  })
  const settle=(id:string,actual:number)=>s.prepare("UPDATE scan_spend_calls SET actual_usd=?,status='settled',settled_at=1 WHERE id=?").run(actual,id)
  return {s,db,spend,settle}
}
test('verified job+intent+release and current owner/revision; token is single-use and cannot skip roster order',async()=>{
  const {s,db}=setup()
  assert.equal(verifyScorecardTicket(token(1),key,claim(2),now),null)
  assert.equal(verifyScorecardTicket(token(1),key,{...claim(1),tenantId:'other-tenant'},now),null)
  assert.equal(verifyScorecardTicket(token(1),key,{...claim(1),release:hex(300,40)},now),null)
  assert.equal(verifyScorecardTicket(token(1),key,claim(1),now+30_000),null)
  assert.equal(await consume(db,verified(2)),false)
  s.prepare("UPDATE scan_jobs SET query='altered' WHERE id=?").run(claim(1).jobId)
  assert.equal(await consume(db,verified(1)),false)
  s.prepare("UPDATE scan_jobs SET query=NULL WHERE id=?").run(claim(1).jobId)
  s.exec("UPDATE memberships SET role='viewer'")
  assert.equal(await consume(db,verified(1)),false)
  s.exec("UPDATE memberships SET role='owner'")
  assert.deepEqual(await Promise.all([1,1].map(i=>consume(db,verified(i)))),[true,false])
  assert.equal(await consume(db,verified(2)),false)
  await db.close()
})
test('unknown reservations prevent next dispatch and denied canonical reserve rolls back',async()=>{
  const {s,db,spend,settle}=setup(), x=verified(1)
  assert.equal(await consume(db,x),true)
  assert.equal(await verifyExistingScorecardClaim(db,x,gate,clock),true)
  await assert.rejects(spend(x,'new-before','new',1),/scorecard_spend_refused/)
  await assert.rejects(spend(x,'judge-before','judge',1),/scorecard_spend_refused/)
  await assert.rejects(spend(x,'not-claude','old',1,'llm.openai'),/scorecard_spend_refused/)
  await spend(x,'old','old',3)
  assert.equal(await verifyExistingScorecardClaim(db,x,gate,clock),false)
  await assert.rejects(spend(x,'unknown','new',1),/scorecard_spend_refused/)
  assert.equal(s.prepare("SELECT count(*) AS n FROM scan_spend_calls").get()?.n,1)
  const next=verified(1,'new'), judge=verified(1,'judge')
  assert.notEqual(x.jobId,next.jobId)
  assert.equal(await consume(db,next),false)
  settle('old',3)
  const done=(jobId:string)=>s.prepare("UPDATE scan_jobs SET status='done' WHERE id=?").run(jobId)
  done(x.jobId)
  assert.equal(await completeScorecardBilling(db,x,gate,clock),true)
  assert.equal(await consume(db,next),true)
  await assert.rejects(spend(next,'cap','new',2.01),/scorecard_spend_refused/)
  await spend(next,'new','new',1)
  settle('new',1)
  await assert.rejects(spend(next,'backwards','old',.1),/scorecard_spend_refused/)
  done(next.jobId)
  assert.equal(await completeScorecardBilling(db,next,gate,clock),true)
  assert.equal(await consume(db,judge),true)
  await spend(judge,'judge','judge',.5)
  done(judge.jobId)
  assert.equal(await completeScorecardBilling(db,judge,gate,clock),false)
  settle('judge',.5)
  assert.equal(await completeScorecardBilling(db,judge,gate,clock),true)
  assert.equal(await completeScorecardBilling(db,judge,gate,clock),false)
  assert.equal(await consume(db,verified(2)),true)
  await db.close()
})
test('lost claim, disabled/recreated workspace and an uncovered old call never admit',async()=>{
  const {s,db,spend}=setup(), x=verified(1)
  assert.equal(await consume(db,x),true)
  s.exec('UPDATE organizations SET company_first_scorecard_enabled=0')
  await assert.rejects(spend(x,'off','old',.1))
  s.prepare('UPDATE organizations SET company_first_scorecard_enabled=1, company_first_scorecard_revision=?').run(hex(400))
  await assert.rejects(spend(x,'wrong-revision','old',.1))
  s.prepare('UPDATE organizations SET company_first_scorecard_revision=?').run(workspaceRevision)
  s.prepare("UPDATE scan_jobs SET attempts=2 WHERE id=?").run(x.jobId)
  await assert.rejects(spend(x,'stale','old',.1))
  s.prepare("UPDATE scan_jobs SET attempts=1 WHERE id=?").run(x.jobId)
  s.prepare("INSERT INTO scan_spend_calls VALUES('unlinked',?,?,1,'reserved',1,NULL,'llm.anthropic',NULL)").run(x.jobId,x.tenantId)
  await assert.rejects(spend(x,'old','old',.1))
  await db.close()
})

test('cross-workspace actor erasure cascades private claims and bridge only, never canonical charge',async()=>{
  const {s,db,spend,settle}=setup(), x=verified(1)
  assert.equal(await consume(db,x),true)
  await spend(x,'own-original','old',0.1)
  settle('own-original',0.1)
  s.prepare('INSERT INTO organizations VALUES(?,1,?)').run('unrelated-workspace',hex(400))
  s.prepare('INSERT INTO users VALUES(?)').run('unrelated-actor')
  s.prepare("INSERT INTO company_scorecard_cohorts VALUES(?,?,?,?,?,?,1)")
    .run(hex(401),'unrelated-workspace','unrelated-actor',hex(400),release,JSON.stringify(presets))
  s.prepare('DELETE FROM users WHERE id=?').run(actorId)
  for(const t of ['company_scorecard_claims','company_scorecard_calls'])
    assert.equal(s.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n,0)
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM company_scorecard_cohorts').get()?.n,1)
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM scan_spend_calls').get()?.n,1)
  await db.close()
})
