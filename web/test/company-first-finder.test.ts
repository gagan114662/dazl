import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runCompanyFirstFinder, type CompanyFirstFinderPorts } from '../lib/company-first/company-first-pipeline.ts'
import type { CompanySizeFact } from '../lib/company-first/company-first-evidence.ts'

const scope = { tenant: 'fixture-tenant', job: 'fixture-job', attempt: '1' }
const criteria = { category: 'service-category', place: 'bound-location', event: 'active-event', from: '2026-11-01', through: '2026-11-20' }
const name = 'Example Business', buyer = 'Leslie Example', title = 'Purchasing Director'
const origin = 'https://fictional.example', posting = origin + '/careers/open-role'
const bioUrl = origin + '/team/leslie-example', linkedin = 'https://www.linkedin.com/in/leslie-fixture'
const address = 'leslie.example@fictional.example'
const literal = 'The exact current hiring event appears on this page.'
const dateLiteral = 'November 13, 2026', date = '2026-11-13'
function fixture(mode: 'ok'|'wrong_gate'|'wrong_source'|'wrong_quote'|'wrong_bio'|'held'|'uncertain'|'aborted') {
  const calls: string[] = []
  let settled = true
  let reserved = false
  const current = async () => settled
  const reserve = async (stage:string) => { if (!settled) return false; calls.push('reserve:'+stage); reserved = true; return true }
  const io = (stage: string) => { assert.ok(reserved, stage); reserved = false; calls.push(stage) }
  const ports: CompanyFirstFinderPorts = {
    isCurrentAndSettled: current,
    evidence: {
      isCurrent: current,
      reserveBeforeDispatch:r=>reserve(r.stage),
      async discover() { io('discover'); return [{name}] },
      async verifyWebsite() { io('website'); return {status:'verified',companyKey:'same-company',candidateName:name,website:origin,identitySource:origin+'/about'} },
      async verifyDatedSignal() { io('signal'); return { companyKey:'same-company',place:criteria.place,event:criteria.event,
        date,sourceUrl:posting,quote:literal,literalSourceText:literal+' '+dateLiteral,
        dateProof:{kind:'first_party_event_date',sourceUrl:posting,day:date,literalDate:dateLiteral} } },
    },
    contact: {
      isCurrent: current,
      reserveBeforeDispatch:r=>reserve(r.stage),
      async readDirectory() { io('directory'); if (mode==='uncertain') {settled=false; throw Error('unknown charge')}
        return {url:origin+'/team',navigation:{sourceUrl:origin+'/about',linkedUrl:origin+'/team'},people:mode==='held'?[]:[{name:buyer,title,bioUrl}]} },
      async readBio() { io('bio'); return {url:bioUrl,name:buyer,title,company:name,text:buyer+'\n'+title+'\nWork email: '+address,profiles:[{url:linkedin,named:buyer}],publications:[{address,named:buyer,literalLine:'Work email: '+address}]} },
      async corroborateProfile() { io('profile'); return {url:linkedin,name:buyer,title,company:name,current:true} },
    },
    async checkExistingHolds() { calls.push('gate'); return {scope:mode==='wrong_gate'?{...scope,attempt:'0'}:scope,
      companyKey:'same-company',website:origin,identitySource:origin+(mode==='wrong_source'?'/other-identity':'/about'),
      event:criteria.event,eventSource:posting,eventDate:date,literalQuote:mode==='wrong_quote'?'A different claim from this source.':literal,
      person:buyer,title,buyerBio:mode==='wrong_bio'?origin+'/team/other':bioUrl,linkedIn:linkedin,email:address,emailSource:bioUrl,verdict:'ready'} },
  }
  return {ports,calls}
}
test('flag-off and already-aborted paths make no network or paid calls',async()=>{
 const x=fixture('ok')
 assert.equal((await runCompanyFirstFinder({enabled:false},scope,criteria,[title],x.ports)).state,'disabled')
 assert.equal((await runCompanyFirstFinder({enabled:true,signal:AbortSignal.abort()},scope,criteria,[title],x.ports)).state,'superseded_or_unsettled')
 assert.deepEqual(x.calls,[])
})
test('exact observed signal before person and a complete currently bound final receipt',async()=>{
 const {calls,ports}=fixture('ok')
 const got=await runCompanyFirstFinder({enabled:true},scope,criteria,[title],ports)
 assert.equal(got.ready.length,1)
 assert.equal(got.ready[0].contact.published.address,address)
 assert.equal(got.observed?.ready_returned,1)
 assert.equal(got.observed?.shown,null)
 assert.deepEqual(got.observed?.evidence,{discovered:1,website_verified:1,distinct_sites:1,signals_verified:1,
   dispatches:{discover:1,website:1,signal:1},holds:{}})
 assert.deepEqual(calls,['reserve:discover','discover','reserve:website','website','reserve:signal','signal','reserve:directory','directory','reserve:bio','bio','reserve:profile','profile','gate'])
})
test('valid old gate failure or wrong attempt never exposes a held company, source or identity',async()=>{
 for(const mode of ['held','wrong_gate','wrong_source','wrong_quote','wrong_bio'] as const) {
  const {calls,ports}=fixture(mode)
  const got=await runCompanyFirstFinder({enabled:true},scope,criteria,[title],ports)
  assert.deepEqual(got.ready,[])
  assert.doesNotMatch(JSON.stringify(got),/Leslie|Example Business|fictional/)
  assert.equal(got.observed?.[mode==='held'?'contact_held':'final_held'],1)
  if(mode==='held'){
    assert.equal(calls.includes('gate'),false)
    assert.deepEqual(got.observed?.contact_holds,{buyer_unconfirmed:1})
  }
 }
})
test('uncertain accounting drops output and prevents later provider or gate dispatch', async()=>{
 const {calls,ports}=fixture('uncertain')
 const got=await runCompanyFirstFinder({enabled:true},scope,criteria,[title],ports)
 assert.equal(got.state,'superseded_or_unsettled')
 assert.deepEqual(got.ready,[])
 assert.equal(got.observed,null)
 assert.equal(calls.at(-1),'directory')
})

