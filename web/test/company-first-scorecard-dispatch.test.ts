import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createRequire } from 'node:module'
import type { Db, Tx, TxBody, Param } from '../lib/db/client.ts'
import { requireScorecardWorkspace as gate, SCORECARD_WORKSPACE_COLUMNS } from '../lib/company-first/scorecard-workspace.ts'
import { verifyScorecardTicket, consumeScorecardTicket, authorizeScorecardSubject, scorecardPinnedBudget, SCORECARD_ANCHOR,
  SCORECARD_ADMISSION_DDL, type ScorecardLane } from '../lib/company-first/scorecard-admission.ts'

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
import { qaClaudeOnlyBudget, QA_LOCAL_EXECUTION } from '../lib/scan/qa-provider-policy.ts'
import { dispatchScorecardAware, SCORECARD_DISPATCH_COLUMNS, SCORECARD_DISPATCH_GUARDS_SQLITE, type ProtectedScorecardWorker } from '../lib/company-first/scorecard-dispatch.ts'
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
const verified=(ordinal:number,lane:ScorecardLane='old', values = fields) => verifyScorecardTicket(token(ordinal,{},now+30_000,values,lane),key,claim(ordinal,lane),now)!
const consume=(db:Db,x:ReturnType<typeof verified>)=>consumeScorecardTicket(db,x,gate,authorizeScorecardSubject(x,subject),clock)
function setup() {
  const s=new DatabaseSync(':memory:')
  s.exec(`CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE organizations(id TEXT PRIMARY KEY);
    CREATE TABLE memberships(tenant_id TEXT, member_id TEXT, role TEXT); CREATE TABLE tenant_tombstones(deleted_tenant TEXT);
    CREATE TABLE scan_jobs(id TEXT PRIMARY KEY,user_id TEXT,business_name TEXT,industry TEXT,location TEXT,icp_inferred INT,attempts INT,status TEXT,error TEXT,claimed_at INT,finished_at INT,query TEXT,icp TEXT,offer TEXT,seller TEXT,sources TEXT,run_budget TEXT,funded_by TEXT,csv_domain TEXT,watch_id TEXT);
    CREATE TABLE monitors(id TEXT PRIMARY KEY,user_id TEXT); CREATE TABLE monitor_runs(job_id TEXT,monitor_id TEXT);
    CREATE TABLE scan_spend_calls(id TEXT PRIMARY KEY,scan_job_id TEXT,user_id TEXT,attempt INT,status TEXT,reserve_usd REAL,actual_usd REAL,kind TEXT,settled_at BIGINT);
  `)
  for(const sql of [...SCORECARD_WORKSPACE_COLUMNS,...SCORECARD_ADMISSION_DDL,...SCORECARD_DISPATCH_COLUMNS])s.exec(sql)
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
  return {s,db}
}
const job = { id: claim(1).jobId, user_id: tenantId, attempts: 1 }
const refused = { route:'scorecard', status:'refused', reason:'scorecard_dispatch_refused' }
function fixtures() {
  const {s,db}=setup()
  const events: string[]=[]
  const ordinary=async () => {events.push('legacy'); return 'done' as const}
  const worker: ProtectedScorecardWorker = {
    release,
    materialFor: async scope => {
      events.push('material')
      assert.deepEqual(scope,{...claim(1),nonce:hex(203),lane:'old'})
      return {signedToken:token(1),signingKey:key}
    },
    runPrivate: async execution => {
      events.push('private')
      assert.equal(execution.ticket.jobId,job.id)
      assert.equal(execution.funding,'workspace_owned')
      assert.equal(execution.vendor,'anthropic')
    },
  }
  const mark = () => s.prepare('UPDATE scan_jobs SET company_scorecard_claim_nonce=? WHERE id=?').run(hex(203),job.id)
  const admit = () => consume(db,verified(1))
  const run = (override: Partial<ProtectedScorecardWorker> = {}, raced = job) => dispatchScorecardAware(db,raced,ordinary,{...worker,...override},clock)
  return {s,db,events,ordinary,worker,run,mark,admit}
}

test('only ordinary null marker calls legacy, including with workspace enabled', async () => {
  const f=fixtures()
  try {
    assert.deepEqual(await f.run(),{route:'legacy',status:'done'})
    assert.deepEqual(await f.run({}, {...job,user_id:'foreign'}),refused)
    assert.deepEqual(await f.run({}, {...job,attempts:2}),refused)
    assert.deepEqual(f.events,['legacy'])
  } finally { await f.db.close() }
})

