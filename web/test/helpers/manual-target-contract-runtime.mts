import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { POST } from '../../app/api/scan/route.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { isFirst5NativeSearchRequest } from '../../lib/scan/qa-provider-policy.ts'

const master = randomBytes(32)
Object.assign(process.env,{DAZL_MASTER_KEY:master.toString('base64'), NEWS_SEARCH_ENABLED:'0',LEAD_ENGINE:'',TINYFISH_API_KEY:'',DAZL_SCAN_CAP_CAD:'5',DAZL_SCAN_CAP_FX_CAD_PER_USD:'1.50'})
globalThis.fetch = async u => { throw Error(`unexpected fixture network: ${String(u)}`) }
const tenant='workspace'
const budget={web_search:'anthropic_estimated_v1',target_review:'manual_v1'}
const q='Find roofing contractors opening a branch'
const offer='Scheduling software'
const dismissed='Residential roofers', oldPositive='Repairs managers'
const research={v:1,site:'example.test',q:null,ans:null,offers:[{i:'o1',n:offer}],hyps:[
  {i:'r1',o:'o1',k:'persona',t:dismissed,s:'rejected',u:null,q:null,at:null},
  {i:'p1',o:'o1',k:'persona',t:oldPositive,s:'reviewed',u:null,q:null,at:null},
]}
const icp={summary:'Roofing contractors',who:['Operations leaders'],where:['Illinois'],country:'US',industries:['Roofing'],signals:['Opened a branch'], sizes:['Small'],exclude:['Franchises'],window_days:90,language:'en',research}
const post=(body:unknown)=>POST(new NextRequest('http://localhost/api/scan',{method:'POST',headers:{'content-type':'application/json',host:'localhost','x-forwarded-for':'10.0.4.1'},body:JSON.stringify(body)}))
const manual={query:q,offer,mode:'first5',budget,icp}

test('manual target contract: no replay of old research actions, previous exact rejection enforced and accepted scope equals stored scope',async()=>{
  const db=new Database(':memory:'); migrateAllSqlite(db); setScanDb(db); setUser({id:tenant,business_name:'Workspace'})
  saveKey(db,tenant,'anthropic','sk-ant-offline-AAAAAAAAAAAAAAAAAAAAAAAAAAAA',master)
  try {
    assert.equal(isFirst5NativeSearchRequest('first5',budget),true)
    assert.equal(isFirst5NativeSearchRequest('first5',{...budget,extra:true}),false)
    const conflict=await post({...manual,icp:{...icp,who:[dismissed]}})
    assert.equal(conflict.status,409); assert.equal((await conflict.json()).error,'target_review_conflict')
    const replay=await post({...manual,research_decisions:[{hypothesis:'p1',offer:'o1',action:'confirm'}]})
    assert.equal(replay.status,400); assert.equal((await replay.json()).error,'invalid_target_review')
    assert.equal((await post({...manual,reviewed:true})).status,400)
    assert.equal((await post({...manual,icp:null})).status,400)
    const counts=()=>['scan_jobs','seller_decisions','scan_spend_calls'].map(table=>(db.prepare('SELECT count(*) n FROM '+table).get() as {n:number}).n)
    assert.deepEqual(counts(),[0,0,0])
    const accepted=await post(manual), result=await accepted.json()
    assert.equal(accepted.status,202,JSON.stringify(result))
    const row=db.prepare('SELECT query,icp FROM scan_jobs WHERE id=?').get(result.job_id) as {query:string,icp:string}
    const {research:storedResearch,...storedTarget}=JSON.parse(row.icp)
    assert.deepEqual(result.accepted_target,{query:row.query,...storedTarget})
    assert.deepEqual(storedTarget.who,['Operations leaders'])
    assert.equal(storedResearch.hyps.find((h:{i:string})=>h.i==='p1').s,'reviewed')
    assert.equal(storedResearch.hyps.find((h:{i:string})=>h.i==='r1').s,'rejected')
    assert.deepEqual(counts(),[1,0,0])
  } finally { db.close() }
})
