// Owner cost contract1725. Synthetic SSE goes through the real SDK transport;
// no provider request, account secret, or paid execution is involved.
import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverLeads, usd } from '../lib/discover/agent.ts'
import { runDiscovery } from '../lib/discover/run.ts'
import { createSearchBudget } from '../lib/discover/search-budget.ts'
import { enrichLeads } from '../lib/discover/enrich.ts'
import { sseEvents, sseResponse } from './helpers/claude-sse.ts'

type RequestBody = { service_tier?: string; model?: string; fallbacks?: unknown; tools?: {name:string; max_uses?:number}[] }
function transport(turns: {searches:number; stop?:string}[]) {
  const requests:RequestBody[]=[]
  const fetchImpl:typeof fetch=async (_url,init)=>{
    requests.push(JSON.parse(String(init?.body)) as RequestBody)
    const turn=turns[Math.min(requests.length-1,turns.length-1)]
    return sseResponse(sseEvents({id:'msg_fixture1725',model:'claude-sonnet-5-5',
      content:[{type:'text',text:'<json>{"leads":[],"note":"Synthetic fixture; no live research"}</json>'}],
      stop_reason:turn.stop??'end_turn',usage:{input_tokens:10,output_tokens:1,
        cache_read_input_tokens:0,cache_creation_input_tokens:0,server_tool_use:{web_search_requests:turn.searches}}}))
  }
  return {requests,fetchImpl}
}
const searchLimit=(r:RequestBody)=>r.tools?.find(t=>t.name==='web_search')?.max_uses??0

test('1725 real outbound discovery selects documented Sonnet and disables premium fallback',async()=>{
  const t=transport([{searches:0}])
  await discoverLeads({query:'Find independent businesses with current buying evidence.'},{apiKey:'synthetic-fixture',fetch:t.fetchImpl})
  assert.equal(t.requests.length,1)
  assert.equal(t.requests[0].model,'claude-sonnet-5-5')
  assert.equal(t.requests[0].service_tier,'standard_only','listed rates require standard service')
  assert.equal(t.requests[0].fallbacks,undefined,'server-side default fallback must not choose an expensive model')
})

test('1725 Sonnet accounting includes uncached, output and both cache token classes',()=>{
  assert.equal(usd({input_tokens:100_000,output_tokens:5_000,cache_read_tokens:200_000,
    cache_write_tokens:40_000,searches:6,requests:1}),0.43)
})

test('1725 pause_turn has only the remaining whole-scan native search allowance',async()=>{
  const t=transport([{searches:14,stop:'pause_turn'},{searches:1}])
  const result=await discoverLeads({query:'Find businesses with dated purchasing signals.',maxSearches:15},{apiKey:'synthetic-fixture',fetch:t.fetchImpl})
  assert.equal(result.usage.searches,15)
  assert.deepEqual(t.requests.map(searchLimit),[15,1],'continuation must not reset15')
})

test('1725 exhausted zero allowance never dispatches a native search',async()=>{
  const t=transport([{searches:0}])
  await discoverLeads({query:'Find buyers.',maxSearches:0},{apiKey:'synthetic-fixture',fetch:t.fetchImpl})
  assert.ok(t.requests.every(r=>searchLimit(r)===0),'zero must not become one')
})

for(const maxSearches of [-1,0.5,Number.NaN,Number.POSITIVE_INFINITY]) {
  test(`1725 malformed search allowance ${String(maxSearches)} fails closed before dispatch`,async()=>{
    const t=transport([{searches:0}])
    await assert.rejects(discoverLeads({query:'Find buyers.',maxSearches},{apiKey:'synthetic-fixture',fetch:t.fetchImpl}))
    assert.equal(t.requests.length,0)
  })
}

test('1725 caller cannot raise the whole-scan ceiling beyond15',async()=>{
  const t=transport([{searches:0}])
  await discoverLeads({query:'Find buyers.',maxSearches:100},{apiKey:'synthetic-fixture',fetch:t.fetchImpl})
  assert.ok(t.requests.every(r=>searchLimit(r)<=15),'no native request may exceed hard ceiling')
})

test('1725 missing token accounting retains the allowance and cannot become a zero-cost success',async()=>{
  const searchBudget=createSearchBudget()
  const fetchImpl:typeof fetch=async()=>sseResponse(sseEvents({id:'msg_fixture1725',model:'claude-sonnet-5-5',
    content:[{type:'text',text:'<json>{"leads":[]}</json>'}],stop_reason:'end_turn',
    usage:{output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0,
      server_tool_use:{web_search_requests:0}}}))
  await assert.rejects(discoverLeads({query:'Find buyers.'},{apiKey:'synthetic-fixture',fetch:fetchImpl,searchBudget}),/usage/)
  assert.equal((await searchBudget.reserve(15)).allowance,0,'maybe-billed request remains fully held')
})

