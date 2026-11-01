import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateSellerDecisions } from '../lib/scan/intelligence-schema.ts'
import { migrateScan, createQueryJob, captureSellerDecisions } from '../lib/scan/store.ts'
import { assembleDecisionPack, decisionRows, recallSellerDecisions, reuseSellerDecisions, siteKey, writeSellerDecisions, RECALL_LIMIT, type SellerDecision } from '../lib/scan/intelligence.ts'
import { budgetedIcp, type Icp } from '../lib/scan/icp.ts'
import { bothEngines } from './helpers/engines.ts'
const profile = (): Icp => ({ summary: 'Buyer search', who: ['clinic managers'], industries: [], sizes: [], where: [], signals: [], exclude: [], research: {v:1,site:'seller.example',offers:[{i:'booking',n:'Booking'},{i:'payroll',n:'Payroll'}],q:null,ans:null,hyps:[{i:'booking:persona:1',o:'booking',k:'persona',t:'clinic managers',s:'reviewed',u:'https://seller.example/customers',q:'Our customers include clinics',at:1700000000}]}})
const scope = {tenant:'A',actor:'actor-a',job:'job-1',now:1800000000000}
const rows = (action: 'confirm'|'reject'='confirm', job='job-1', now=scope.now) => {
  const p=profile(); if(action==='reject')p.who=[]
  return decisionRows([{offer:'booking',hypothesis:'booking:persona:1',action}],p.research,{...scope,job,now},p)
}
test('no implicit learning: model/status/legacy profile is not an explicit actor decision',()=>{
 assert.deepEqual(decisionRows(undefined,profile().research,scope),[])
 assert.throws(()=>decisionRows([{offer:'payroll',hypothesis:'booking:persona:1',action:'confirm'}],profile().research,scope))
 assert.throws(()=>decisionRows([{offer:'booking',hypothesis:'booking:persona:1',action:'reject'}],profile().research,scope,profile()))
 assert.equal(rows()[0].actor_id,'actor-a'); assert.equal(rows()[0].tenant_id,'A')
})
test('site identity never merges unrelated subdomains or credentialed URLs',()=>{
 assert.equal(siteKey('https://www.seller.example/a'),'seller.example')
 assert.equal(siteKey('https://store.seller.example'),'store.seller.example')
 assert.equal(siteKey('https://user:pass@seller.example'),null)
})
test('scope, supersession, rejection precedence, historical proof and multi-offer targeting',()=>{
 const newer=rows('reject','job-2',scope.now+1)[0], old=rows()[0]
 const foreign={...old,id:'foreign',tenant_id:'B'}
 const pack=assembleDecisionPack([foreign,newer,old],'A','seller.example')
 assert.deepEqual(pack.trace.selected,[newer.id]); assert.deepEqual(pack.trace.superseded,[old.id])
 const out=reuseSellerDecisions(profile(),pack,'Booking')
 assert.deepEqual(out.who,[]); assert.equal(out.research!.hyps[0].s,'rejected'); assert.equal(out.research!.hyps[0].q,null)
 assert.deepEqual(reuseSellerDecisions(profile(),pack,'Payroll').who,['clinic managers'],'another offer cannot change the flat draft')
 assert.deepEqual(reuseSellerDecisions(profile(),pack,'Ambiguous').who,['clinic managers'])
 const other=profile();other.research!.site='other.example';assert.deepEqual(reuseSellerDecisions(other,pack,'Booking'),other)
})
test('explicit restore supersedes rejection, fresh model cannot overrule it; changed model IDs cannot resurrect rejected text',()=>{
 const reject=rows('reject','job-1',scope.now)[0], restore=rows('confirm','job-2',scope.now+2)[0]
 const p=profile(); p.who=[]
 assert.deepEqual(reuseSellerDecisions(p,assembleDecisionPack([restore,reject],'A','seller.example'),'Booking').who,['clinic managers'])
 const changed=profile();changed.research!.hyps[0].i='new-model-id'
 assert.deepEqual(reuseSellerDecisions(changed,assembleDecisionPack([reject],'A','seller.example'),'Booking').who,[])
})
test('bounded recall advertises omitted history rather than pretending complete memory',()=>{
 const many=Array.from({length:RECALL_LIMIT+1},(_,i)=>({...rows()[0],id:`id-${i}`,hypothesis_id:`h-${i}`,text:`buyer ${i}`}))
 const pack=assembleDecisionPack(many,'A','seller.example')
 assert.equal(pack.trace.truncated,true);assert.ok(Buffer.byteLength(JSON.stringify(pack.decisions))<13000)
})
test('atomic scan creation and decisions rollback together; full decisions survive a dropped working projection',()=>{
 const raw=new Database(':memory:');migrateScan(raw)
 const p=profile();p.signals=Array(8).fill('x'.repeat(160));p.summary='x'.repeat(300);p.industries=Array(6).fill('x'.repeat(160))
 const fitted=budgetedIcp(p);assert.ok(fitted.ok)
 assert.throws(()=>raw.transaction(()=>{createQueryJob(raw,'A',{id:'bad',query:'buyers'});captureSellerDecisions(raw,rows('confirm','bad'));throw Error('fail')})())
 assert.equal((raw.prepare('SELECT count(*) n FROM scan_jobs').get() as {n:number}).n,0)
 assert.equal((raw.prepare('SELECT count(*) n FROM seller_decisions').get() as {n:number}).n,0)
 raw.transaction(()=>{createQueryJob(raw,'A',{id:'good',query:'buyers',icp:fitted.ok?fitted.json:null});captureSellerDecisions(raw,rows('confirm','good'))})()
 assert.equal((raw.prepare('SELECT count(*) n FROM seller_decisions').get() as {n:number}).n,1);raw.close()
})
bothEngines('seller decision durable recall after unrelated play, foreign tenant excluded before candidate limit',async({db})=>{
 await writeSellerDecisions(db,rows())
 const foreign=Array.from({length:130},(_,i)=>({...rows()[0],id:`foreign-${i}`,tenant_id:'B',job_id:`foreign-${i}`,created_at:scope.now+i+10}))
 await writeSellerDecisions(db,foreign)
 let pack=await recallSellerDecisions(db,'A','seller.example')
 assert.equal(pack.decisions.length,1);assert.equal(pack.trace.truncated,false)
 await writeSellerDecisions(db,rows('reject','job-2',scope.now+100))
 pack=await recallSellerDecisions(db,'A','seller.example')
 assert.equal(pack.decisions[0].action,'reject');assert.equal(pack.trace.superseded.length,1)
 assert.equal((await recallSellerDecisions(db,'A','other.example')).decisions.length,0)
 await assert.rejects(writeSellerDecisions(db,rows()),/UNIQUE|duplicate/i,'duplicate replay cannot silently mutate an earlier decision')
})

test('same statement with a changed model ID cannot be reconfirmed by an older positive decision',()=>{
 const confirm=rows()[0], reject={...rows('reject','job-new',scope.now+20)[0],hypothesis_id:'regenerated-id'}
 const pack=assembleDecisionPack([reject,confirm],'A','seller.example')
 assert.equal(pack.decisions.length,1)
 assert.deepEqual(reuseSellerDecisions(profile(),pack,'Booking').who,[])
})

test('edited offer text is annotation-only, never a fuzzy buyer transplant',()=>{
 const p=profile();p.who=[]
 const out=reuseSellerDecisions(p,assembleDecisionPack(rows(),'A','seller.example'),'Booking with consulting')
 assert.deepEqual(out.who,[])
 assert.equal(out.research!.hyps[0].s,'reviewed')
})