test('an explicit size target requires two current, independent, range-agreeing company facts before buyer reads',async()=>{
  const observedDay=new Date().toISOString().slice(0,10)
  const one:CompanySizeFact={scope,companyKey:'same-company',sourceUrl:origin+'/annual-filing',datasetKey:'company-filing',
    observedDay,basis:'first_party_disclosure',employees:{min:30,max:60}}
  const two:CompanySizeFact={...one,sourceUrl:'https://official-secondary.example/record/42',datasetKey:'independent-ledger',
    basis:'independent_primary_record',employees:{min:40,max:70}}
  const targeted={...criteria,companySize:{min:20,max:80}}
  for(const [facts,ok] of [
    [[one,two],true],[[one],false],
    [[one,{...two,datasetKey:one.datasetKey}],false],
    [[one,{...two,sourceUrl:'https://data.fictional.example/filing'}],false],
    [[one,{...two,scope:{...scope,attempt:'older'}}],false],
    [[one,{...two,companyKey:'other-business'}],false],
    [[one,{...two,observedDay:'2000-01-01'}],false],
    [[one,{...two,observedDay:'2999-12-31'}],false],
    [[one,{...two,employees:{min:60,max:88}}],false],
    [[one,{...two,employees:{min:61,max:75}}],false],
  ] as const){
    const {ports,calls}=fixture('ok'), original=ports.evidence.verifyDatedSignal
    ports.evidence.verifyDatedSignal=async request=>{
      assert.deepEqual(request.input.companySize,targeted.companySize)
      const observed=await original(request)
      return observed?{...observed,companySizeFacts:facts}:null
    }
    const got=await runCompanyFirstFinder({enabled:true},scope,targeted,[title],ports)
    assert.equal(got.ready.length,ok?1:0)
    assert.equal(calls.includes('directory'),ok)
    if(!ok)assert.deepEqual(got.observed?.evidence?.holds,{size_unconfirmed:1})
    assert.doesNotMatch(JSON.stringify(got),/secondary|company-filing|independent-ledger/)
  }
})
