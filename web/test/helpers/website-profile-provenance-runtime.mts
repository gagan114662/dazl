import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { POST as estimate } from '../../app/api/scan/estimate/route.ts'
import { POST as scan } from '../../app/api/scan/route.ts'
import { GET as status } from '../../app/api/scan/status/route.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { issueWebsiteDraftReceipt } from '../../lib/scan/website-profile-provenance.ts'
import { setScanDb,setUser } from './tenant-route-db.ts'

test('normal estimate and scan require exact website review plus price approval; job status confirms only the matched atomic row',async()=>{
  const db=new Database(':memory:');migrateAllSqlite(db);setScanDb(db)
  try {
    const tenant='site-fixture', actor='reviewer', saved='Fixture old profile'
    const key=randomBytes(32);process.env.DAZL_MASTER_KEY=key.toString('base64')
    db.prepare("INSERT INTO users (id,email,business_name,password_hash,salt,sells,buyer_profile) VALUES (?,'site@fixture.example','Fixture','x','y','Former offer',?)").run(tenant,saved)
    saveKey(db,tenant,'anthropic','sk-ant-fixture',key)
    setUser({id:tenant,actorId:actor,business_name:'Fixture'})
    let ip=1
    const req=(path:string,body:unknown)=>new NextRequest('http://localhost'+path,{method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json',host:'localhost',origin:'http://localhost','x-forwarded-for':`10.14.0.${ip++}`}})
    const origin=issueWebsiteDraftReceipt(key,{tenantId:tenant,actorId:actor},'https://fixture.example/about')
    const body={mode:'website_profile_review_v1',query:'Find company operators with evidence',offer:'New confirmed fixture offer',reviewed:true,
      icp:{summary:'Operators with a dated signal',who:['Operators'],industries:[],where:[],sizes:[],signals:[],exclude:[],
        research:{v:1,site:'fixture.example',offers:[{i:'fixture',n:'New confirmed fixture offer'}],hyps:[],q:null,ans:null}}}
    const quote=await estimate(req('/api/scan/estimate',{...body,website_draft_receipt:origin}))
    assert.equal(quote.status,200,await quote.clone().text())
    const {estimate:cost,website_approval_receipt:receipt}=await quote.json()
    assert.equal(typeof receipt,'string')
    assert.equal((await scan(req('/api/scan',{...body,offer:'Other choice',website_approval_receipt:receipt,estimate_ack:cost.ack}))).status,409)
    assert.equal((await scan(req('/api/scan',{...body,website_approval_receipt:receipt}))).status,409)
    assert.equal(db.prepare('SELECT count(*) FROM scan_jobs').pluck().get(),0)
    const accepted=await scan(req('/api/scan',{...body,website_approval_receipt:receipt,estimate_ack:cost.ack}))
    assert.equal(accepted.status,202,await accepted.clone().text())
    const {job_id}=await accepted.json()
    const shown=await status(new NextRequest('http://localhost/api/scan/status?readonly=1&job_id='+job_id))
    assert.equal((await shown.json()).website_profile_review,'confirmed')
    assert.equal(db.prepare('SELECT buyer_profile FROM users WHERE id=?').pluck().get(tenant),saved)
  } finally{ db.close() }
})
