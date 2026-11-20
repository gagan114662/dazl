import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { qaClaudeOnlyBudget, QA_LOCAL_EXECUTION } from '../lib/scan/qa-provider-policy.ts'
import { verifyScorecardTicket } from '../lib/company-first/scorecard-admission.ts'
import { armProtectedScorecardJobSqlite } from '../lib/company-first/scorecard-producer.ts'
import { dispatchScorecardAware } from '../lib/company-first/scorecard-dispatch.ts'
import { runCompanyFirstNativeTransport, prepareNativeDiscoveryVariant, type NativeCompanySearch } from '../lib/company-first/company-first-native-transport.ts'
import { DISCOVERY_STRATEGIES } from '../lib/company-first/company-first-claude-request.ts'
import { runWithScanSpend, scanCapConfig } from '../lib/scan/spend-cap.ts'

const endpoint='https://api.anthropic.com/v1/messages'
const seen='https://company.example/about'
const body = {
  type:'message',role:'assistant',model:'claude-sonnet-5-5',stop_reason:'end_turn',
  usage:{service_tier:'standard',inference_geo:'global',input_tokens:1000,output_tokens:50,server_tool_use:{web_search_requests:1,web_fetch_requests:0}},
  content:[
    {type:'server_tool_use',name:'code_execution',id:'srvtoolu_exec',input:{}},
    {type:'server_tool_use',name:'web_search',id:'srvtoolu_search',caller:{type:'code_execution_20260120',tool_id:'srvtoolu_exec'},input:{}},
    {type:'web_search_tool_result',tool_use_id:'srvtoolu_search',caller:{type:'code_execution_20260120',tool_id:'srvtoolu_exec'},content:[
      {type:'web_search_result',url:seen,title:'Response title not trusted',page_age:null,encrypted_content:'RAW_NEVER_RETURNED'},
    ]},
    {type:'code_execution_tool_result',tool_use_id:'srvtoolu_exec',content:{type:'encrypted_code_execution_result',return_code:0}},
    {type:'text',text:'RAW_NEVER_RETURNED',citations:[{type:'web_search_result_location',url:seen,encrypted_index:'raw',cited_text:'raw'}]},
  ],
}
type Mode='valid'|'wrong_context'|'wrong_ticket'|'no_cap'|'no_key'|'private_query'|'throttle'|'bad_json'|'oversize'|'timeout'|'refusal'|'overrun'|'lost_after_send'|'multi'|'multi_unknown'|'multi_underfunded'|'multi_bad_binding'|'multi_prior_reserved'|'multi_namesake'
async function exercise(mode:Mode): Promise<{result:NativeCompanySearch; sends:number; reads:number; messages:string[]; rows: {status:string; actual_usd:number|null; id:string}[]}> {
  const db = new Database(':memory:')
  const prior=process.env.DAZL_MASTER_KEY
  const master=Buffer.alloc(32,7)
  process.env.DAZL_MASTER_KEY=master.toString('base64')
  const hex=(n:number,width=64)=>n.toString(16).padStart(width,'0')
  const tenantId='fixture-workspace', actorId='fixture-owner', release=hex(71,40), revision=hex(72), cohort=hex(73), key=Buffer.alloc(32,11)
  const expire=Date.now()+30_000, presets=Array.from({length:7},(_,i)=>hex(i+1))
  const query='Private fixture brief never transmitted',icp=JSON.stringify({summary:'Private fixture brief never transmitted'})
  const budget=JSON.stringify({...JSON.parse(qaClaudeOnlyBudget(JSON.stringify({first5:true}),true)),execution:QA_LOCAL_EXECUTION})
  function issue(lane:'old'|'new'){
    const jobId=hex(lane==='old'?70:71,24), nonce=hex(lane==='old'?74:75)
    const h=(data:string)=>createHmac('sha256',key).update(data).digest('hex')
    const mac=h(JSON.stringify(['legacy-observation-v1',actorId,tenantId,jobId,1,Math.floor(expire/1000),query,icp,null,null,null,budget]))
    const payload=Buffer.from(JSON.stringify([tenantId,actorId,jobId,1,revision,cohort,1,nonce,expire,presets,mac,release,lane])).toString('base64url')
    const signedToken=payload+'.'+h('dazl-scorecard-ticket:v1\n'+payload)
    const ticket=verifyScorecardTicket(signedToken,key,{tenantId,actorId,jobId,attempt:1,release},Date.now())
    assert.ok(ticket)
    return { signedToken, signingKey:key, ticket, jobId }
  }
  try {
    migrateAllSqlite(db)
    db.prepare("INSERT INTO users (id,email,name,business_name,password_hash,salt) VALUES (?,?,'','','','')").run(actorId,'fixture@example.test')
    db.prepare("INSERT INTO organizations (id,kind,created_by,created_at,company_first_scorecard_enabled,company_first_scorecard_revision) VALUES (?,'team',?,1,1,?)").run(tenantId,actorId,revision)
    db.prepare("INSERT INTO memberships (tenant_id,member_id,role,created_at) VALUES (?,?,'owner',1)").run(tenantId,actorId)
    saveKey(db,tenantId,'anthropic','synthetic-fixture-key',master)
    const old=issue('old'), next=issue('new')
    assert.deepEqual(armProtectedScorecardJobSqlite(db,old.ticket,{query,icp}),{ok:true,jobId:old.jobId})
    // Fenced precondition: mark historical predecessor complete, rather than
    // calling any baseline provider. Actual new dispatch, ledger and key are used.
    db.prepare("UPDATE company_scorecard_claims SET status='complete' WHERE job_id=?").run(old.jobId)
    db.prepare("UPDATE scan_jobs SET status='done',claimed_at=NULL,finished_at=unixepoch() WHERE id=?").run(old.jobId)
    assert.deepEqual(armProtectedScorecardJobSqlite(db,next.ticket,{query,icp}),{ok:true,jobId:next.jobId})
    const dbPort=sqliteDb(db)
    const rows=()=>db.prepare(`SELECT s.id,s.status,s.actual_usd FROM scan_spend_calls s JOIN company_scorecard_calls c ON c.reservation_id=s.id
      WHERE s.scan_job_id=? ORDER BY s.created_at`).all(next.jobId) as {status:string;actual_usd:number|null;id:string}[]
    let result:NativeCompanySearch|undefined, sends=0, reads=0
    const multi=mode.startsWith('multi'), messages:string[]=[]
    const urls=[seen,'https://secondary.example/about',seen]
    const criteria={category:mode==='private_query'?'Fixture private@example.test':'Example Category',
      place:'Example Market',event:'Hiring',from:'2026-11-01',through:'2026-11-30'}
    const routed=await dispatchScorecardAware(dbPort,{id:next.jobId,user_id:tenantId,attempts:1},async()=>{throw Error('no legacy path')},{
      release,materialFor:async()=>next,
      async runPrivate(execution) {
        if(mode==='no_key') db.prepare('UPDATE tenant_llm_keys SET ciphertext=? WHERE tenant_id=?').run('fixture-unreadable',tenantId)
        const operation=() => runCompanyFirstNativeTransport(mode==='wrong_ticket'?{...execution,ticket:{...execution.ticket}}:execution,{
          async readReviewedPublicDiscovery(){
            const searchPlan=multi?DISCOVERY_STRATEGIES.map((strategy,i)=>({
              strategy,reserveMicros:100_000,requestBinding:mode==='multi_bad_binding'&&i===1?hex(912):
                prepareNativeDiscoveryVariant(execution.ticket,criteria,1,strategy)!.binding,
            })):undefined
            return {criteria,maxUses:1,reserveMicros:mode==='overrun'?12000:multi?600_000:100_000,workspaceRevision:revision,searchPlan}
          },
          fetcher:async (url,req)=>{
            sends++
            assert.equal(url,endpoint);assert.equal(req?.method,'POST');assert.equal(req?.redirect,'error')
            assert.equal(new Headers(req?.headers).get('x-api-key'),'synthetic-fixture-key')
            assert.equal(new Headers(req?.headers).get('anthropic-version'),'2023-06-01')
            assert.doesNotMatch(String(req?.body),/brief|fixture-owner|fixture-workspace|synthetic-fixture-key/)
            const request=JSON.parse(String(req?.body))
            messages.push(request.messages[0].content)
            assert.equal(request.tools[0].max_uses,1)
            assert.deepEqual(rows().map(r=>r.status),[...Array.from({length:sends-1},()=> 'settled'),'reserved'])
            if(mode==='multi_unknown'&&sends===2)throw Error('fixture ambiguous later transmission')
            if(mode==='timeout')throw Error('fake network timeout, no retry')
            if(mode==='throttle')return new Response('{}',{status:429,headers:{'content-type':'application/json'}})
            if(mode==='bad_json')return new Response('{untrusted private body',{headers:{'content-type':'application/json'}})
            if(mode==='oversize')return new Response('x'.repeat(513*1024),{headers:{'content-type':'application/json'}})
            if(mode==='lost_after_send')db.prepare("UPDATE scan_jobs SET status='failed' WHERE id=?").run(next.jobId)
            const selected=multi?JSON.parse(JSON.stringify(body).replaceAll(seen,urls[(sends-1)%urls.length])):body
            return Response.json(mode==='refusal'?{...selected,stop_reason:'refusal'}:selected)
          },
          allowPublicUrl:url=>urls.includes(url),
          async readPublicHtml(url){
            reads++
            assert.ok(urls.includes(url))
            assert.deepEqual(rows().map(r=>[r.status,r.actual_usd]),Array.from({length:sends},()=>['settled',0.0125]))
            if(mode==='multi_prior_reserved')db.prepare("UPDATE scan_spend_calls SET status='reserved',actual_usd=NULL,settled_at=NULL WHERE id=?").run(rows()[0].id)
            const name=url===seen||mode==='multi_namesake'?'Sample Entity':'Second Entity'
            return {url,finalUrl:url,contentType:'text/html',visibleText:'Company info for '+name,
              jsonLd:[JSON.stringify({'@context':'https://schema.org','@type':'WebPage',url,mainEntity:{'@type':'Organization',name}})]}
          },
        },new AbortController().signal)
        if(mode==='wrong_context') result=await operation()
        else result=await runWithScanSpend({db:dbPort,jobId:next.jobId,tenantId,attempt:1,cap:scanCapConfig({}),
          accountLimits:{day:2,month:5},requestMaxUsd:mode==='no_cap'?0.05:mode==='multi_underfunded'?0.11:undefined,claudeOnly:true,
          scorecard:{ticket:execution.ticket,lane:'new'}},async()=>{
            const first=await operation()
            if ((multi&&sends>0)||['valid','timeout','throttle','bad_json','oversize','lost_after_send','overrun','refusal'].includes(mode))
              assert.deepEqual(await operation(),{state:'refused',reason:'not_authorized'})
            return first
          })
      },
    })
    assert.deepEqual(routed,{route:'scorecard',status:'callback_returned'})
    assert.ok(result)
    return {result,sends,reads,messages,rows:rows()}
  } finally {
    db.close()
    if(prior===undefined)delete process.env.DAZL_MASTER_KEY
    else process.env.DAZL_MASTER_KEY=prior
  }
}

