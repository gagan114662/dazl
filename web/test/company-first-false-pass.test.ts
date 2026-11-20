import assert from 'node:assert/strict'
import test from 'node:test'
import { proveCompanyFirstBuyerBySearch, findPublishedOwnDomainEmail, type BuyerSearchReaders, type PublicPage } from '../lib/company-first/company-first-buyer-search.ts'
import type { Finding } from '../lib/company-first/company-first-evidence.ts'
// Synthetic fixtures only. Each case is a false pass reported on #1434/#1439; each must be HELD.
const origin='https://sample-studio.example', own=origin+'/about/team'
const scope={tenant:'t',job:'j',attempt:'1'}, company='Sample Studio', name='Jane Quinn', title='Head of Sales'
const finding={state:'signal_verified',name:company,site:{companyKey:'s',website:origin,identitySource:origin+'/'},
  signal:{companyKey:'s',place:'X',event:'hiring',date:'2026-11-01',sourceUrl:origin+'/careers/sdr',quote:'hiring'}} as const satisfies Finding
const run=(html:string,cand:any={name,title,linkedin:null,sources:[own]},extra:Partial<BuyerSearchReaders>={})=>proveCompanyFirstBuyerBySearch(finding,[title],scope,{
  isCurrent:async()=>true,reserveBeforeDispatch:async()=>true,searchBuyer:async()=>cand,
  readPage:async(url):Promise<PublicPage>=>({url,text:'',html}),...extra})
test('Z1a: page-wide mentions do not link a name to another person\'s title', async()=>{
  assert.equal((await run(`<p>Jane Quinn — Designer. Sam Lee — Head of Sales.</p>`)).status,'held')
  assert.equal((await run(`<article><h2>Jane Quinn</h2><p>Designer</p></article><article><h2>Sam Lee</h2><p>Head of Sales</p></article>`)).status,'held')
})
test('Z1b: "former Head of Sales" never proves a current role', async()=>{
  assert.equal((await run(`<article><h2>Jane Quinn</h2><p>Former Head of Sales</p></article>`)).status,'held')
  assert.equal((await run(`<p>Jane Quinn, former Head of Sales</p>`)).status,'held')
})
test('Q1: article-level aria-label/title saying former vetoes the card', async()=>{
  assert.equal((await run(`<article aria-label="Former Head of Sales"><h2>Jane Quinn</h2><p>Head of Sales</p></article>`)).status,'held')
  assert.equal((await run(`<li title="Previously Head of Sales"><h2>Jane Quinn</h2><p>Head of Sales</p></li>`)).status,'held')
})
test('Z2: another person\'s name-shaped address is never given to the buyer', ()=>{
  assert.equal(findPublishedOwnDomainEmail(name,[{url:own,text:`Jane Quinn — Head of Sales\nJordan Quinn, press requests: jquinn@sample-studio.example`}],origin,title),null)
  assert.equal(findPublishedOwnDomainEmail(name,[{url:own,text:`Jane Quinn\nHead of Sales\nJordan Quinn\njquinn@sample-studio.example`}],origin,title),null)
})
test('Z3: a LinkedIn slug with a different person never attaches', async()=>{
  const html=`<article><h2>Jane Quinn</h2><p>Head of Sales</p><a href="https://www.linkedin.com/in/jane-different-person">Jane Quinn on LinkedIn</a></article>`
  const r=await run(html,{name,title,linkedin:'https://www.linkedin.com/in/jane-different-person',sources:[own]})
  assert.equal(r.status==='buyer_proof'?r.buyer.linkedin:null,null)
  const r2=await run(html,{name,title,linkedin:null,sources:[own]},{corroborateProfile:async(url)=>({url,name:'Jane Different',title,company,current:true})})
  assert.equal(r2.status==='buyer_proof'?r2.buyer.linkedin:null,null)
})
test('Q2: a non-string search title is held, not thrown', async()=>{
  for(const t of [123,{},['Head of Sales']]) assert.deepEqual(await run('',{name,title:t,linkedin:null,sources:[own]}),{status:'held',reason:'buyer_title_off'})
})
test('Q3: a failed profile read stops with read_failed', async()=>{
  const html=`<article><h2>Jane Quinn</h2><p>Head of Sales</p><a href="https://www.linkedin.com/in/jane-quinn">Jane Quinn on LinkedIn</a></article>`
  assert.deepEqual(await run(html,undefined,{corroborateProfile:async()=>{throw new Error('net')}}),{status:'held',reason:'read_failed'})
})
test('Q4: the same address on a bare-origin homepage makes it ambiguous', ()=>{
  const a='jquinn@sample-studio.example'
  assert.equal(findPublishedOwnDomainEmail(name,[{url:own,text:`Jane Quinn\nHead of Sales\nEmail: ${a}`},{url:origin,text:`Footer ${a}`}],origin,title),null)
  assert.equal(findPublishedOwnDomainEmail(name,[{url:own,text:`Jane Quinn\nHead of Sales\nEmail: ${a}`},{url:'not a url',text:`x`}],origin,title),null)
})
