import assert from 'node:assert/strict'
import test from 'node:test'
import {prepareDiscovery} from '../lib/company-first/company-first-claude-request.ts'
import {companyHintsFromDynamicSearch} from '../lib/company-first/company-first-discovery-hints.ts'

const seen='https://company.example/about'
const foreign='https://directory.example/list'
const caller={type:'code_execution_20260120',tool_id:'srvtoolu_exec'}
const lane={enabled:true,approvedForPublicDynamicFiltering:true,ownKey:true,model:'claude-sonnet-5-5',apiVersion:'2023-06-01',scope:{caseId:'frozen',attempt:2}}
const scope={tenant:'isolated',job:'frozen',attempt:'2'}
const criteria={category:'Commercial refrigeration',place:'Bergen',event:'Opening a service branch',from:'2026-10-01',through:'2026-11-20'}
const confirmed={lane,scope,criteria,maxUses:2}
const wanted=prepareDiscovery(lane,{companyType:criteria.category,market:criteria.place,intent:criteria.event},2)!
const receipt={id:'receipt1',binding:wanted.binding,reserveMicros:100_000,actualMicros:12_500}
const bot=(...urls:string[])=>[
 {type:'server_tool_use',name:'code_execution',id:'srvtoolu_exec',input:{}},
 {type:'server_tool_use',name:'web_search',id:'srvtoolu_search',caller,input:{query:'NEVER_USED_PRIVATE_QUERY'}},
 {type:'web_search_tool_result',tool_use_id:'srvtoolu_search',caller,content:urls.map(url=>({type:'web_search_result',url,title:'Wrong publisher name',
  page_age:null,encrypted_content:'NEVER_USED_CIPHER'}))},
 {type:'code_execution_tool_result',tool_use_id:'srvtoolu_exec',content:{type:'encrypted_code_execution_result',return_code:0,stderr:'NEVER_USED_ERROR'}},
]
const cite=(url:string)=>({type:'text',text:'{"company":"Fake Company","resultBlock":1,"result":99}',citations:[
 {type:'web_search_result_location',url,title:'False ownership claim',encrypted_index:'NEVER_USED_INDICES',cited_text:'NEVER_USED_QUOTE'},
]})
const response=(content:unknown[]= [...bot(seen),cite(seen)],stop_reason='end_turn')=>({status:200,body:{type:'message',role:'assistant',
 model:'claude-sonnet-5-5',stop_reason,content,usage:{service_tier:'standard',inference_geo:'global',input_tokens:1000,output_tokens:50,
 server_tool_use:{web_search_requests:1,web_fetch_requests:0}}}})
function fixture(){
 const reads:string[]=[]
 let verified=0
 const ports={
  async verifySettledCall(s:typeof scope,c:typeof criteria,p:typeof wanted){verified++;return s.job===scope.job&&c.event===criteria.event&&c.from===criteria.from&&p.binding===wanted.binding},
  async isCurrentAndSettled(){return true},
  allowPublicUrl:(url:string)=>url===seen,
  async readPublicHtml(url:string){reads.push(url);return {url,finalUrl:url,contentType:'text/html' as const,visibleText:'Company information for Nordic Cooling Ltd.',
    jsonLd:[JSON.stringify({'@context':'https://schema.org','@type':'WebPage',url,mainEntity:{'@type':'Organization',name:'Nordic Cooling Ltd',url:'https://do-not-promote.example/'}})]}},
 }
 return {ports,reads,get verified(){return verified}}
}
const signal=()=>new AbortController().signal

test('releases company hints only from guarded exact cited identifier; no model/company-website/intent proof',async()=>{
 const f=fixture(), r=await companyHintsFromDynamicSearch(confirmed,receipt,response([...bot(seen,foreign),cite(seen),cite(foreign)]),f.ports,signal())
 assert.deepEqual(r,{state:'hints',hints:[{name:'Nordic Cooling Ltd',hintUrl:seen}]})
 assert.deepEqual(f.reads,[seen]);assert.equal(f.verified,1)
 assert.doesNotMatch(JSON.stringify(r),/Fake|do-not-promote|NEVER_USED|resultBlock/)
})

test('forged positions, mismatched citations, duplicate URL ambiguity, and direct downgrade do not dispatch',async()=>{
 const f=fixture()
 for(const content of [
  [...bot(seen),cite(foreign)],
  [cite(seen),...bot(seen)],
  [...bot(seen,seen),cite(seen)],
  [...bot(seen),{type:'text',text:'{"resultBlock":2,"result":0,"company":"Forged"}'}],
  [{type:'server_tool_use',name:'web_search',id:'srvtoolu_search',input:{}},
   {...bot(seen)[2],caller:undefined},cite(seen)],
 ]) assert.notEqual((await companyHintsFromDynamicSearch(confirmed,receipt,response(content),f.ports,signal())).state,'hints')
 assert.deepEqual(f.reads,[]);assert.equal(f.verified,0)
})

test('no reads on in-band tool errors, pause/refusal/overreserve or exact intent/dates mismatch',async()=>{
 const f=fixture()
 const err={...bot(seen)[2],content:{type:'web_search_tool_result_error',error_code:'unavailable'}}
 const error=[...bot(seen).slice(0,2),err,bot(seen)[3],cite(seen)]
 for(const [binding,r,raw] of [
  [confirmed,receipt,response(error)],
  [confirmed,receipt,response(undefined,'pause_turn')],
  [confirmed,receipt,response(undefined,'refusal')],
  [confirmed,{...receipt,reserveMicros:12_499},response()],
  [{...confirmed,criteria:{...criteria,event:'different request'}},receipt,response()],
  [{...confirmed,criteria:{...criteria,from:'2026-11-01'}},receipt,response()],
 ] as const) assert.equal((await companyHintsFromDynamicSearch(binding,r,raw,f.ports,signal())).state,'refused')
 assert.deepEqual(f.reads,[])
})

test('no company identity from redirect, absent visible text, or conflicting structured names',async()=>{
 for(const kind of ['redirect','invisible','conflicting'] as const){
  const f=fixture(), r=await companyHintsFromDynamicSearch(confirmed,receipt,response(),{...f.ports,async readPublicHtml(u){
    const p=await f.ports.readPublicHtml(u)
    if(kind==='redirect')return {...p,finalUrl:foreign}
    if(kind==='invisible')return {...p,visibleText:'Nordic Cooling Ltdish'}
    return {...p,visibleText:p.visibleText+' Other Holdings',jsonLd:[...p.jsonLd,
     JSON.stringify({'@context':'https://schema.org','@type':'Organization',url:seen,name:'Other Holdings'})]}
  }},signal())
  assert.deepEqual(r,{state:'hints',hints:[]})
 }
})
