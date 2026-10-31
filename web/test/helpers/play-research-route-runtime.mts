// Covers GET /api/leads/play-research and POST /api/leads/play-research for foreign tenant IDs.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {NextRequest} from 'next/server'
import {setScanDb,setUser} from './play-research-route-db.ts'
import {calls,resetCalls} from './play-research-fetch.ts'
import {migrateAllSqlite} from '../../lib/db/sqlite-migrations.ts'
import {POST,GET} from '../../app/api/leads/play-research/route.ts'
const job='a'.repeat(24),body={job_id:job,company:'Epoch',signal:'First sales job claim',source_url:'https://epoch.example/jobs',excerpt:'Epoch is hiring a first sales representative in London.'}
const request=(body:string,extra:Record<string,string>={})=>new NextRequest('https://dazl.test/api/leads/play-research',{method:'POST',headers:{'content-type':'application/json',host:'dazl.test',...extra},body})
const GET_ROUTE = 'GET /api/leads/play-research', POST_ROUTE = 'POST /api/leads/play-research'
assert.ok(GET_ROUTE&&POST_ROUTE)
const read=()=>GET(new NextRequest('https://dazl.test/api/leads/play-research?job_id='+job))
test('GET /api/leads/play-research and POST /api/leads/play-research persist/reload with auth/role/tenant/rate/origin/validation/error boundaries',async()=>{
 const db=new Database(':memory:');migrateAllSqlite(db);setScanDb(db);resetCalls();const limiter=db
 try{
 db.prepare("INSERT INTO users(id,email,password_hash,salt) VALUES('A','a@example.test','test','test')").run()
 db.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,query,offer) VALUES(?,'A','Original','SaaS','London','running','London SaaS first sales in 90 days','CRM setup')").run(job)
 db.prepare("UPDATE scan_jobs SET status='done' WHERE id=?").run(job)
 const before=JSON.stringify(db.prepare('SELECT * FROM scan_jobs').all())
 setUser(null);assert.equal((await read()).status,401);assert.equal((await POST(request(JSON.stringify(body)))).status,401)
 setUser('A','viewer');assert.equal((await POST(request(JSON.stringify(body)))).status,403);assert.equal(calls,0)
 setUser('B');assert.equal((await POST(request(JSON.stringify(body)))).status,400);assert.deepEqual((await (await read()).json()).research,[]);assert.equal(calls,0)
 setUser('A')
 for(const [text,headers,status] of [['bad json',{},400],['{}',{},404],['x'.repeat(10001),{},400],['{}',{origin:'https://evil.test'},400],['{}',{origin:'bad-url'},400],['{}',{'content-type':'text/plain'},400]] as [string,Record<string,string>,number][]){assert.equal((await POST(request(text,headers))).status,status)}
 assert.equal(calls,0)
 const created=await POST(request(JSON.stringify(body)));assert.equal(created.status,201);const saved=await created.json();assert.equal(saved.can_draft,false);assert.equal(calls,1)
 const loaded=await (await read()).json();assert.equal(loaded.research.length,1);assert.equal(loaded.research[0].id,saved.id);assert.equal(loaded.research[0].source_check.quote_match,true);assert.equal(loaded.research[0].query_snapshot,'London SaaS first sales in 90 days');assert.equal(loaded.research[0].email_claim,null)
 // Rate storage is a distinct scratch connection, as in production. Force its tenant bucket closed.
 limiter.prepare("UPDATE rate_limits SET count=10 WHERE key='play-research:A'").run();const limited=await POST(request(JSON.stringify(body)));assert.equal(limited.status,429);assert.ok(limited.headers.get('retry-after'));assert.equal(calls,1)
 limiter.prepare("DELETE FROM rate_limits WHERE key='play-research:A'").run()
 // Missing shared store fails closed, not a process-local allowance.
 limiter.exec('ALTER TABLE rate_limits RENAME TO hidden_limits');const unavailable=await POST(request(JSON.stringify(body)));assert.equal(unavailable.status,503);assert.equal(calls,1);limiter.exec('ALTER TABLE hidden_limits RENAME TO rate_limits')
 setUser('B');assert.deepEqual((await (await read()).json()).research,[])
 assert.equal(JSON.stringify(db.prepare('SELECT * FROM scan_jobs').all()),before);assert.equal((db.prepare('SELECT count(*) n FROM leads').get() as {n:number}).n,0);assert.equal((db.prepare('SELECT count(*) n FROM outreach_messages').get() as {n:number}).n,0)
 }finally{setUser('A');db.close()}
})