test('real authenticated worker context + own key reserves and settles before hints; only fixed endpoint',async()=>{
  const x=await exercise('valid')
  assert.deepEqual(x.result,{state:'settled',actualMicros:12500,hints:[{name:'Sample Entity',hintUrl:seen}]})
  assert.equal(x.sends,1);assert.equal(x.reads,1);assert.equal(x.rows.length,1)
  assert.doesNotMatch(JSON.stringify(x.result),/RAW_NEVER_RETURNED|fixture-workspace|fixture-key/)
})
test('forged ticket, no active context, no cap room, unreadable key and unapproved fields make zero HTTP calls',async()=>{
  for(const mode of ['wrong_context','wrong_ticket','no_cap','no_key','private_query'] as const){
    const x=await exercise(mode)
    assert.equal(x.result.state,'refused',mode)
    assert.deepEqual([x.sends,x.reads,x.rows.length],[0,0,0],mode)
  }
})
test('maybe billed malformed, oversized, timeout and rejected responses keep full reservation and never read hints',async()=>{
  for(const mode of ['throttle','bad_json','oversize','timeout','lost_after_send'] as const){
    const x=await exercise(mode)
    assert.equal(x.result.state,'unsettled',mode)
    assert.deepEqual([x.sends,x.reads,x.rows.length],[1,0,1],mode)
    assert.deepEqual(x.rows.map(r=>[r.status,r.actual_usd]),[['reserved',null]],mode)
  }
})
test('known in-band refusal and overrun settle exact actual but never yield hints',async()=>{
  for(const [mode,why] of [['refusal','ineligible'],['overrun','estimate_exceeded']] as const){
    const x=await exercise(mode)
    assert.deepEqual(x.result,{state:'settled_no_hints',reason:why,actualMicros:12500},mode)
    assert.deepEqual([x.sends,x.reads,x.rows.length],[1,0,1],mode)
    assert.deepEqual(x.rows.map(r=>[r.status,r.actual_usd]),[['settled',0.0125]],mode)
  }
})

