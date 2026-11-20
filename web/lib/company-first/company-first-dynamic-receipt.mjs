// Offline metadata projector for a single decoded Anthropic Messages API response.
// A URL/citation match is provenance only; never a finding or proof of first-party ownership.
const isRecord=v=>!!v&&typeof v==='object'&&!Array.isArray(v)
const boundedText=(v,n)=>typeof v==='string'&&v.length>0&&v.length<=n
const isId=v=>typeof v==='string'&&/^srvtoolu_[A-Za-z0-9_]{1,128}$/.test(v)
const n=v=>Number.isSafeInteger(v)&&v>=0
const SEARCH=new Set(['invalid_tool_input','unavailable','max_uses_exceeded','too_many_requests','query_too_long','request_too_large'])
const FETCH=new Set(['invalid_tool_input','url_too_long','url_not_allowed','url_not_in_prior_context','url_not_accessible','unsupported_content_type','too_many_requests','max_uses_exceeded','unavailable','content_too_large'])
const STOP=new Set(['end_turn','max_tokens','stop_sequence','tool_use','pause_turn','refusal','model_context_window_exceeded'])
const bad=(reason,stop='unknown')=>({kind:'refused',reason,stop})
const lexical=v=>{
  if(!boundedText(v,2048)||/[\u0000-\u0020\u007f]/.test(v))return null
  try{const u=new URL(v);return ['http:','https:'].includes(u.protocol)&&u.hostname&&!u.username&&!u.password?u.href:null}catch{return null}
}
const callerOf=c=>{
  if(c===undefined||isRecord(c)&&c.type==='direct')return 'direct'
  if(isRecord(c)&&c.type==='code_execution_20260120'&&isId(c.tool_id))return c.tool_id
  return null
}
const TOOL=Object.freeze({web_search:'web_search_tool_result',web_fetch:'web_fetch_tool_result',code_execution:'code_execution_tool_result'})
function usage(r){
  const u=r.usage, s=u?.server_tool_use
  if(!isRecord(u)||!n(u.input_tokens)||!n(u.output_tokens)||!isRecord(s)||!n(s.web_search_requests)||
     s.web_fetch_requests!==undefined&&!n(s.web_fetch_requests))return null
  return {input:u.input_tokens,output:u.output_tokens,searches:s.web_search_requests,fetches:s.web_fetch_requests??null}
}
export function projectDynamicReceipt(message,{allowFetch=false}={}){
  if(!isRecord(message)||message.type!=='message'||message.role!=='assistant'||!Array.isArray(message.content)||message.content.length>128)
    return bad('malformed_message')
  const stop=STOP.has(message.stop_reason)?message.stop_reason:'unknown'
  if(stop==='unknown')return bad('unknown_stop')
  const uses=new Map(), done=new Map(), cites=[], sources=[], errors=[]
  for(const [block,b] of message.content.entries()){
    if(!isRecord(b)||typeof b.type!=='string')return bad('malformed_block',stop)
    if(b.type==='server_tool_use'){
      if(!Object.hasOwn(TOOL,b.name)||b.name==='web_fetch'&&!allowFetch)return bad('unexpected_tool',stop)
      const caller=callerOf(b.caller)
      if(!isId(b.id)||uses.has(b.id)||!caller||!isRecord(b.input)||b.name==='code_execution'&&caller!=='direct')return bad('malformed_tool_use',stop)
      if(caller!=='direct'&&(uses.get(caller)?.name!=='code_execution'||done.has(caller)))return bad('orphan_dynamic_caller',stop)
      uses.set(b.id,{name:b.name,caller})
    }else if(Object.values(TOOL).includes(b.type)){
      const use=uses.get(b.tool_use_id)
      if(!use||TOOL[use.name]!==b.type||done.has(b.tool_use_id))return bad('mismatched_tool_result',stop)
      if(use.name==='code_execution'){
        if(!isRecord(b.content)||!['code_execution_result','encrypted_code_execution_result','code_execution_tool_result_error'].includes(b.content.type))return bad('invalid_code_result',stop)
        done.set(b.tool_use_id,b.content.type==='code_execution_tool_result_error'||b.content.return_code!==0?'failed':'ok')
        continue
      }
      if(callerOf(b.caller)!==use.caller||use.caller!=='direct'&&done.has(use.caller))return bad('mismatched_caller',stop)
      const tool=use.name, c=b.content
      if(isRecord(c)&&c.type===tool+'_tool_result_error'){
        errors.push({tool,error:(tool==='web_search'?SEARCH:FETCH).has(c.error_code)?c.error_code:'unknown_tool_error'})
      }else if(tool==='web_search'&&Array.isArray(c)&&c.length<=100){
        for(const [item,row] of c.entries()){
          if(!isRecord(row)||row.type!=='web_search_result'||!boundedText(row.title,4096)||!boundedText(row.encrypted_content,1_000_000)||
             row.page_age!==null&&typeof row.page_age!=='string'||!lexical(row.url))return bad('invalid_search_result',stop)
          sources.push({url:lexical(row.url),block,item,tool,caller:use.caller})
        }
      }else if(tool==='web_fetch'&&isRecord(c)&&c.type==='web_fetch_result'&&isRecord(c.content)&&c.content.type==='document'&&lexical(c.url)){
        sources.push({url:lexical(c.url),block,item:0,tool,caller:use.caller})
      }else return bad('invalid_tool_payload',stop)
      done.set(b.tool_use_id,'ok')
    }else if(b.type==='text'){
      if(b.citations!==undefined&&b.citations!==null&&(!Array.isArray(b.citations)||b.citations.length>100))return bad('invalid_citations',stop)
      for(const [item,c] of (b.citations??[]).entries()){
        if(!isRecord(c)||c.type!=='web_search_result_location')continue // document/custom proof is never promoted
        if(lexical(c.url)&&boundedText(c.encrypted_index,100_000)&&boundedText(c.cited_text,10_000))cites.push({url:lexical(c.url),block,item})
      }
    }else if(!['thinking','redacted_thinking'].includes(b.type))return bad('unexpected_content_type',stop)
  }
  if(sources.length>256||cites.length>256)return bad('too_many_references',stop)
  // Never replay an assistant message, continue a turn, or use partial provider results here.
  if(stop!=='end_turn')return {kind:'incomplete',stop,usage:usage(message),errors}
  if(uses.size!==done.size)return bad('unfinished_tool',stop)
  const eligible=sources.filter(s=>s.caller==='direct'||done.get(s.caller)==='ok')
  const pointers=eligible.map(({block,item,tool})=>({block,item,tool}))
  const citations=cites.flatMap(c=>{
    const matches=eligible.filter(s=>s.tool==='web_search'&&s.url===c.url&&s.block<c.block)
    return matches.length===1?[{textBlock:c.block,citation:c.item,resultBlock:matches[0].block,result:matches[0].item}]:[]
  })
  return {kind:'terminal',stop,usage:usage(message),errors,pointers,citations}
}
