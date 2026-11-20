import test from 'node:test'
import assert from 'node:assert/strict'
import { createCanonicalAtsSignal,type CanonicalAtsBinding } from '../lib/company-first/company-first-canonical-ats-signal.ts'
import type { ObservedSafeGet } from '../lib/sources/http.ts'

const scope={tenant:'fixture-tenant',job:'fixture-job',attempt:'1'}
const websiteOrigin='https://company.example',postingUrl='https://job-boards.greenhouse.io/fixture/jobs/111'
const api='https://boards-api.greenhouse.io/v1/boards/fixture/jobs/111'
const company='Example Manufacturing'
const today=new Date().toISOString().slice(0,10)
const input={companyKey:'company-key',websiteOrigin,postingUrl,place:'canonical-place',event:'hiring_posting',from:'2000-01-01',through:today}
const title='Technical Account Executive'
const expiry=Date.now()+40_000
function fixture(mode:'ok'|'wrong_link'|'wrong_role'|'wrong_place'|'stale'|'bad_canonical_quote'|'wrong_url'|'lost'|'closed'|'invalid_deadline'|'valid_deadline'|'no_deadline'='ok'){
 let reads=0,reserves=0,reviews=0
 const binding:CanonicalAtsBinding={
   approvedRoleKey:'approved-role',
   async readCurrentOwnedLink(){reviews++;if(mode==='lost'&&reviews===2)return null
     return {scope,companyKey:input.companyKey,companyName:company,websiteOrigin,version:'review-exact',expiresAtMs:expiry,kind:'observed_owned_link',
       linkSource:websiteOrigin+'/careers',literalPostingHref:mode==='wrong_link'?postingUrl.replace('/111','/121'):postingUrl}},
   async reserveCurrentPublisherRead(r){reserves++;assert.equal(r.exactUrl,api);assert.equal(r.reviewVersion,'review-exact');return true},
   matchesRole:(key,t)=>key==='approved-role'&&(mode==='bad_canonical_quote'||t===title)&&mode!=='wrong_role',
   matchesPlace:(key,p)=>key===input.place&&p.literal==='Explicit Region'&&mode!=='wrong_place',
 }
 const wire:ObservedSafeGet=async url=>{reads++;assert.equal(url,api);return {status:200,complete:true,finalUrl:mode==='wrong_url'?api+'/ghost':api,
   contentType:'application/json',contentEncoding:'identity',body:JSON.stringify({
     id:111,company_name:company,title:mode==='bad_canonical_quote'?'………………——————++++++++':title,
     first_published:mode==='stale'?'2020-01-01T00:00:00Z':today+'T00:00:00Z',location:{name:'Explicit Region'},
     application_deadline:mode==='closed'?'2020-01-01T00:00:00Z':mode==='invalid_deadline'?'2099-02-30T00:00:00Z':mode==='valid_deadline'?'2099-01-01T00:00:00+00:00':mode==='no_deadline'?null:undefined,
   })}}
 return {run:()=>createCanonicalAtsSignal(scope,binding,wire)({input,signal:new AbortController().signal}),counts:()=>[reserves,reads,reviews]}
}
test('actual ATS and canonical scan verifier accept one exact current record, not Ready',async()=>{
 const f=fixture(),r=await f.run()
 assert.ok(r)
 assert.equal(r.sourceUrl,postingUrl);assert.equal(r.date,today);assert.equal(r.dateProof.kind,'ats_first_published')
 assert.deepEqual(f.counts(),[1,1,2])
 assert.ok(!('ready' in r)&&!('contact' in r))
})
test('wrong, stale, unbound and canonical quote veto hold; no extra reads or fallback',async()=>{
 for(const mode of ['wrong_link','wrong_role','wrong_place','stale','bad_canonical_quote','wrong_url','lost'] as const){
   const f=fixture(mode)
   assert.equal(await f.run(),null,mode)
   assert.equal(f.counts()[1],mode==='wrong_link'?0:1,mode)
 }
})

test('current posting with closed or malformed non-null deadline holds, but null or future does not',async()=>{
 for(const mode of ['closed','invalid_deadline'] as const){
   const f=fixture(mode)
   assert.equal(await f.run(),null,mode)
   assert.equal(f.counts()[1],1)
 }
 for(const mode of ['valid_deadline','no_deadline'] as const)assert.ok(await fixture(mode).run(),mode)
})
