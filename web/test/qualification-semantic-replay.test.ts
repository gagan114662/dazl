import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {preparePrompt,parseQualification,qualifyLead} from '../lib/scan/lead-qualify.ts'
const f=JSON.parse(readFileSync(new URL('./fixtures/qualification-semantic/nettle-real-response.json',import.meta.url),'utf8'))
test('preserved real response: prompt identity, wrong semantic company-no remains an unverified model assessment, briefing quote fails closed',()=>{
 assert.equal(createHash('sha256').update(f.original_prompt).digest('hex'),f.original_prompt_sha256)
 const prep=preparePrompt(f.input,f.limits);assert.equal(prep.scope.any_truncated,false);assert.equal(prep.included.length,6)
 const q=parseQualification(f.raw_model_text,prep.included,prep.scope)
 // This is deliberately NOT an assertion that the no is correct. It documents the limit of
 // literal matching: a real founding quote is present, but the model's B2B category reading is wrong.
 assert.equal(q.company_fit.verdict,'no');assert.match(q.company_fit.note,/customers are insurance companies, not software companies/)
 assert.match(q.caveat,/none of this is a verified fit/)
 assert.equal(q.use_case.verdict,'unknown');assert.equal(q.use_case.rejected?.reason,'not_on_page')
 assert.equal(q.buying_evidence.verdict,'none_seen');assert.match(q.buying_evidence.note,/only the 6 page/)
})
test('general prompt separates target business model from customers and requires contradiction, not missing evidence',()=>{
 const p=preparePrompt({...f.input,company:'Different Company'}).prompt
 for(const phrase of ["TARGET company's own software business",'customers need not be software companies','explicit contradiction','not missing information','Existing CRM or in-house tools','Briefing text and related posts','Do not add or waive targeting conditions'])assert.ok(p.includes(phrase),phrase)
 assert.ok(!p.includes('Nettle must pass'));assert.ok(!p.includes('Nettle must fail'))
})
test('quote guards are symmetric for positive/negative: briefing alone cannot vouch for a verdict; genuine on-page no remains a model assessment',()=>{
 const url='https://synthetic.example/about',prep=preparePrompt({seller_offer:'CRM setup',seller_icp:'B2B SaaS',company:'Synthetic',signal:'Briefing: Synthetic is SaaS',pages:[{url,text:'Synthetic sells fresh bread directly to consumers, not software.'}]})
 for(const verdict of ['yes','no']){
  const q=parseQualification(JSON.stringify({company_fit:{verdict,quote:'Synthetic is SaaS',quote_url:url}}),prep.included,prep.scope)
  assert.equal(q.company_fit.verdict,'unknown');assert.equal(q.company_fit.rejected?.reason,'not_on_page')
 }
 const q=parseQualification(JSON.stringify({company_fit:{verdict:'no',quote:'Synthetic sells fresh bread directly to consumers, not software.',quote_url:url,note:'Business model contradicts software criterion'}}),prep.included,prep.scope)
 assert.equal(q.company_fit.verdict,'no');assert.equal(q.company_fit.rejected,undefined)
})
test('actual qualifyLead replay makes one synthetic provider request, preserves no/raw note, drops false quote and never calls another reviewer',async()=>{
 const prep=preparePrompt(f.input,f.limits);let calls=0
 const provider={configuredModel:()=> 'claude-sonnet-4-5',completeDetailed:async()=>{calls++;return{text:f.raw_model_text,model:f.served_model,usage:f.usage}}}as never
 const r=await qualifyLead(provider,'synthetic-only',f.input,{vendor:'anthropic',limits:f.limits,approval:{approved_by_user:true,vendor:'anthropic',model:'claude-sonnet-4-5',max_usd_estimate:1,prompt_sha256:prep.prompt_sha256,limits:f.limits}})
 assert.equal(calls,1);assert.equal(r.status,'done');if(r.status==='done'){assert.equal(r.qualification.company_fit.verdict,'no');assert.equal(r.qualification.use_case.verdict,'unknown');assert.equal(r.qualification.buying_evidence.verdict,'none_seen')}
})

test('real stored pipeline replay preserves lead review/eligibility and discloses the raw model judgment without a second paid request',async()=>{
 const {default:Database}=await import('better-sqlite3')
 const {migrateScan,createQueryJob}=await import('../lib/scan/store.ts')
 const {runQualification,storedQualifications}=await import('../lib/scan/qualify-run.ts')
 const {qualifyPreview}=await import('../lib/scan/qualify-preview.ts')
 const db=new Database(':memory:');migrateScan(db)
 db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,sells TEXT,website TEXT)');db.prepare('INSERT INTO users VALUES(?,?,?)').run('u','CRM setup and outbound sales consulting','')
 const job=createQueryJob(db,'u',{query:'Find B2B SaaS startups in London. We sell CRM setup and outbound sales consulting.'}),id='a'.repeat(24)
 db.prepare("UPDATE scan_jobs SET offer=?,status='running' WHERE id=?").run('CRM setup and outbound sales consulting',job)
 db.prepare('INSERT INTO leads(id,scan_job_id,company,signal,source_url,review_reason)VALUES(?,?,?,?,?,?)').run(id,job,'Nettle','Seed funding',f.input.pages[0].url,'needs_review')
 // The real pipeline's default page budget is intentional and is not expanded by this repair.
 const fetchPage=async()=>({title:'Nettle',text:f.input.pages[0].text,retrievedAt:1}),model='claude-sonnet-4-5'
 const p=await qualifyPreview(db,'u',id,'CRM setup and outbound sales consulting',fetchPage,'anthropic',model);assert.ok(p?.ready&&p.prompt_sha256&&p.cost)
 const before=db.prepare('SELECT * FROM leads').all();let calls=0
 const deps={enabled:true,sellerText:'CRM setup and outbound sales consulting',vendor:'anthropic',apiKey:'synthetic',fetchPage,provider:{configuredModel:()=>model,completeDetailed:async()=>{calls++;return{text:f.raw_model_text,model:f.served_model,usage:f.usage}}}as never}
 const approval={approved_by_user:true as const,vendor:'anthropic',model,max_usd_estimate:1,prompt_sha256:p.prompt_sha256,limits:p.cost.limits}
 const result=await runQualification(db,'u',id,approval,deps);assert.equal(result.status,'done');assert.equal(calls,1)
 assert.deepEqual(db.prepare('SELECT * FROM leads').all(),before)
 const stored=storedQualifications(db,'u',id)[0];assert.equal(stored.qualification?.company_fit.verdict,'no');assert.equal(stored.qualification?.use_case.verdict,'unknown');assert.match(stored.qualification!.caveat,/none of this is a verified fit/)
 assert.equal((await runQualification(db,'u',id,approval,deps)).status,'exists');assert.equal(calls,1);db.close()
})
