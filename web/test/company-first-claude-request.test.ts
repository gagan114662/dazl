import assert from 'node:assert/strict'
import test from 'node:test'
import { executePrepared, prepareCompanyPage, prepareDiscovery, type Lease, type Ports, type Prepared } from '../lib/company-first/claude-request.ts'
const lane={enabled:true,approvedForPublicDynamicFiltering:true,ownKey:true,model:'claude-sonnet-5-5',apiVersion:'2023-06-01',scope:{caseId:'fictional-case',attempt:2}}
const scope={companyType:'Industrial maintenance',market:'Wellington',intent:'new branch'}
const uri='https://company.example/team'
const proof={href:uri,finalHref:uri,origin:'https://company.example',mediaType:'text/html',
  source:'guarded_owned_company_page' as const,purpose:'team' as const,publicCompanyOwned:true as const}
const lease=(p:Prepared):Lease=>({caseId:p.scope.caseId,attempt:p.scope.attempt,binding:p.binding,cohort:p.cohort,stage:p.stage,reserveMicros:30_000,id:'hold'})
function ports() {
 const calls:string[]=[]
 let used=false
 const deps:Ports<unknown>={supportsExactCompanyRead:u=>u===uri,
   async consumeLiveLease(){calls.push('consume');if(used)return false;used=true;return true},
   async send(r){calls.push('send');assert.equal(r.url,'https://api.anthropic.com/v1/messages')
     assert.equal(r.apiVersion,'2023-06-01');assert.ok(r.signal instanceof AbortSignal)
     assert.equal(r.readLimitBytes,512*1024);return {fixture:true}},
   parse(_r,stage,n,url){calls.push('parse');return {stage,n,url}},
 }
 return {deps,calls}
}

test('fresh discovery expects explicit supported lane and emits one exact dynamic search without domain restriction',()=>{
  assert.equal(prepareDiscovery({...lane,enabled:false},scope,5),null)
  assert.equal(prepareDiscovery({...lane,approvedForPublicDynamicFiltering:false},scope,5),null)
  assert.equal(prepareDiscovery({...lane,model:'claude-sonnet-4-5-20250929'},scope,5),null)
  assert.equal(prepareDiscovery({...lane,ownKey:false},scope,5),null)
  assert.equal(prepareDiscovery(lane,scope,6),null)
  assert.equal(prepareDiscovery(lane,{...scope,intent:'visit https://other.example'},5),null)
  const p=prepareDiscovery(lane,scope,5)!
  assert.equal(p.body.model,'claude-sonnet-5-5')
  assert.equal(p.body.service_tier,'standard_only')
  assert.equal(p.body.inference_geo,'global')
  assert.deepEqual(p.body.tools,[{type:'web_search_20260209',name:'web_search',max_uses:5,allowed_callers:['code_execution_20260120']}])
  assert.ok(!p.body.messages[0].content.includes(lane.scope.caseId))
})

test('fresh company request admits only exact verified owned public HTML and a separate, narrow fetch shape',()=>{
  for(const change of [
    {href:'https://other.example/team',finalHref:'https://other.example/team'},
    {finalHref:'https://redirect.example/team'},
    {href:'https://company.example/team?auth=x',finalHref:'https://company.example/team?auth=x'},
    {href:'https://company.example/team.pdf',finalHref:'https://company.example/team.pdf'},
    {mediaType:'application/pdf'}, {href:'https://child.company.example/team',finalHref:'https://child.company.example/team'},
  ]) assert.equal(prepareCompanyPage(lane,{...proof,...change}),null)
  const p=prepareCompanyPage(lane,proof)!
  assert.deepEqual(p.body.tools,[{type:'web_fetch_20260209',name:'web_fetch',allowed_domains:['company.example'],
    max_content_tokens:6000,max_uses:1,allowed_callers:['code_execution_20260120'],
    url_sources:{user_input:{type:'all'},server_tool_results:{type:'none'},client_tool_results:{type:'none'}}}])
  assert.equal(p.body.messages[0].content.match(/https?:\/\//g)?.length,1)
  assert.notEqual(p.cohort,prepareDiscovery(lane,scope,1)!.cohort)
})

test('no dispatch without exact live lease, no company dispatch without a stronger exact destination guarantee',async()=>{
 const p=prepareCompanyPage(lane,proof)!, f=ports(), held=lease(p)
 assert.equal((await executePrepared(p,held,{...f.deps,supportsExactCompanyRead:undefined})).state,'not_sent')
 assert.equal((await executePrepared(p,{...held,attempt:3},f.deps)).state,'not_sent')
 assert.equal((await executePrepared({...p},held,f.deps)).state,'not_sent')
 assert.deepEqual(f.calls,[])
 assert.deepEqual(await executePrepared(p,held,f.deps),{state:'parsed',result:{stage:'company_page',n:1,url:uri}})
 assert.equal((await executePrepared(p,held,f.deps)).state,'not_sent')
 assert.deepEqual(f.calls,['consume','send','parse','consume'])
})

test('in-flight failure is uncertain, never retries or leaks provider body',async()=>{
 const p=prepareDiscovery(lane,scope,2)!, f=ports()
 let sends=0
 const r=await executePrepared(p,lease(p),{...f.deps,async send(){sends++;throw Error('retained payload sentinel')}})
 assert.deepEqual(r,{state:'uncertain'});assert.equal(sends,1)
})
