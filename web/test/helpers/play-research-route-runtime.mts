import {test} from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {NextRequest} from 'next/server'
import {setScanDb} from './sequence-route-db.ts'
import {migrateAllSqlite} from '../../lib/db/sqlite-migrations.ts'
import {POST,GET} from '../../app/api/leads/play-research/route.ts'
const request=(body:string,extra:Record<string,string>={})=>new NextRequest('https://dazl.test/api/leads/play-research',{method:'POST',headers:{'content-type':'application/json',host:'dazl.test',...extra},body})
test('actual same-play route rejects malformed/unsafe/oversized/foreign job before fetch or write',async()=>{
 const db=new Database(':memory:');migrateAllSqlite(db);setScanDb(db)
 try{
 for(const [body,headers,status] of [['bad json',{},400],['{}',{},404],['x'.repeat(10001),{},400],['{}',{origin:'https://evil.test'},400],[JSON.stringify({job_id:'a'.repeat(24),company:'X',signal:'X',source_url:'https://example.test',excerpt:'A claim of at least twenty characters'}),{},400]] as [string,Record<string,string>,number][]){const r=await POST(request(body,headers));assert.equal(r.status,status)}
 const read=await GET(new NextRequest('https://dazl.test/api/leads/play-research?job_id='+ 'a'.repeat(24)));assert.equal(read.status,200);assert.deepEqual((await read.json()).research,[])
 assert.equal((db.prepare('SELECT count(*) n FROM play_research_sources').get() as {n:number}).n,0)
 assert.equal((db.prepare('SELECT count(*) n FROM leads').get() as {n:number}).n,0)
 }finally{db.close()}
})