test('six independently quoted strategy bodies preserve exact reviewed criteria, aggregate distinct hypotheses and settle sequentially',async()=>{
  const x=await exercise('multi')
  assert.equal(new Set(x.messages).size,6)
  for(const [i,clue] of ['Workable','Indeed','press releases','wording variants','jobs.ashbyhq.com','job-boards.greenhouse.io'].entries())
    assert.ok(x.messages[i].includes(clue))
  for(const message of x.messages)assert.ok(message.endsWith(JSON.stringify(['Example Category','Example Market','Hiring','2026-11-01','2026-11-30'])))
  assert.deepEqual(x.result,{state:'settled',actualMicros:75000,hints:[
    {name:'Sample Entity',hintUrl:seen},{name:'Second Entity',hintUrl:'https://secondary.example/about'}]})
  assert.deepEqual([x.sends,x.reads,x.rows.length],[6,2,6])
})

test('unknown later charge, old reserved charge, lower canonical cap and substituted quote never send any later query',async()=>{
  for(const [mode,state,statuses] of [
    ['multi_unknown','unsettled',['settled','reserved']],['multi_underfunded','refused',['settled']],
    ['multi_prior_reserved','unsettled',['reserved']],['multi_bad_binding','refused',[]],
  ] as const){
    const x=await exercise(mode)
    assert.equal(x.result.state,state,mode)
    assert.equal(x.sends,statuses.length,mode)
    assert.deepEqual(x.rows.map(r=>r.status),statuses,mode)
    assert.equal('hints' in x.result,false)
  }
})

test('distinct domains for one namesake never promote either merged hypothesis',async()=>{
  const x=await exercise('multi_namesake')
  assert.deepEqual(x.result,{state:'settled',actualMicros:75000,hints:[]})
  assert.equal(x.sends,6)
})
