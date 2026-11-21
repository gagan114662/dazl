import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { crawl4aiGet, crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { markCompanyFirstBudget } from '../lib/company-first/product-discovery.ts'
import {companyFirstPublishedDisplayRows} from '../lib/people/company-first-published-display.ts'
import {publishedEmail} from '../lib/outreach/published-email.ts'
import { enrichmentsForLeads } from '../lib/connectors/store.ts'

const now=Date.parse('2026-11-13T12:00:00Z')
const host='brindleledger.com', origin='https://'+host, company='Brindle Ledger', name='Mira Quinn', title='Purchasing Director'
const email='mira.quinn@'+host, shared='help@'+host, team=origin+'/team'
const prose='<p>Brindle Ledger has served its local community for many years. We help businesses find the right products and manage the process from start to finish with clear service and transparent information.</p>'
const wrap=(s:string)=>'<html><body>'+s+'</body></html>'
const card=(role=title,address=email)=>'<article><h2>'+name+'</h2><p>'+role+'</p><a href="mailto:'+address+'">'+address+'</a></article>'
async function fixture(markup:string,opt:{strict?:boolean;own?:boolean;international?:boolean; country?:string; marker?:boolean; recrawl?:boolean; buyerSitePage?:boolean; citedBuyerPage?:boolean; linkedGenericAbout?:boolean; sharedHost?: "authorized-first"|"unauthorized-first"; wrongBuyerOrigin?:boolean; wrongBuyerCitation?:boolean; robotsBuyerDeny?:boolean; invalidate?:"attempt"|"person"|"suppression"|"age"}={}){
 const where=opt.country??(opt.international?'Toronto, ON':'Austin, TX')
 const db=new Database(':memory:'); migrateAllSqlite(db)
 try{
  const job=createJob(db,'T',{business_name:'Seller',industry:'supplies',location:where})
  db.prepare("UPDATE scan_jobs SET status='running',icp=? WHERE id=?").run(JSON.stringify({who:[title],where:[where]}),job)
  if(opt.marker)db.prepare('UPDATE scan_jobs SET run_budget=? WHERE id=?').run(markCompanyFirstBudget(null),job)
  const lead='c'.repeat(24), source=opt.own===false?'https://publicpublisher.example/record':origin+'/event'
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
   .run(lead,job,company,null,company+' in '+where,source,company+' in '+where,90,80)
  const pages:Record<string,string>={
   [origin+'/robots.txt']:'User-agent: *\nAllow: /',
   [origin+'/']:wrap(prose+'<p>'+company+', 100 Example Ave, '+where+(opt.international?' M5V 2T6, Canada':' 78702')+'</p><a href="/team">Team</a><a href="/contact">Contact</a>'),
   [team]:wrap(prose+markup),
   [origin+'/contact']:wrap(prose+'<a href="mailto:'+shared+'">'+shared+'</a>'),
   [source]:wrap(prose+(opt.own===false?'<a href="'+origin+'/">'+company+'</a>':'')),
  }
  const otherLead='d'.repeat(24)
  if(opt.sharedHost){
   const otherSource='https://publicpublisher.example/shared-site'
   pages[otherSource]=wrap(prose+'<a href="'+origin+'/">'+company+'</a>')
   db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(otherLead,job,company,null,company+' in '+where,otherSource,company+' in '+where,90,opt.sharedHost==='authorized-first'?70:90)
  }
  const buyerPage=origin+'/company/our-story'
  if(opt.buyerSitePage || opt.citedBuyerPage){
   if(opt.buyerSitePage) pages[origin+'/']=pages[origin+'/'].replace('</body>','<a href="/company/our-story">Our story</a></body>')
   pages[team]=wrap(prose)
   pages[origin+'/contact-us']=wrap(prose)
   pages[origin+'/about']=wrap(prose)
   pages[buyerPage]=wrap(prose+markup)
  }
  if(opt.linkedGenericAbout) pages[origin+'/']=pages[origin+'/'].replace('</body>','<a href="/about">About us</a></body>')
  if(opt.robotsBuyerDeny) pages[origin+'/robots.txt']='User-agent: *\nDisallow: /company/our-story'
  const requests:{url:string; noRedirect:boolean}[]=[]
  const get:Get=async (url,opts)=>{
   requests.push({url,noRedirect:!!opts?.noRedirect})
   return {status:pages[url]?200:404,body:pages[url]??'',finalUrl:opt.wrongBuyerOrigin&&url===buyerPage?'https://another.example/company/our-story':url}
  }
  const scan=()=>crawlJob(db,'T',job,{get,gapMs:0,now,...(opt.sharedHost?{concurrency:1}:{}),...(opt.citedBuyerPage?{buyerCitedUrls:[opt.wrongBuyerCitation?'https://another.example/company/our-story':buyerPage]}:{}),env:{EMAIL_GUESS_ENABLED:'1'},...(opt.marker?{}:{companyFirstContacts:opt.strict!==false})})
  await scan()
  if(opt.recrawl){pages[team]=wrap(prose+card(title,shared)); await scan()}
  if(opt.invalidate==='attempt')db.prepare('UPDATE scan_jobs SET attempts=attempts+1 WHERE id=?').run(job)
  if(opt.invalidate==='person')db.prepare("DELETE FROM lead_enrichments WHERE tenant_id='T' AND lead_id=? AND kind='person'").run(lead)
  if(opt.invalidate==='suppression')db.prepare("INSERT INTO suppressions (tenant_id,email,reason,created_at) VALUES ('T',?,'manual',?)").run(email,now/1000)
  const observed=now/1000+(opt.invalidate==='age'?45*86400+1:0)
  const enrichments=enrichmentsForLeads(db,'T',[lead])[lead]??[]
  return {requests,otherRows:(enrichmentsForLeads(db,'T',[otherLead])[otherLead]??[]).filter(r=>r.kind==='person'),display:(await companyFirstPublishedDisplayRows(db,'T',[lead],observed))[lead],
   foreign:(await companyFirstPublishedDisplayRows(db,'another',[lead],observed))[lead],
   routed:publishedEmail({contact:null,enrichments}),
   rows:(enrichmentsForLeads(db,'T',[lead])[lead]??[]).filter(r=>['person','email','phone'].includes(r.kind)),
   guesses:db.prepare('SELECT address FROM email_candidates WHERE lead_id=?').all(lead)}
 }finally{db.close()}
}
test('normal strict site crawl keeps exact visibly co-published buyer and mailbox with exact cite and fetch stamp',async()=>{
 const {rows,guesses}=await fixture(card())
 const person=rows.find(r=>r.kind==='person')
 assert.equal(person?.value,name+', '+title)
 assert.equal(person?.label,'Title on the company page: '+title)
 assert.equal(person?.source_url,team)
 assert.equal(person?.retrieved_at,now/1000)
 assert.deepEqual(rows.filter(r=>r.kind==='email').map(r=>[r.value,r.source_url,r.retrieved_at]),[[email,team,now/1000]])
 assert.deepEqual(guesses,[])
})
test('ordinary job still reads ordinary team and role inbox; strict mode holds linked-only authority',async()=>{
 assert.ok((await fixture(card(),{strict:false})).rows.some(r=>r.value===shared))
 assert.deepEqual((await fixture(card(),{own:false})).rows,[])
})
test('strict excludes foreign, hidden, former, split, shared and tagged addresses and does not widen non-US recipient eligibility',async()=>{
 for(const markup of [
  '<section aria-label="Former team">'+card()+'</section>',
  '<h2>Past Team</h2>'+card(),
  card().replace('<p>','<p style="opacity:0">'),
  card('Purchasing <span>Director</span>'),
 ])assert.deepEqual((await fixture(markup)).rows,[],markup)
 for(const address of ['agent@'+host,'support+buyer@'+host,'mira.quinn@other.example','Mira.Quinn+work@'+host]){
  const {rows}=await fixture(card(title,address))
  assert.ok(!rows.some(r=>r.kind==='email'),address)
 }
 assert.ok(!(await fixture(card(),{international:true})).rows.some(r=>r.kind==='email'))
})

test('persisted normal-scan marker forces strict recrawl without explicit caller options',async()=>{
 const original=await fixture(card(),{marker:true})
 assert.deepEqual(original.rows.filter(r=>r.kind==='email').map(r=>r.value),[email])
 const refreshed=await fixture(card(),{marker:true,recrawl:true})
 assert.deepEqual(refreshed.rows.filter(r=>r.kind==='email'),[])
 assert.ok(refreshed.rows.some(r=>r.kind==='person'))
})

test('ordinary marked crawl records display-only exact personal work email outside US, without a routing recipient',async()=>{
 for(const country of ['Toronto, ON','London, England','Osaka, Japan']){
  const {display,foreign,routed,rows,guesses}=await fixture(card(),{marker:true,international:true,country})
  assert.deepEqual(display,{person:name+', '+title,address:email,source_url:team,role_quote:title,observed_at:now/1000,display_only:true},country)
  assert.equal(foreign,undefined)
  assert.equal(routed,null)
  assert.ok(!rows.some(r=>r.kind==='email'))
  assert.deepEqual(guesses,[])
 }
 assert.equal((await fixture(card(),{marker:true})).routed,email,'pre-existing US recipient path is unchanged')
})
test('worldwide display withdraws stale, superseded, suppressed, blocked or unattributable evidence',async()=>{
 for(const invalidate of ['attempt','person','suppression','age'] as const)
  assert.equal((await fixture(card(),{marker:true,international:true,invalidate})).display,undefined,invalidate)
 for(const options of [{recrawl:true},{own:false},{marker:false}] as const)
  assert.equal((await fixture(card(),{marker:true,international:true,...options})).display,undefined)
 assert.equal((await fixture(card(title,shared),{marker:true,international:true})).display,undefined)
})

test('company-first buyer stage prioritizes a linked company story under the same page cap and preserves sender guards',async()=>{
 const source_url=origin+'/company/our-story'
 const live=await fixture(card(),{marker:true,buyerSitePage:true})
 assert.equal(live.rows.find(r=>r.kind==='person')?.source_url,source_url)
 assert.equal(live.rows.find(r=>r.kind==='person')?.label,'Title on the company page: '+title)
 assert.equal(live.routed,email)
 assert.deepEqual(live.guesses,[])
 assert.deepEqual((await fixture(card(),{marker:true,buyerSitePage:true,wrongBuyerOrigin:true})).rows,[])
 assert.deepEqual((await fixture(card(title+' at Another Company'),{marker:true,buyerSitePage:true})).rows,[])
 assert.deepEqual((await fixture('<section aria-label="Former team">'+card()+'</section>',{marker:true,buyerSitePage:true})).rows,[])
 assert.equal((await fixture(card(title,shared),{marker:true,buyerSitePage:true})).routed,null)
 const foreign=await fixture(card(),{marker:true,buyerSitePage:true,international:true})
 assert.equal(foreign.display?.source_url,source_url)
 assert.equal(foreign.display?.address,email)
 assert.equal(foreign.routed,null)
})

test('already-admitted buyer source is only a fresh exact-origin crawl hint after separate website identity',async()=>{
 const source=origin+'/company/our-story'
 const opt={marker:true,citedBuyerPage:true}
 const good=await fixture(card(),opt)
 assert.equal(good.rows.find(r=>r.kind==='person')?.source_url,source)
 assert.equal(good.rows.find(r=>r.kind==='person')?.retrieved_at,now/1000)
 assert.equal(good.routed,email)
 assert.deepEqual(good.requests.filter(r=>r.url===source),[{url:source,noRedirect:true}])
 for(const extra of [{wrongBuyerCitation:true},{own:false},{robotsBuyerDeny:true}] as const){
  const state=await fixture(card(),{...opt,...extra})
  assert.ok(!state.rows.some(r=>r.kind==='person'))
  assert.ok(!state.requests.some(r=>r.url.endsWith('/company/our-story')))
 }
 for(const markup of [card(title+' at Another Company'),card('Warehouse Operator')]){
  const state=await fixture(markup,opt)
  assert.deepEqual(state.rows,[])
  assert.equal(state.routed,null)
 }
 const bounced=await fixture(card(),{...opt,wrongBuyerOrigin:true})
 assert.deepEqual(bounced.rows,[])
 assert.equal(bounced.routed,null)
})

test('a generic linked about page cannot displace an authorized cited buyer fallback',async()=>{
 const result=await fixture(card(),{marker:true,citedBuyerPage:true,linkedGenericAbout:true})
 assert.ok(result.requests.some(r=>r.url===origin+'/about'))
 assert.equal(result.rows.find(r=>r.kind==='person')?.source_url,origin+'/company/our-story')
 assert.equal(result.routed,email)
})

test('rendering sidecar cannot serve a no-redirect buyer read or mislabel a downgrade',async()=>{
 let sidecarCalls=0
 const get=crawl4aiGet('http://127.0.0.1:11235',async()=>{
  sidecarCalls++
  return Response.json({results:[{status_code:200,url:team,redirected_url:'http://'+host+'/team',html:card()}]})
 },async()=>true)
 assert.equal(await get(team,{noRedirect:true}),null)
 assert.equal(sidecarCalls,0)
 assert.equal(await get(team),null)
 assert.equal(sidecarCalls,1)
})

test('a shared host keeps its authorized cited buyer regardless of lead order without broadening the other lead',async()=>{
 const buyerURL=origin+'/company/our-story'
 for(const order of ['authorized-first','unauthorized-first'] as const){
  const r=await fixture(card(),{marker:true,citedBuyerPage:true,sharedHost:order})
  assert.equal(r.rows.find(c=>c.kind==='person')?.source_url,buyerURL,order)
  assert.deepEqual(r.otherRows,[],order)
  assert.equal(r.requests.filter(q=>q.url===buyerURL).length,1,order)
  assert.equal(r.requests.filter(q=>q.url===origin+'/').length,1,order)
  assert.equal(r.requests.filter(q=>q.url===origin+'/robots.txt').length,1,order)
 }
})
