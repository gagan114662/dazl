import {test} from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {NextRequest} from 'next/server'
import {setScanDb} from './sequence-route-db.ts'
import {migrateScan} from '../../lib/scan/store.ts'
import {migrateSourceReview} from '../../lib/scan/source-review.ts'
import {POST} from '../../app/api/leads/source-review/route.ts'
const request=(body:string,extra:Record<string,string>={})=>new NextRequest('https://dazl.test/api/leads/source-review',{method:'POST',headers:{'content-type':'application/json',host:'dazl.test',...extra},body})
test('actual intake route rejects malformed/unsafe/oversized input before any row is saved',async()=>{
 const db=new Database(':memory:');migrateScan(db);migrateSourceReview(db);setScanDb(db)
 try{
 for(const [body,headers] of [['bad json',{}],['{}',{}],['x'.repeat(8001),{}],['{}',{origin:'https://evil.test'}]] as [string,Record<string,string>][]){const r=await POST(request(body,headers));assert.equal(r.status,400)}
 assert.equal((db.prepare('SELECT count(*) n FROM leads').get() as {n:number}).n,0)
 assert.equal((db.prepare('SELECT count(*) n FROM source_reviews').get() as {n:number}).n,0)
 }finally{db.close()}
})