test('missing, malformed, revoked, watched, trial, monitored, QA and expired private work never resolve key material or run legacy', async () => {
  const f=fixtures()
  try {
    f.mark()
    assert.deepEqual(await f.run(),refused)
    assert.equal(await f.admit(),true)
    for (const [sql, clear] of [
      ["UPDATE organizations SET company_first_scorecard_enabled=0","UPDATE organizations SET company_first_scorecard_enabled=1"],
      ["UPDATE memberships SET role='admin'","UPDATE memberships SET role='owner'"],
      ["UPDATE scan_jobs SET company_scorecard_claim_nonce='wrong'","UPDATE scan_jobs SET company_scorecard_claim_nonce=NULL"],
      ["UPDATE scan_jobs SET watch_id='watch'","UPDATE scan_jobs SET watch_id=NULL"],
      ["UPDATE scan_jobs SET csv_domain='fixture.invalid'","UPDATE scan_jobs SET csv_domain=NULL"],
      ["UPDATE scan_jobs SET funded_by='trial'","UPDATE scan_jobs SET funded_by='user'"],
      [`UPDATE scan_jobs SET run_budget='{"provider_policy":"claude_only_v1"}'`,`UPDATE scan_jobs SET run_budget='${scorecardPinnedBudget()}'`],
      [`INSERT INTO monitors VALUES('m','${tenantId}'); INSERT INTO monitor_runs VALUES('${job.id}','m');`,"DELETE FROM monitor_runs"],
    ]) {
      f.s.exec(sql)
      assert.deepEqual(await f.run(),refused,sql.split(' ').slice(0,3).join(' '))
      f.s.exec(clear)
      f.mark()
    }
    assert.deepEqual(await dispatchScorecardAware(f.db,job,f.ordinary,f.worker,() => now+30_001),refused)
    assert.deepEqual(f.events,[])
  } finally { await f.db.close() }
})

test('revocation during protected resolution refuses atomic dispatch before callback', async () => {
  const f=fixtures()
  try {
    f.mark();assert.equal(await f.admit(),true)
    assert.deepEqual(await f.run({materialFor:async () => {
      f.s.exec('UPDATE organizations SET company_first_scorecard_enabled=0')
      return {signedToken:token(1),signingKey:key}
    }}),refused)
    assert.equal(f.s.prepare('SELECT company_scorecard_dispatch_started_at AS started FROM scan_jobs WHERE id=?').get(job.id)?.started,null)
    assert.deepEqual(f.events,[])
  } finally { await f.db.close() }
})

test('successful validated dispatch uses real canonical combined hook; duplicate and callback fault never replay', async () => {
  const f=fixtures()
  try {
    f.mark();assert.equal(await f.admit(),true)
    const worker={runPrivate:async (x: Parameters<ProtectedScorecardWorker['runPrivate']>[0]) => {
      f.events.push('private')
      const reserve = (kind: string) => f.db.tx(function* (t) {
        yield* t.run("INSERT INTO scan_spend_calls VALUES('charge',?,?,1,'reserved',1,NULL,?,NULL)",[job.id,tenantId,kind])
        yield* x.requireReservation(t,'charge')
      })
      await assert.rejects(reserve('llm.openai'),/scorecard_spend_refused/)
      assert.equal(f.s.prepare("SELECT count(*) AS n FROM scan_spend_calls").get()?.n,0)
      await reserve('llm.anthropic')
      throw new Error('private provider failure never echo')
    }}
    const got = await Promise.all([f.run(worker),f.run(worker)])
    assert.ok(got.some(x=>x.route==='scorecard' && x.status==='refused' && x.reason==='scorecard_dispatch_failed'))
    assert.equal(f.events.filter(x=>x==='private').length,1)
    assert.ok(!f.events.includes('legacy'))
    assert.equal(f.s.prepare("SELECT count(*) AS n FROM scan_spend_calls").get()?.n,1)
    assert.deepEqual(await f.run(worker),{route:'scorecard',status:'refused',reason:'scorecard_dispatch_started'})
  } finally { await f.db.close() }
})

