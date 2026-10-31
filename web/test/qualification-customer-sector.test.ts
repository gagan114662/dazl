import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {parseQualification,preparePrompt} from '../lib/scan/lead-qualify.ts'
const fixture=JSON.parse(readFileSync(new URL('./fixtures/qualification-semantic/nettle-real-response.json',import.meta.url),'utf8'))
test('two preserved paid Nettle responses: diagnose customer/target confusion without flipping raw verdict or other dimensions',()=>{
 const prep=preparePrompt(fixture.input,fixture.limits)
 for(const raw of [fixture.raw_model_text,fixture.comparative_response.raw_model_text]){
  assert.equal(typeof raw,'string')
  const original=parseQualification(raw,prep.included,prep.scope),q=parseQualification(raw,prep.included,prep.scope,fixture.input.seller_icp)
  assert.equal(q.company_fit.verdict,'no');assert.equal(q.company_fit.quote,original.company_fit.quote);assert.equal(q.company_fit.note,original.company_fit.note)
  assert.equal(q.company_fit.assessment_conflict?.kind,'customer_sector_not_target_business')
  assert.deepEqual(q.use_case,original.use_case);assert.deepEqual(q.buying_evidence,original.buying_evidence);assert.equal(q.use_case.verdict,'unknown');assert.equal(q.buying_evidence.verdict,'none_seen')
 }
})
const url='https://synthetic.example/about',quote='Synthetic sells a software platform to business customers.'
const prep=preparePrompt({seller_offer:'CRM setup',seller_icp:'B2B SaaS in London',company:'Synthetic',signal:'Funding',pages:[{url,text:quote}]})
function grade(note:string,verdict='no',criteria='B2B SaaS in London'){return parseQualification(JSON.stringify({company_fit:{verdict,quote,quote_url:url,note}}),prep.included,prep.scope,criteria).company_fit}
test('diagnostic is sector-generic but only explicit flawed negative premise, not broad unknown rewrite or positive qualification',()=>{
 for(const sector of ['insurance companies','hospitals','manufacturers','retailers'])assert.ok(grade(`Their customers are ${sector}, not software companies.`).assessment_conflict)
 for(const note of ['They sell only bread, not software.','The company headquarters is outside the UK.','Customers include insurers; the target itself is an insurance carrier, not a software seller.','The target sells software but its subscription model is not shown.','The evidence is about another company.','They do not sell a hosted software product.'])assert.equal(grade(note).assessment_conflict,undefined,note)
 assert.equal(grade('Their customers are insurance companies, not software companies.','yes').assessment_conflict,undefined)
 assert.equal(grade('Their customers are insurance companies, not software companies.','unknown').assessment_conflict,undefined)
 for(const criteria of ['Companies selling to software companies only','B2B SaaS startups selling to software companies only','B2B SaaS; customers must be software companies','B2B software targeting software companies','B2B SaaS serving software companies','B2B SaaS sells to B2B software businesses','B2B SaaS serves only software vendors'])assert.equal(grade('Their customers are insurance companies, not software companies.','no',criteria).assessment_conflict,undefined)
})

test('synthetic provider replay and stored pipeline return diagnostic without new request or lead eligibility mutation',async()=>{
 const {default:Database}=await import('better-sqlite3'),{migrateScan,createQueryJob}=await import('../lib/scan/store.ts'),{runQualification,storedQualifications}=await import('../lib/scan/qualify-run.ts'),{qualifyPreview}=await import('../lib/scan/qualify-preview.ts')
 const db=new Database(':memory:');migrateScan(db);db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,sells TEXT,website TEXT)');db.prepare('INSERT INTO users VALUES(?,?,?)').run('u','CRM setup and outbound sales consulting','')
 const job=createQueryJob(db,'u',{query:'Find B2B SaaS startups in London. We sell CRM setup and outbound sales consulting.'}),id='a'.repeat(24)
 db.prepare("UPDATE scan_jobs SET offer=?,status='running' WHERE id=?").run('CRM setup and outbound sales consulting',job)
 db.prepare('INSERT INTO leads(id,scan_job_id,company,signal,source_url,review_reason)VALUES(?,?,?,?,?,?)').run(id,job,'Nettle','Seed funding',fixture.input.pages[0].url,'needs_review')
 const fetchPage=async()=>({title:'Nettle',text:fixture.input.pages[0].text,retrievedAt:1}),model='claude-sonnet-4-5',p=await qualifyPreview(db,'u',id,'CRM setup and outbound sales consulting',fetchPage,'anthropic',model);assert.ok(p?.ready&&p.prompt_sha256&&p.cost)
 const before=db.prepare('SELECT * FROM leads').all();let calls=0
 const deps={enabled:true,sellerText:'CRM setup and outbound sales consulting',vendor:'anthropic',apiKey:'synthetic',fetchPage,provider:{configuredModel:()=>model,completeDetailed:async()=>{calls++;return{text:fixture.raw_model_text,model:fixture.served_model,usage:fixture.usage}}}as never}
 const approval={approved_by_user:true as const,vendor:'anthropic',model,max_usd_estimate:1,prompt_sha256:p.prompt_sha256,request_context_sha256:p.packing!.context_sha256,limits:p.cost.limits}
 assert.equal((await runQualification(db,'u',id,approval,deps)).status,'done');const q=storedQualifications(db,'u',id)[0].qualification!;assert.equal(q.company_fit.verdict,'no');assert.equal(q.company_fit.assessment_conflict?.kind,'customer_sector_not_target_business');assert.equal(q.use_case.verdict,'unknown');assert.equal(q.buying_evidence.verdict,'none_seen');assert.deepEqual(db.prepare('SELECT * FROM leads').all(),before)
 assert.equal((await runQualification(db,'u',id,approval,deps)).status,'exists');assert.equal(calls,1);db.close()
})


test('mixed rejection grounds remain a raw no, only matched customer comparison is flagged',()=>{
 for(const other of ['No evidence of seed funding or sales hiring.','Headquarters are outside London.','The target itself sells insurance, not software.','The page is about another company.']){
  const note=`${other} Their customers are dentists, not software companies.`,q=grade(note)
  assert.equal(q.verdict,'no');assert.equal(q.note,note)
  assert.equal(q.assessment_conflict?.premise,'customers are dentists, not software companies')
  assert.match(q.assessment_conflict!.note,/only the quoted customer comparison, not the entire no/)
  assert.match(q.assessment_conflict!.note,/Other rejection reasons may still apply/)
  assert.doesNotMatch(q.assessment_conflict!.note,/do not use this assessment|disputed model assessment/i)
 }
})
