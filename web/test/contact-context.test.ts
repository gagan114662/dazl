import {test} from 'node:test'
import assert from 'node:assert/strict'
import {contactContext,contextLabel,readContextLabel} from '../lib/outreach/contact-context.ts'
import {classifyPurpose,publishedEmail} from '../lib/outreach/published-email.ts'
import {extractContacts} from '../lib/connectors/sitecrawl.ts'
import Database from 'better-sqlite3'
import {migrateScan} from '../lib/scan/store.ts'
import {migrateOutreach} from '../lib/outreach/store.ts'
import {createSourceReview,migrateSourceReview} from '../lib/scan/source-review.ts'
import {confirmLeadReview} from '../lib/scan/review-confirm.ts'
import {createDraft,approve,sendMessage} from '../lib/outreach/service.ts'
import {contactPurposeRestricted} from '../lib/outreach/contact-purpose-db.ts'

test('real public recruitment context rejects sales-localpart; publication is not buyer relevance',()=>{
 for(const [url,email,text] of [
 ['https://www.tequipy.com/careers/sdr-focused-on-calling','sales@tequipy.com','Send your CV to sales@tequipy.com along with a 60-second video introduction of yourself.'],
 ['https://www.wearecandidly.com/careers/sales-development-representative','sales@wearecandidly.com','Send your CV and a short note about why this role interests you to sales@wearecandidly.com.'],
 ['https://acme.example/contact','sales@acme.example','Email your resume to sales@acme.example.']]) {
  const c=contactContext(text,email,url);assert.equal(classifyPurpose(email,c).purpose,'non-sales');assert.equal(publishedEmail({contact:email,source_url:url,contact_context:c}),null)
 }
})
test('context is preserved in crawl label; ambiguous business address stays unknown, not named buyer or consent',()=>{
 const html='<p>Send your CV to sales@acme.example</p>'
 const f=extractContacts(html,'https://acme.example/contact','acme.example')[0]
 assert.equal(classifyPurpose(f.value,readContextLabel(f.label,f.url)).purpose,'non-sales')
 assert.equal(classifyPurpose('sales@acme.example').purpose,'unknown')
 assert.equal(classifyPurpose('sales@acme.example',{excerpt:'For sales inquiries contact sales@acme.example',source_url:'https://acme.example/contact'}).purpose,'sales')
 const c={excerpt:'"'.repeat(240),source_url:'https://acme.example/contact'};assert.ok(contextLabel(c).length<=200);assert.ok(readContextLabel(contextLabel(c),c.source_url))
})
test('source context persists and human review never upgrades recruitment to sales; tenant isolation',async()=>{
 const db=new Database(':memory:');migrateScan(db);migrateOutreach(db);migrateSourceReview(db)
 const email='sales@acme.example',source_url='https://acme.example/contact',excerpt='Acme is hiring an outbound sales representative.'
 const r=await createSourceReview(db,'A',{company:'Acme',signal:'A supplied hiring claim',excerpt,contact:email,source_url,event_date:null},async()=>({title:'Acme',text:excerpt+' Send your CV to '+email,retrievedAt:1800000000}))
 assert.equal(contactPurposeRestricted(db,'A',r.lead_id,email),true);assert.equal(contactPurposeRestricted(db,'B',r.lead_id,email),false)
 confirmLeadReview(db,'A',r.lead_id)
 assert.throws(()=>createDraft(db,'A',r.lead_id,'Seller'),/not_sales_contact/)
 const msg='m'.repeat(24);db.prepare("INSERT INTO outreach_messages(id,tenant_id,lead_id,to_email,subject,body,status,approved_hash) VALUES(?,'A',?,?,'Saved words','These original words must remain untouched.','approved','old-hash')").run(msg,r.lead_id,email)
 const original=db.prepare('SELECT * FROM outreach_messages').get()
 await assert.rejects(sendMessage(db,'A',msg),/not_sales_contact/);assert.deepEqual(db.prepare('SELECT * FROM outreach_messages').get(),original)
})

test('accented resume and c.v. application wording restrict even sales-localpart',()=>{
 for(const term of ['resumé','résumé','c.v.','CV','resume'])assert.equal(classifyPurpose('sales@acme.example',{excerpt:'Send your '+term+' to sales@acme.example',source_url:'https://acme.example/contact'}).purpose,'non-sales')
})