test('schema prevents marking ordinary rows or exposing a tagged row to old pending claimers', async () => {
  const f=fixtures()
  try {
    f.mark()
    f.s.exec(SCORECARD_DISPATCH_GUARDS_SQLITE)
    assert.throws(() => f.s.exec("UPDATE scan_jobs SET company_scorecard_claim_nonce=NULL"), /immutable/)
    assert.throws(() => f.s.exec("UPDATE scan_jobs SET company_scorecard_claim_nonce='changed'"), /immutable/)
    assert.throws(() => f.s.prepare("INSERT INTO scan_jobs(id,user_id,status,company_scorecard_claim_nonce) VALUES('pending-tag',?,'pending',?)").run(tenantId,hex(400)), /CHECK constraint/)
    const handback = () => f.s.prepare("UPDATE scan_jobs SET status='pending' WHERE id=?").run(job.id)
    f.s.prepare("INSERT INTO scan_spend_calls(id,scan_job_id,user_id,attempt,status) VALUES('unknown',?,?,1,'reserved')").run(job.id,tenantId)
    handback()
    assert.equal(f.s.prepare("SELECT status FROM scan_jobs WHERE id=?").get(job.id)?.status,'failed')
    assert.equal(f.s.prepare("SELECT error FROM scan_jobs WHERE id=?").get(job.id)?.error,'accounting_uncertain')
    assert.equal(f.s.prepare("SELECT count(*) AS n FROM scan_jobs WHERE status='pending'").get()?.n,0)
    f.s.prepare("UPDATE scan_jobs SET status='pending' WHERE id=?").run(claim(2).jobId)
    assert.equal(f.s.prepare("SELECT status FROM scan_jobs WHERE id=?").get(claim(2).jobId)?.status,'pending')
  } finally { await f.db.close() }
})

test('separate candidate arm sees only its own current ticket and cannot borrow the baseline arm', async () => {
  const f=fixtures()
  try {
    f.mark();assert.equal(await f.admit(),true)
    f.s.prepare("UPDATE company_scorecard_claims SET status='complete' WHERE job_id=?").run(job.id)
    const candidate = { ...job,id:claim(1,'new').jobId }
    f.s.prepare("UPDATE scan_jobs SET company_scorecard_claim_nonce=? WHERE id=?").run(hex(204),candidate.id)
    assert.equal(await consume(f.db,verified(1,'new')),true)
    const materialFor = async () => ({signedToken:token(1),signingKey:key})
    assert.deepEqual(await f.run({materialFor},candidate),refused)
    assert.deepEqual(f.events,[])
    assert.deepEqual(await f.run({
      materialFor: async scope => {
        assert.equal(scope.lane,'new')
        return {signedToken:token(1,{},now+30_000,fields,'new'),signingKey:key}
      },
      runPrivate: async execution => {
        assert.equal(execution.ticket.lane,'new')
        f.events.push('candidate')
      },
    },candidate),{route:'scorecard',status:'callback_returned'})
    assert.deepEqual(f.events,['candidate'])
  } finally { await f.db.close() }
})

test('official opted-in first5 native baseline preserves web search but decoy fixture QA earns no dispatch', async () => {
  // Exact composition of /api/scan POST and pinAdmittedStrictJob, not made-up
  // string literals. Historical names are not any source of authority.
  const pin = (native: boolean) => ({ ...JSON.parse(qaClaudeOnlyBudget(JSON.stringify({
    first5: true,
  }), native)), execution: QA_LOCAL_EXECUTION })
  const genuine = pin(true)
  for (const [body, expected] of [
    [genuine,true],
    [pin(false),false],
    [{...genuine, fixture_mode:'fixture'},false],
    [{...genuine, execution:undefined},false],
    [{...genuine, max_usd:4},false],
    [{...genuine, paid_fallback:true},false],
  ] as const) {
    const f=fixtures()
    try {
      f.mark()
      const budget = JSON.stringify(body)
      assert.equal(await consume(f.db,verified(1)),true)
      f.s.prepare('UPDATE scan_jobs SET run_budget=? WHERE id=?').run(budget,job.id)
      const got = await f.run({materialFor: async () => {
        f.events.push('material')
        return {signedToken:token(1),signingKey:key}
      }})
      assert.deepEqual(got,expected ? {route:'scorecard',status:'callback_returned'} : refused)
      assert.deepEqual(f.events,expected ? ['material','private'] : [])
    } finally { await f.db.close() }
  }
})
