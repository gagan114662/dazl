import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeDynamicSettlement as decode, TARIFF, type BillingBinding } from '../lib/company-first/dynamic-billing.ts'
const bind:BillingBinding={tariff:TARIFF,model:'claude-sonnet-5-5',api:'messages_2023-06-01',provider:'anthropic',currency:'USD',
 tier:'standard_only',geo:'global',cache:'uncached',tool:'web_search_20260209',caller:'code_execution_20260120',maxUses:5,maxOutput:3000}
const use={service_tier:'standard',inference_geo:'global',input_tokens:1001,output_tokens:50,
 server_tool_use:{web_search_requests:2,web_fetch_requests:0,code_execution_requests:1}}
const envelope={type:'message',role:'assistant',model:'claude-sonnet-5-5',stop_reason:'end_turn',usage:use,content:[{type:'web_search_tool_result',content:[{type:'web_search_result'}]}]}
const from=(partial:object={},values:object={})=>({status:200,body:{...envelope,...partial,usage:{...use,...values}}})

test('exact dynamic search price in integer micros; bundled code execution has no added fee',()=>{
 assert.deepEqual(decode(bind,from()),{outcome:'settled',actualMicros:22502,searches:2,fetches:0,codeExecutions:1,stop:'end_turn',continuation:'none',evidenceEligible:true})
 const empty=decode(bind,from({content:[]}));assert.equal(empty.evidenceEligible,false)
 const f={...bind,tool:'web_fetch_20260209' as const,maxOutput:1400,maxUses:1,geo:'us' as const,cache:'documented_ttl' as const}
 const r=decode(f,from({}, {inference_geo:'us',cache_read_input_tokens:1,cache_creation_input_tokens:2,
  cache_creation:{ephemeral_5m_input_tokens:1,ephemeral_1h_input_tokens:1},
  server_tool_use:{web_search_requests:0,web_fetch_requests:1,code_execution_requests:2}}))
 // (2502 + 0.1 + 2.5 + 4) × 1.1 = 2759.46, ceil to 2760.
 assert.equal(r.outcome,'settled'); if(r.outcome==='settled'){assert.equal(r.actualMicros,2760);assert.equal(r.fetches,1)}
})

test('known pause, refusal, in-band tool failure and excess still settle but cannot contribute output or resume',()=>{
 for(const [change,stop] of [
  [{stop_reason:'pause_turn'},'pause_turn'],[{stop_reason:'refusal'},'refusal'],
  [{content:[{type:'web_search_tool_result',content:{type:'web_search_tool_result_error',error_code:'private-sentinel'}}]},'tool_error'],
 ] as const) {
   const r=decode(bind,from(change));assert.equal(r.outcome,'settled')
   if(r.outcome==='settled'){assert.equal(r.actualMicros,22502);assert.equal(r.stop,stop);assert.equal(r.continuation,'none');assert.equal(r.evidenceEligible,false)}
   assert.doesNotMatch(JSON.stringify(r),/private-sentinel/)
 }
 const r=decode(bind,from({}, {output_tokens:3200,server_tool_use:{web_search_requests:6,web_fetch_requests:0,code_execution_requests:2}}))
 assert.equal(r.outcome,'settled');if(r.outcome==='settled'){assert.equal(r.actualMicros,94002);assert.equal(r.stop,'provider_limit');assert.equal(r.evidenceEligible,false)}
})

test('mismatched or missing payable facts preserve unknown status; no assumed zero',()=>{
 for(const [x,reason] of [
  [from({model:'claude-sonnet-4-6'}),'model'],
  [from({}, {service_tier:'priority'}),'tier'],
  [from({}, {inference_geo:'unrecognized-private-label'}),'geo'],
  [from({}, {speed:'fast'}),'speed'],
  [from({}, {input_tokens:-1}),'tokens'],
  [from({}, {cache_creation_input_tokens:3}),'cache'],
  [from({}, {cache_creation_input_tokens:0,cache_creation:{ephemeral_5m_input_tokens:2}}),'cache'],
  [from({}, {server_tool_use:{web_search_requests:2}}),'tools'],
  [from({}, {server_tool_use:{web_search_requests:2,web_fetch_requests:0,unknown_billable:1}}),'tools'],
  [{status:429,body:{type:'error',error:{message:'secret-sentinel'}}},'provider_error'],
 ] as const){
  const r=decode(bind,x);assert.deepEqual(r,{outcome:'uncertain',reason,continuation:'none',evidenceEligible:false})
 }
 assert.equal(decode(null,from()).outcome,'uncertain')
})
