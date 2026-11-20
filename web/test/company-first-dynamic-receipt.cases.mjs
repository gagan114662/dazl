import test from 'node:test'
import assert from 'node:assert/strict'
import {projectDynamicReceipt as parse} from '../lib/company-first/company-first-dynamic-receipt.mjs'
const u='https://company.example/staff', quote='synthetic quote'
const caller={type:'code_execution_20260120',tool_id:'srvtoolu_exec'}
const use=(name,id,caller)=>({type:'server_tool_use',name,id,input:{query:'opaque private query'},caller})
const result=(name,id,content,caller)=>({type:name+'_tool_result',tool_use_id:id,content,caller})
const row={type:'web_search_result',url:u,title:'private heading',page_age:null,encrypted_content:'opaque-private'}
const c={type:'text',text:'private prose',citations:[{type:'web_search_result_location',url:u,title:'private heading',encrypted_index:'opaque',cited_text:quote}]}
const code={type:'encrypted_code_execution_result',encrypted_stdout:'SENSITIVE',stderr:'private stderr',return_code:0,content:[]}
const wrap=(content,stop_reason='end_turn')=>({type:'message',role:'assistant',stop_reason,content,usage:{input_tokens:12,output_tokens:4,server_tool_use:{web_search_requests:1,web_fetch_requests:0}}})
const nested=[use('code_execution','srvtoolu_exec'),use('web_search','srvtoolu_search',caller),result('web_search','srvtoolu_search',[row],caller),result('code_execution','srvtoolu_exec',code),c]
test('dynamic search nested caller/result pairing and unique exact citation, no provider content exposed',()=>{
 const x=parse(wrap(nested))
 assert.deepEqual(x.pointers,[{block:2,item:0,tool:'web_search'}])
 assert.deepEqual(x.citations,[{textBlock:4,citation:0,resultBlock:2,result:0}])
 assert.deepEqual(x.usage,{input:12,output:4,searches:1,fetches:0})
 assert.doesNotMatch(JSON.stringify(x),/private|SENSITIVE|company\.example|synthetic quote|srvtoolu/)
})
test('cross-tool, mismatched caller/reference, malformed result or incomplete tool cannot pass',()=>{
 assert.equal(parse(wrap([nested[0],nested[1],result('web_fetch','srvtoolu_search',{},caller)],'end_turn'),{allowFetch:true}).reason,'mismatched_tool_result')
 assert.equal(parse(wrap([nested[0],nested[1],result('web_search','srvtoolu_search',[row],{type:'direct'})])).reason,'mismatched_caller')
 assert.equal(parse(wrap([nested[1],nested[2]])).reason,'orphan_dynamic_caller')
 assert.equal(parse(wrap([nested[0],nested[1],result('web_search','srvtoolu_search',[{...row,type:'search_result'}],caller)])).reason,'invalid_search_result')
 assert.equal(parse(wrap(nested.slice(0,3))).reason,'unfinished_tool')
 for(const stop of ['pause_turn','tool_use','max_tokens','model_context_window_exceeded','refusal','stop_sequence']){
  const x=parse(wrap(nested,stop));assert.equal(x.kind,'incomplete');assert.equal(x.pointers,undefined)
 }
})
test('bounded fetch errors and empty search success distinct; later/third-party citations receive no linkage',()=>{
 const fu=use('web_fetch','srvtoolu_fetch')
 const fx=result('web_fetch','srvtoolu_fetch',{type:'web_fetch_tool_result_error',error_code:'url_not_in_prior_context'})
 assert.equal(parse(wrap([fu,fx])).reason,'unexpected_tool')
 assert.deepEqual(parse(wrap([fu,fx]),{allowFetch:true}).errors,[{tool:'web_fetch',error:'url_not_in_prior_context'}])
 const su=use('web_search','srvtoolu_search'), empty=result('web_search','srvtoolu_search',[])
 assert.deepEqual(parse(wrap([su,empty])).errors,[])
 assert.deepEqual(parse(wrap([c,su,result('web_search','srvtoolu_search',[row])])).citations,[])
 assert.deepEqual(parse(wrap([su,result('web_search','srvtoolu_search',[row,row]),c])).citations,[])
})
test('dynamic code failure yields no pointers; fetch document and encrypted values never forwarded',()=>{
 const x=parse(wrap([...nested.slice(0,3),result('code_execution','srvtoolu_exec',{...code,return_code:1}),c]))
 assert.deepEqual(x.pointers,[])
 const y=parse(wrap([use('web_fetch','srvtoolu_fetch'),result('web_fetch','srvtoolu_fetch',{type:'web_fetch_result',url:u,content:{type:'document',source:{data:'secret'},title:'private'},retrieved_at:null})]),{allowFetch:true})
 assert.deepEqual(y.pointers,[{block:1,item:0,tool:'web_fetch'}])
 assert.doesNotMatch(JSON.stringify(y),/secret|staff/)
})