for (const failure of ['http503','missingusage','wrongmodel']) test(`1725 uncertain enrichment ${failure} retains evidence but cannot report a settled cheap run`,async()=>{
  let sends=0
  const fetchImpl:typeof fetch=async(_url,init)=>{
    if (init?.body) sends++
    if (!init?.body || failure === 'http503') return new Response('Fixture unavailable',{status:503})
    return sseResponse(sseEvents({id:'msg_fixture1725',model:failure === 'wrongmodel' ? 'claude-opus-5-5' : 'claude-haiku-5-5',
      content:[{type:'text',text:'<json>{"person":null}</json>'}],stop_reason:'end_turn',
      usage:{...(failure === 'missingusage' ? {} : {input_tokens:10}),output_tokens:1,cache_read_input_tokens:0,
        cache_creation_input_tokens:0,server_tool_use:{web_search_requests:1}}}))
  }
  const evidence='Fictional Cedar is opening a new branch.'
  const result=await runDiscovery({query:'Find businesses opening locations.'},{maxUsd:1,wantShown:0},
    {apiKey:'synthetic-fixture',fetch:fetchImpl,judge:null,discover:async()=>({
      leads:[{company:'Fictional Cedar',signal:evidence,evidence_url:'https://fixture.example/branch',
        domain:null,person:null,title:null,person_source_url:null,linkedin_url:null,email:null,email_source_url:null,
        signal_date:null,evidence_quote:evidence,confidence:'high',why:'Expanding'}],
      seen:[{url:'https://fixture.example/branch',text:evidence,title:'Fictional Cedar',page_age:null}],
      usage:{input_tokens:10,output_tokens:1,cache_read_tokens:0,cache_write_tokens:0,searches:1,requests:1,usd:0.01},
      stop:'end_turn',model:'claude-sonnet-5-5',note:null})})
  assert.equal(result.leads.length,1,'previously collected evidence remains')
  assert.equal(result.accountingUncertain,true,'runner must retain full dollar reservation')
  assert.equal(result.stop,'accounting_uncertain')
  assert.equal(sends,1,'SDK must not retry a possibly billed request')
})

test('1725 unexpected served model retains the entire search hold', async () => {
  const searchBudget = createSearchBudget()
  const fetchImpl: typeof fetch = async () => sseResponse(sseEvents({ id: 'msg_wrongmodel', model: 'claude-opus-5-5',
    content: [{ type: 'text', text: '<json>{"leads":[]}</json>' }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 } } }))
  await assert.rejects(discoverLeads({ query: 'Find buyers.' }, { apiKey: 'synthetic-fixture', fetch: fetchImpl, searchBudget }))
  assert.equal((await searchBudget.reserve(15)).allowance, 0)
})

test('1725 uncertain verification stops later discovery and enrichment while preserving evidence', async () => {
  let discoveries = 0, enrichments = 0
  const result = await runDiscovery({ query: 'Find businesses.' }, { maxUsd: 1 }, {
    apiKey: 'synthetic-fixture',
    discover: async () => {
      discoveries++
      return { leads: [], seen: [], stop: 'end_turn', model: 'claude-sonnet-5-5', note: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, searches: 0, requests: 1, usd: 0.01 } }
    },
    enrich: async () => { enrichments++; throw new Error('Must not run') },
    judge: { ask: async () => { throw new Error('Unknown bill') }, usage: { requests: 1, usd: 0, accountingUncertain: true } },
  })
  assert.equal(discoveries, 1, 'no next discovery after verification uncertainty')
  assert.equal(enrichments, 0)
  assert.equal(result.accountingUncertain, true)
})

test('1725 parallel enrichment never continues after another request becomes uncertain', async () => {
  let sends = 0
  const fetchImpl: typeof fetch = async () => {
    sends++
    if (sends === 1) return new Response('Fixture unavailable', { status: 503 })
    await new Promise(resolve => setTimeout(resolve, 20))
    return sseResponse(sseEvents({ id: 'msg_pause', model: 'claude-haiku-5-5',
      content: [{ type: 'text', text: '<json>{"person":null}</json>' }], stop_reason: 'pause_turn',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        server_tool_use: { web_search_requests: 0 } } }))
  }
  const lead = { company: 'Fictional Cedar', domain: null, signal: 'Opening a branch', signal_date: null,
    evidence_url: 'https://fixture.example/branch', evidence_quote: null, person: null, title: null,
    person_source_url: null, linkedin_url: null, email: null, email_source_url: null,
    confidence: 'high' as const, why: 'Expansion' }
  const result = await enrichLeads([lead, { ...lead, company: 'Fictional Elm' }], { maxLeads: 2 },
    { apiKey: 'synthetic-fixture', fetch: fetchImpl }, 2)
  assert.equal(result.accountingUncertain, true)
  assert.equal(sends, 2, 'only requests already dispatched before the failure may complete')
})

test('1725 real discovery and concurrent enrichment share the last one search',async()=>{
  const requests:RequestBody[]=[]
  const fetchImpl:typeof fetch=async (_url,init)=>{
    if (!init?.body) return new Response('Fixture proof unavailable',{status:403})
    const body=JSON.parse(String(init.body)) as RequestBody
    requests.push(body)
    const first=requests.length===1
    const searches=first?14:Math.min(searchLimit(body),4)
    const leads=['Fictional Cedar','Fictional Elm'].map(company=>({company,
      signal:'Opening a new branch',evidence_url:'https://fixture.example/branch',person:null,country:'US',location_evidence:'United States'}))
    const request_plan={offer:null,buyer_type:null,industry_code:null,places:[],signals:[],exclusions:[],language:'en'}
    return sseResponse(sseEvents({id:'msg_fixture1725',model:body.model,
      content:[{type:'text',text:`<json>${JSON.stringify(first?{request_plan,leads}:{person:null})}</json>`}],
      stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:1,cache_read_input_tokens:0,
        cache_creation_input_tokens:0,server_tool_use:{web_search_requests:searches}}}))
  }
  const result=await runDiscovery({query:'Find businesses opening new locations.'},
    {maxUsd:1,wantShown:0},{apiKey:'synthetic-fixture',fetch:fetchImpl,judge:null})
  assert.equal(result.leads.length,2,'unconfirmed first-pass evidence is preserved')
  assert.equal(result.searches,15,'enrichment must not add eight searches to fourteen')
  assert.equal(requests.length,3)
  assert.ok(requests.every(r => r.service_tier === 'standard_only'), 'all discovery and enrichment calls use listed standard rates')
  assert.deepEqual(requests.slice(1).map(searchLimit).sort(),[0,1])
})
