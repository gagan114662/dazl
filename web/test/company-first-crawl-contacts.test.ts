import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { markCompanyFirstBudget } from '../lib/company-first/product-discovery.ts'
import { enrichmentsForLeads } from '../lib/connectors/store.ts'

const now=Date.parse('2026-11-13T12:00:00Z')
const host='brindleledger.com', origin='https://'+host, company='Brindle Ledger', name='Mira Quinn', title='Purchasing Director'
const email='mira.quinn@'+host, shared='help@'+host, team=origin+'/team'
const prose='<p>Brindle Ledger has served its local community for many years. We help businesses find the right products and manage the process from start to finish with clear service and transparent information.</p>'
const wrap=(s:string)=>'<html><body>'+s+'</body></html>'
const card=(role=title,address=email)=>'<article><h2>'+name+'</h2><p>'+role+'</p><a href="mailto:'+address+'">'+address+'</a></article>'
async function fixture(markup:string,opt:{strict?:boolean;own?:boolean;international?:boolean; marker?:boolean; recrawl?:boolean}={}){
 const where=opt.international?'Toronto, ON':'Austin, TX'
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
  const get:Get=async url=>({status:pages[url]?200:404,body:pages[url]??'',finalUrl:url})
  const scan=()=>crawlJob(db,'T',job,{get,gapMs:0,now,env:{EMAIL_GUESS_ENABLED:'1'},...(opt.marker?{}:{companyFirstContacts:opt.strict!==false})})
  await scan()
  if(opt.recrawl){pages[team]=wrap(prose+card(title,shared)); await scan()}
  return {rows:(enrichmentsForLeads(db,'T',[lead])[lead]??[]).filter(r=>['person','email','phone'].includes(r.kind)),
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
