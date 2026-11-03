// Original349 full records, synthetic leads and fenced providers only. No live eligibility changes.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { qualifyPreview } from '../lib/scan/qualify-preview.ts'
import { runQualification, storedQualifications } from '../lib/scan/qualify-run.ts'
import { DEFAULT_LIMITS } from '../lib/scan/lead-qualify.ts'
const SAVED = "We sell appointment booking and reminder software to independent dental practices in New York City."
const LONDON = "Find B2B SaaS startups in London, UK that raised seed funding or are hiring their first sales representative in the last 90 days. We sell CRM setup and outbound sales consulting. Exclude agencies, directories and companies outside the UK. Show dated source evidence and founder or head of sales contacts."
const DENTAL = "Find independent dental practices in New York City with 1\u20135 locations that opened a new location or are hiring a receptionist in the last 90 days. We sell appointment booking and reminder software. Exclude large chains, vendors, directories, and practices outside NYC. Show the dated evidence and an owner or practice manager contact."
const CRM='CRM setup and outbound sales consulting', MODEL='claude-sonnet-4-5', L='a'.repeat(24), D='b'.repeat(24)
function setup(chosen=true){
 const db=new Database(':memory:');migrateScan(db)
 db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,sells TEXT,website TEXT)');db.prepare('INSERT INTO users VALUES (?,?,?)').run('u1',SAVED,'')
 const jobs=[]
 for(const[id,query]of [[L,LONDON],[D,DENTAL]]){
  const job=createQueryJob(db,'u1',{query});jobs.push(job)
  db.prepare("UPDATE scan_jobs SET status='running',seller=?,offer=? WHERE id=?").run(SAVED,id===L&&chosen?CRM:null,job)
  if(id===L)db.prepare('UPDATE scan_jobs SET icp=? WHERE id=?').run(JSON.stringify({summary:'B2B SaaS startups in London, UK that raised seed funding or are hiring their first sales representative in the last 90 days.',industries:['B2B SaaS'],where:['London, UK']}),job)
  db.prepare('INSERT INTO leads(id,scan_job_id,company,signal,source_url,review_reason) VALUES (?,?,?,?,?,?)').run(id,job,'Acme','Raised seed funding','https://acme.example/news','counterparty_signal')
 }
 return{db,jobs}
}
const fetchPage=async()=>({text:'Acme raised seed funding and runs outbound sales.',title:'t',retrievedAt:1})
const preview=(db:Database.Database,id=L,fetcher=fetchPage)=>qualifyPreview(db,'u1',id,SAVED,fetcher,'anthropic',MODEL)
const approval=(p:NonNullable<Awaited<ReturnType<typeof preview>>>)=>({approved_by_user:true as const,vendor:'anthropic',model:MODEL,max_usd_estimate:p.cost!.usd_estimate_max!,prompt_sha256:p.prompt_sha256!,request_context_sha256:p.packing!.context_sha256,limits:DEFAULT_LIMITS})
const deps=(p:unknown)=>({enabled:true,sellerText:SAVED,vendor:'anthropic',provider:p as never,apiKey:'synthetic',fetchPage})
test('original London chosen CRM and dental snapshot persist, preview uses their own offer, no lead promotion',async()=>{
 const{db}=setup();const before=db.prepare('SELECT * FROM leads').all()
 const l=await preview(db),d=await preview(db,D)
 assert.equal(l?.input?.seller_offer,CRM);assert.equal(d?.input?.seller_offer,SAVED)
 assert.equal((db.prepare('SELECT sells FROM users').get() as {sells:string}).sells,SAVED)
 assert.deepEqual(db.prepare('SELECT * FROM leads').all(),before)
 assert.equal(await qualifyPreview(db,'other',L,SAVED,fetchPage,'anthropic',MODEL),null)
})
test('unresolved original London conflict refuses before page fetch or provider, no claim',async()=>{
 const{db}=setup(false);let fetches=0,calls=0
 const p=await preview(db,L,async()=>{fetches++;return fetchPage()});assert.equal(p?.ready,false);assert.equal(p?.input,null);assert.match(p!.notes.join(' '),/Choose what this play sells/);assert.equal(fetches,0)
 const result=await runQualification(db,'u1',L,{approved_by_user:true,vendor:'anthropic',model:MODEL,max_usd_estimate:1,prompt_sha256:'f'.repeat(64),limits:DEFAULT_LIMITS},{...deps({completeDetailed:async()=>{calls++;throw Error('no')}}),fetchPage:async()=>{fetches++;return fetchPage()}})
 assert.deepEqual(result,{status:'blocked',reason:'no_evidence'});assert.equal(calls,0);assert.equal(fetches,0);assert.equal(storedQualifications(db,'u1',L).length,0)
})
test('offer change during awaited page reads refuses preview instead of approving stale context',async()=>{
 const{db,jobs}=setup();const p=await preview(db,L,async()=>{db.prepare('UPDATE scan_jobs SET offer=? WHERE id=?').run('Bookkeeping',jobs[0]);return fetchPage()})
 assert.equal(p?.ready,false);assert.equal(p?.input,null);assert.match(p!.notes.join(' '),/changed/)
})
test('changed explicit offer invalidates approval hash before provider and leaves review gates untouched',async()=>{
 const{db,jobs}=setup();const old=await preview(db);assert.ok(old?.ready)
 db.prepare('UPDATE scan_jobs SET offer=? WHERE id=?').run('Bookkeeping',jobs[0]);const current=await preview(db);assert.notEqual(current?.prompt_sha256,old.prompt_sha256)
 let calls=0
 const result=await runQualification(db,'u1',L,approval(old),deps({configuredModel:()=>MODEL,completeDetailed:async()=>{calls++;throw Error('no')}}))
 assert.deepEqual(result,{status:'blocked',reason:'content_mismatch'});assert.equal(calls,0);assert.equal(storedQualifications(db,'u1',L).length,0)
 assert.equal((db.prepare('SELECT review_reason FROM leads WHERE id=?').get(L) as {review_reason:string}).review_reason,'counterparty_signal')
})
test('legacy tenant Memory fallback matches shared play resolver and a concurrent Memory change refuses',async()=>{
 const{db,jobs}=setup();db.exec('CREATE TABLE tenant_memory(tenant_id TEXT PRIMARY KEY,positioning TEXT)')
 db.prepare('UPDATE scan_jobs SET seller=NULL,offer=NULL,query=? WHERE id=?').run('Find companies hiring sales.',jobs[0])
 db.prepare('INSERT INTO tenant_memory VALUES (?,?)').run('u1','Sales consulting')
 const p=await preview(db);assert.equal(p?.input?.seller_offer,'Sales consulting')
 const changed=await preview(db,L,async()=>{db.prepare('UPDATE tenant_memory SET positioning=?').run('Bookkeeping');return fetchPage()})
 assert.equal(changed?.ready,false);assert.equal(changed?.input,null)
})
test('non-schema play context read failure is not silently replaced with global seller',async()=>{
 const{db}=setup();let fetched=0
 const wrapped=new Proxy(db,{get(target,key){if(key==='prepare')return(sql:string)=>{if(sql.startsWith('SELECT offer, seller, query'))throw Error('database locked');return target.prepare(sql)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
 await assert.rejects(preview(wrapped,L,async()=>{fetched++;return fetchPage()}),/database locked/);assert.equal(fetched,0)
})
test('an owned lead with no tenant/snapshot/request offer remains structured not-ready, never404',async()=>{
 const{db,jobs}=setup();db.prepare('UPDATE users SET sells=?').run('');db.prepare('UPDATE scan_jobs SET seller=NULL,offer=NULL,query=? WHERE id=?').run('Find companies hiring sales.',jobs[0])
 const p=await qualifyPreview(db,'u1',L,'',fetchPage,'anthropic',MODEL)
 assert.ok(p);assert.equal(p.ready,false);assert.equal(p.seller_offer_present,false);assert.ok(p.notes.some(n=>/No seller profile/.test(n)))
})
test('legacy auth-profile offer read after sources catches a concurrent shared-profile change',async()=>{
 const{db,jobs}=setup();db.prepare('UPDATE scan_jobs SET seller=NULL,offer=NULL,query=? WHERE id=?').run('Find companies hiring sales.',jobs[0])
 const p=await preview(db,L,async()=>{db.prepare('UPDATE users SET sells=?').run('Bookkeeping');return fetchPage()})
 assert.equal(p?.ready,false);assert.equal(p?.input,null);assert.ok(p?.notes.some(n=>/changed/.test(n)))
})
