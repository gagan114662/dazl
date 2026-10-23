import {test} from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {migrateScan} from '../lib/scan/store.ts'
import {migrateOutreach} from '../lib/outreach/store.ts'
import {createDraft} from '../lib/outreach/service.ts'
import {createSourceReview,migrateSourceReview,parseSourceReview,sourceCheckForLead} from '../lib/scan/source-review.ts'
const input={company:'Acme',signal:'Acme needs a sales tool (supplied claim)',source_url:'https://acme.example/jobs',excerpt:'Acme is hiring an outbound sales representative.',contact:'hello@acme.example',event_date:'2026-10-01'}
const page={title:'Acme careers',text:input.excerpt+' Contact hello@acme.example',retrievedAt:1800000000}
function setup(){const db=new Database(':memory:');migrateScan(db);migrateOutreach(db);migrateSourceReview(db);return db}
test('exact checks preserve supplied claims, stay needs-review and cannot create draft',async()=>{
 const db=setup();let calls=0;const r=await createSourceReview(db,'A',input,async u=>{calls++;assert.equal(u,input.source_url);return page})
 assert.equal(calls,1);assert.deepEqual(r.check,{fetch_status:'fetched',quote_match:true,company_named:true,contact_match:true,checked_at:page.retrievedAt})
 const l=db.prepare('SELECT * FROM leads WHERE id=?').get(r.lead_id) as Record<string,unknown>
 assert.equal(l.signal,input.signal);assert.equal(l.evidence_excerpt,input.excerpt);assert.equal(l.contact,input.contact);assert.equal(l.confidence,null);assert.equal(l.human_confirmed_at,null);assert.equal(l.fit,null);assert.equal(l.intent,null);assert.equal(l.date_status,'unverified');assert.equal(l.event_date,input.event_date);assert.equal(l.review_reason,'source_review_required')
 assert.throws(()=>createDraft(db,'A',r.lead_id,'Seller'),/lead_not_verified/)
 const j=db.prepare('SELECT status,verified,needs_review FROM scan_jobs WHERE id=?').get(r.job_id);assert.deepEqual(j,{status:'done',verified:0,needs_review:1})
 const raw=db.prepare('SELECT input_json FROM source_reviews').get() as {input_json:string};assert.deepEqual(JSON.parse(raw.input_json),{...input,contact_context:{excerpt:page.text,source_url:input.source_url}})
 assert.equal(sourceCheckForLead(db,'B',r.lead_id),null);assert.deepEqual(sourceCheckForLead(db,'A',r.lead_id),r.check)
})
test('blocked/failed source preserves all original claims but does not retain unchecked contact as eligible',async()=>{
 for(const fail of ['blocked','refused','js_required','not_found','error'] as const){const db=setup();const r=await createSourceReview(db,'A',input,async()=>({fail}));assert.equal(r.check.fetch_status,fail);assert.equal(r.check.quote_match,false);assert.equal(r.check.contact_match,false);assert.equal((db.prepare('SELECT contact FROM leads').get() as {contact:null}).contact,null);assert.throws(()=>createDraft(db,'A',r.lead_id,'Seller'),/lead_not_verified/)}
})
test('matching quote does not mean company, contact, date or signal meaning is verified',async()=>{
 const db=setup();const r=await createSourceReview(db,'A',{...input,company:'DifferentCo'},async()=>({...page,title:'Jobs'}));assert.equal(r.check.company_named,false);assert.equal(r.check.quote_match,true)
 const r2=await createSourceReview(db,'A',input,async()=>({...page,text:input.excerpt+' xhello@acme.example.evil'}));assert.equal(r2.check.contact_match,false)
 const r3=await createSourceReview(db,'A',{...input,excerpt:'A fabricated quote that names Acme'},async()=>page);assert.equal(r3.check.quote_match,false);assert.equal(r3.check.company_named,false)
})
test('invalid inputs rejected before fetch or write; impossible dates and unsafe URL shapes fail',async()=>{
 for(const edit of [{company:''},{signal:' '},{excerpt:'short'},{source_url:'http://acme.example'},{source_url:'https://user:pass@acme.example'},{source_url:'https://acme.example:8443/a'},{event_date:'2026-02-30'},{event_date:'2026-2-01'},{contact:'not an email'},{signal:'x'.repeat(501)}]){const db=setup();let calls=0;await assert.rejects(createSourceReview(db,'A',{...input,...edit},async()=>{calls++;return page}));assert.equal(calls,0);assert.equal((db.prepare('SELECT count(*) n FROM leads').get() as {n:number}).n,0)}
 assert.equal(parseSourceReview({...input,event_date:'2028-02-29'}).event_date,'2028-02-29');assert.equal(parseSourceReview({...input,event_date:'',contact:''}).event_date,null)
})
test('thrown fetch fails closed and tenant linkage prevents orphan/cross-job source metadata disclosure',async()=>{
 const db=setup();const r=await createSourceReview(db,'A',input,async()=>{throw new Error('network')});assert.equal(r.check.fetch_status,'error');assert.equal(sourceCheckForLead(db,'A','missing'),null)
 db.prepare("UPDATE source_reviews SET tenant_id='B'").run();assert.equal(sourceCheckForLead(db,'A',r.lead_id),null);assert.equal(sourceCheckForLead(db,'B',r.lead_id),null)
})
