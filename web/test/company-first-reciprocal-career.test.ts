import test from 'node:test'
import assert from 'node:assert/strict'
import { proveReciprocalCompanySite, type ReciprocalSiteAuthority } from '../lib/company-first/company-first-reciprocal-site.ts'
import { verifyReciprocalOwnedCareerSignal } from '../lib/company-first/company-first-career-schema.ts'
import { companyFirstPublicReader } from '../lib/company-first/company-first-public-reader.ts'
import type { ObservedSafeGet } from '../lib/sources/http.ts'

const scope={tenant:'fixture-tenant',job:'fixture-job',attempt:'1'}
const employer='Example Employer', title='Sales Development Representative'
const posting='https://job-boards.greenhouse.io/example-board/jobs/244'
const api='https://boards-api.greenhouse.io/v1/boards/example-board/jobs/244'
const origin='https://example-employer.example', home=origin+'/', permalink=origin+'/careers/purchasing-director'
const date='2026-11-19', from='2026-11-17', through='2026-11-20'
const local={locality:'Example Locality',region:'Example Region',country:'Example Country'}
const signal=new AbortController().signal
const clock=()=>Date.parse('2026-11-20T12:00:00Z')
type Variant='ok'|'wrong_place'|'wrong_date'|'wrong_title'|'wrong_route'|'redirect'|'expired_ats'|'invalid_ats'|'hidden_date'|'no_employer_quote'|'embed'
async function run(variant:Variant){
 const events:string[]=[]
 const exactDate=variant==='wrong_date'?'2026-11-18':date
 const exactTitle=variant==='wrong_title'?'Senior Procurement Operations Director':title
 const locality=variant==='wrong_place'?'Another Locality':local.locality
 const wire:ObservedSafeGet=async url=>{
  events.push('read:'+url)
  const common={status:200,complete:true,finalUrl:url,contentEncoding:'identity'}
  if(url===api)return {...common,contentType:'application/json',body:JSON.stringify({
   id:244,title,company_name:employer,absolute_url:variant==='embed'?permalink+'?gh_jid=244':permalink,
   first_published:date+'T12:00:00Z',application_deadline:variant==='expired_ats'?'2020-01-01T00:00:00Z':variant==='invalid_ats'?'unknown':null,
  })}
  if(url===origin+'/robots.txt')return {...common,status:404,contentType:'text/plain',body:''}
  if(url===home)return {...common,contentType:'text/html',body:'<!doctype html><html><head><title>'+employer+'</title></head><body><h1>'+employer+'</h1><a href="'+posting+'">Open job</a></body></html>'}
  assert.equal(url,permalink)
  const job={'@context':'https://schema.org','@type':'JobPosting',url,title:exactTitle,datePosted:exactDate,
   hiringOrganization:{'@type':'Organization',name:employer,url:home},jobLocation:{'@type':'Place',
    address:{'@type':'PostalAddress',addressLocality:locality,addressRegion:local.region,addressCountry:local.country}}}
  const body='<!doctype html><html><head><script type="application/ld+json">'+JSON.stringify(job)+'</script></head><body>'+
    '<h1>'+exactTitle+'</h1>'+(variant==='no_employer_quote'?'':'<p>As a '+exactTitle+' at '+employer+" you'll help buyers.</p>")+'<p>'+employer+'</p><p>'+locality+'</p><p>'+local.region+'</p><p>'+local.country+
    '</p><p'+(variant==='hidden_date'?' hidden':'')+'>Posted '+exactDate+'</p></body></html>'
  return {...common,contentType:'text/html',body,...(variant==='redirect'?{status:302,location:origin+'/careers/different'}:{})}
 }
 const expiry=Date.now()+45_000
 const authority:ReciprocalSiteAuthority={
  async readCurrentNativePosting(s,c){assert.deepEqual(s,scope);assert.equal(c.hintUrl,posting)
   return {scope,candidateName:employer,exactPostingUrl:posting,expiresAtMs:expiry,settledCallId:'current-fixture-call'}},
  async reserveCurrentRead(r){assert.equal(r.settledCallId,'current-fixture-call');events.push('reserve:'+r.exactUrl);return true},
 }
 const site=await proveReciprocalCompanySite({enabled:true,signal},scope,{name:employer,hintUrl:posting},authority,wire)
 if(site.state==='held'&&(variant==='expired_ats'||variant==='invalid_ats'))return {proof:null,events}
 assert.equal(site.state,'verified')
 if(site.state!=='verified')throw Error('reciprocal proof held')
 const reader=companyFirstPublicReader(scope,{async isCurrent(){return true},async reserveCurrentRead(r){
  assert.deepEqual(r.scope,scope);events.push('reserve:'+r.exactUrl);return true}},wire)
 const proof=await verifyReciprocalOwnedCareerSignal(scope,site.site,{companyKey:site.site.companyKey,websiteOrigin:origin,
  postingUrl:variant==='wrong_route'?posting.replace('/244','/245'):posting, place:local.locality,event:'hiring_posting',from,through},
  reader.readCareerHtml,{role:x=>x===title,place:x=>JSON.stringify(x)===JSON.stringify(local)},signal,clock)
 return {proof,events}
}
test('exact issued publisher permalink with same visible title and date yields only owned dated proof',async()=>{
 const {proof,events}=await run('ok')
 assert.equal(proof?.sourceUrl,permalink)
 assert.equal(proof?.quote,'As a '+title+' at '+employer+" you'll help buyers.")
 assert.deepEqual(proof?.dateProof,{kind:'first_party_event_date',sourceUrl:permalink,day:date,literalDate:'Posted '+date})
 for(let i=0;i<events.length;i+=2)assert.equal(events[i],events[i+1].replace('read:','reserve:'))
})
for(const variant of ['wrong_place','wrong_date','wrong_title','redirect','hidden_date','no_employer_quote','embed','wrong_route','expired_ats','invalid_ats'] as const)
 test('withholds '+variant,async()=>{const {proof,events}=await run(variant);assert.equal(proof,null);if(['wrong_route','embed','expired_ats','invalid_ats'].includes(variant))assert.ok(!events.includes('read:'+permalink))})
