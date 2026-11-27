import {test} from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {NextRequest} from 'next/server'
import {setScanDb} from './sequence-route-db.ts'
import {getJob} from '../../lib/scan/store.ts'
import {setDb, sqliteDb} from '../../lib/db/client.ts'
import {migrateAllSqlite} from '../../lib/db/sqlite-migrations.ts'
import {sourceCheckForLead} from '../../lib/scan/source-review.ts'
import {POST} from '../../app/api/leads/source-review/route.ts'
const request=(body:string,extra:Record<string,string>={})=>new NextRequest('https://dazl.test/api/leads/source-review',{method:'POST',headers:{'content-type':'application/json',host:'dazl.test',...extra},body})
test('actual intake validates before write and saves to the store used by Leads',async()=>{
 const db=new Database(':memory:');migrateAllSqlite(db);setScanDb(db)
 const other=new Database(':memory:');migrateAllSqlite(other);setDb(sqliteDb(other))
 try{
 for(const [body,headers] of [['bad json',{}],['{}',{}],['x'.repeat(8001),{}],['{}',{origin:'https://evil.test'}]] as [string,Record<string,string>][]){const r=await POST(request(body,headers));assert.equal(r.status,400)}
 assert.equal((db.prepare('SELECT count(*) n FROM leads').get() as {n:number}).n,0)
 assert.equal((db.prepare('SELECT count(*) n FROM source_reviews').get() as {n:number}).n,0)
 const saved=await POST(request(JSON.stringify({
  company:'Fixture',signal:'Expansion',source_url:'https://example.test/source',
  excerpt:'Fixture is expanding its customer operations.',
 })))
 assert.equal(saved.status,201)
 const result=await saved.json() as {job_id:string;lead_id:string;check:unknown}
 assert.ok(getJob(db,'A',result.job_id),'saved job is visible to the Leads lookup')
 assert.deepEqual(sourceCheckForLead(db,'A',result.lead_id),result.check)
 assert.equal(getJob(other,'A',result.job_id),undefined,'intake did not use the separate default store')
 }finally{setDb(null);other.close();db.close()}
})
