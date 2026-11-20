import test from 'node:test'
import assert from 'node:assert/strict'
import { proveReciprocalCompanySite, readReciprocalOwnedPosting, type ReciprocalSiteAuthority } from '../lib/company-first/company-first-reciprocal-site.ts'
import type { ObservedSafeGet } from '../lib/sources/http.ts'

const scope={tenant:'fixture-tenant',job:'fixture-job',attempt:'1'}
const employer='Example Employer'
const posting='https://job-boards.greenhouse.io/example-board/jobs/244'
const api='https://boards-api.greenhouse.io/v1/boards/example-board/jobs/244'
const owned='https://example-employer.example/'
const robots=owned+'robots.txt'
const candidate={name:employer,hintUrl:posting}
const html=(link=posting,name=employer)=>'<html><head><title>'+employer+'</title></head><body><h1>'+name+'</h1><a href="'+link+'">Open job</a></body></html>'
type Mode='ok'|'unsettled'|'wrong_id'|'wrong_org'|'vendor_default'|'wrong_query'|'wrong_link'|'same_name_hostile'|'alias'|'hidden'|'robots'|'redirect'|'stale'
async function fixture(mode:Mode){
  const events:string[]=[]
  const expiry=Date.now()+40_000
  let lost=false
  const wire:ObservedSafeGet=async url=>{
    events.push('read:'+url)
    const data={status:200,complete:true,finalUrl:url,contentEncoding:'identity'}
    if(url===api)return {...data,contentType:'application/json',body:JSON.stringify({
      id:mode==='wrong_id'?245:244,title:'Current organization job posting',company_name:mode==='wrong_org'?'Unrelated Organization':employer,
      absolute_url:mode==='vendor_default'?posting:owned+'careers?gh_jid='+(mode==='wrong_query'?'245':'244'),
    })}
    if(url===robots)return {...data,status:mode==='robots'?200:404,contentType:'text/plain',body:mode==='robots'?'User-agent: dazl\nDisallow: /\n':''}
    assert.equal(url,owned)
    if(mode==='redirect')return {...data,status:302,contentType:'text/html',body:'',location:'https://other-employer.example/'}
    if(mode==='stale')lost=true
    return {...data,contentType:'text/html',body:mode==='wrong_link'?html(posting.replace('/244','/245')):
      mode==='same_name_hostile'?html(posting.replace('example-board','other-board')):
      mode==='alias'?html(posting,'Alias instead of employer name'):
      mode==='hidden'?html().replace('<a href','<a aria-hidden="&#116;rue" href'):html()}
  }
  const auth:ReciprocalSiteAuthority={
    async readCurrentNativePosting(s,c){
      assert.deepEqual(s,scope);assert.deepEqual(c,candidate)
      return lost||mode==='unsettled'?null:{scope,candidateName:employer,exactPostingUrl:posting,expiresAtMs:expiry,settledCallId:'safe-1'}
    },
    async reserveCurrentRead(r){
      assert.deepEqual(r.scope,scope);assert.equal(r.settledCallId,'safe-1')
      events.push('reserve:'+r.exactUrl);return true
    },
  }
  return {events,out:await proveReciprocalCompanySite({enabled:true,signal:new AbortController().signal},scope,candidate,auth,wire)}
}

test('exact settled Greenhouse detail reciprocal homepage link yields website only',async()=>{
  const f=await fixture('ok')
  assert.equal(f.out.state,'verified')
  if(f.out.state==='verified'){
    assert.equal(readReciprocalOwnedPosting(f.out.site,scope)?.literalPostingHref,f.out.site.posting?.postingUrl)
    assert.equal(readReciprocalOwnedPosting({...f.out.site},scope),null)
    assert.equal(readReciprocalOwnedPosting(f.out.site,{...scope,attempt:'other'}),null)
    assert.equal(f.out.site.website,new URL(owned).origin)
    assert.equal(f.out.site.identitySource,owned)
    assert.deepEqual(f.out.site.posting,{linkSource:owned,postingUrl:posting})
    assert.ok(!('place' in f.out.site)&&!('buyer' in f.out.site)&&!('ready' in f.out))
  }
  assert.deepEqual(f.events,[api,robots,owned].flatMap(x=>['reserve:'+x,'read:'+x]))
})
test('wrong or unsettled exact publisher record cannot cause an owned read',async()=>{
  for (const mode of ['unsettled','wrong_id','wrong_org','vendor_default','wrong_query'] as const){
    const f=await fixture(mode)
    assert.equal(f.out.state,'held',mode)
    assert.deepEqual(f.events,mode==='unsettled'?[]:['reserve:'+api,'read:'+api],mode)
  }
})
test('wrong link, same-name board, alias, hidden backlink, robots, stale and redirect do not establish ownership',async()=>{
  for (const mode of ['wrong_link','same_name_hostile','alias','hidden','robots','redirect','stale'] as const){
    const f=await fixture(mode)
    assert.equal(f.out.state,'held',mode)
    assert.ok(!f.events.some(x=>x.includes('other-employer')),mode)
    if(mode==='robots')assert.ok(!f.events.includes('read:'+owned))
  }
})
