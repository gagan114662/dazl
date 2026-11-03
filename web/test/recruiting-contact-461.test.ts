// #461 original acceptance and the same rule at legacy scoreboard/draft boundaries. Synthetic only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyEvidence } from '../lib/scan/evidence.ts'
import { isReachable, scoreLead } from '../lib/scan/scoreboard.ts'
import { classifyPurpose, publishedEmail } from '../lib/outreach/published-email.ts'
const NOW = new Date('2026-10-20T12:00:00Z')
const quote = 'Lakeshore Creative opened a new office in Liberty Village, Toronto, ON'
const hiring = ['careers','jobs','recruiting','talent','hr','hiring','apply','cv','join-us','CAREERS','careers+toronto','talent.acquisition','human_resources','recruitment','resume','job','career','applications','join_us']
const buyers = ['hello','sales','jane.doe','jobsworth','hrishi','talented','application.engineer']
const verify = (local: string) => verifyEvidence({name:'',company:'Lakeshore Creative',contact:`${local}@lakeshore.example`,signal:'Opened a new office',source_url:'https://news.example/a',score:70,excerpt:quote,event_date:'2026-10-12'}, {title:'Lakeshore Creative',text:`On October 12, 2026, ${quote}. Apply: ${local}@lakeshore.example. `+'The agency builds campaigns for businesses in Toronto. '.repeat(6),retrievedAt:NOW.getTime()}, NOW)
test('#461 hiring inbox removed but genuine event stays source-checked, score cannot use primary or enrichment route',()=>{
 for(const local of hiring) {
  const v=verify(local); assert.equal(v.ok,true,local); if(v.ok) assert.equal(v.contact,null,local)
  const email=`${local}@lakeshore.example`
  assert.equal(isReachable(email),false,email)
  assert.equal(isReachable(`Recruitment desk <${email}>`),false,email)
  assert.equal(scoreLead({name:'',contact:email,contacts:[],event_date:'2026-10-12',fit:5,review_reason:null},NOW).reachable,false,email)
  assert.equal(scoreLead({name:'',contact:null,contacts:[email],event_date:'2026-10-12',fit:5,review_reason:null},NOW).qualified,false,email)
  assert.equal(classifyPurpose(email).purpose,'non-sales',email)
  assert.equal(publishedEmail({contact:email}),null,email)
 }
})
test('#461 whole-mailbox lookalikes and genuine published buyer routes unchanged',()=>{
 for(const local of buyers) {
  const email=`${local}@lakeshore.example`,v=verify(local); assert.equal(v.ok,true,email);if(v.ok)assert.equal(v.contact,email,email)
  assert.equal(isReachable(email),true,email)
  assert.notEqual(classifyPurpose(email).purpose,'non-sales',email)
 }
 assert.equal(isReachable('+1 (416) 555-0199'),true)
 assert.equal(isReachable('careers@agency20265550199.example'),false,'phone-like digits inside a hiring email are not a telephone')
 assert.equal(isReachable('careers@lakeshore.example or sales@lakeshore.example'),true)
 assert.equal(isReachable('careers@lakeshore.example; +1 (416) 555-0199'),true)
 assert.equal(isReachable('careers@lakeshore.example; hr@another.example'),false)
})

import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createDraft } from '../lib/outreach/service.ts'
import { contactPurposeRestricted } from '../lib/outreach/contact-purpose-db.ts'
import { bothEngines } from './helpers/engines.ts'
import { isRecruitingInbox } from '../lib/recruiting-inbox.ts'
test('#461 legacy direct and crawled contacts refused by real draft path without writes; tenant isolation',()=>{
 const db=new Database(':memory:');migrateAllSqlite(db)
 db.prepare("INSERT INTO users(id,email,password_hash,salt,business_name,sells)VALUES('A','a@seller.test','x','y','Seller','CRM services')").run()
 db.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,seller)VALUES('job','A','Seller','i','l','running','CRM services')").run()
 for(const [i,local]of hiring.entries()) {
  const id=`lead${i}`,email=`${local}@lakeshore.example`
  db.prepare("INSERT INTO leads(id,scan_job_id,name,company,contact,signal,source_url,evidence_excerpt,confidence,human_confirmed_at,event_date)VALUES(?,'job','Pat','Lakeshore Creative',?,'Opened office','https://news.example/a','Lakeshore Creative opened an office',80,1,?)").run(id,email,new Date(Date.now()-3*86400000).toISOString().slice(0,10))
  assert.equal(contactPurposeRestricted(db,'A',id,email),true,email)
  assert.equal(contactPurposeRestricted(db,'B',id,email),false,'tenant B learns nothing')
  assert.throws(()=>createDraft(db,'A',id,'Seller'),/not_sales_contact/,email)
  db.prepare('UPDATE leads SET contact = NULL WHERE id = ?').run(id)
  db.prepare("INSERT INTO lead_enrichments(id,lead_id,tenant_id,connector,kind,value,label,source_url,source_date,retrieved_at)VALUES(?,?,'A','sitecrawl','email',?,'','https://lakeshore.example/contact','2026-10-20',1)").run(`e${i}`,id,email)
  assert.throws(()=>createDraft(db,'A',id,'Seller'),/not_sales_contact/,`crawled ${email}`)
 }
 assert.equal((db.prepare('SELECT count(*) n FROM outreach_messages').get() as {n:number}).n,0)
 db.close()
})
test('#461 classifier anchored on whole local part, tags and punctuation never hide purpose',()=>{
 for(const v of ['Careers+sales@x.example','join-us@x.example','h.r@x.example','human_resources@x.example'])assert.equal(isRecruitingInbox(v),true,v)
 for(const v of ['jobsworth@x.example','hrishi@x.example','jane.doe@x.example','job.sworth@x.example','jobs@x@evil.example','jobs'])assert.equal(isRecruitingInbox(v),false,v)
})

// Persistence adapter parity: a stored primary/enriched hiring route never counts as reachable.
bothEngines('#461 stored recruiting contacts retain event but never inflate reachability', async ({db}) => {
 await db.run("INSERT INTO users(id,email,password_hash,salt)VALUES('A','a@x.example','x','y')")
 await db.run("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status)VALUES('job','A','Seller','i','l','running')")
 for (const [i,local] of hiring.entries()) {
  const email=local+'@lakeshore.example'
  await db.run("INSERT INTO leads(id,scan_job_id,company,name,contact,signal,source_url,evidence_excerpt,confidence,event_date)VALUES(?,'job','Lakeshore Creative','',?,'Opened office','https://news.example/a','Lakeshore Creative opened a new office',80,'2026-10-12')",['l'+i,email])
  const row=await db.get<{contact:string;review_reason:string|null;event_date:string;name:string}>('SELECT contact,review_reason,event_date,name FROM leads WHERE id=?',['l'+i])
  assert.ok(row);const card=scoreLead({...row,fit:5,contacts:[email]},NOW)
  assert.equal(card.verified,true);assert.equal(card.recent,true);assert.equal(card.reachable,false);assert.equal(card.qualified,false)
 }
})
