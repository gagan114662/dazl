import {test} from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {migrateScan,createJob} from '../lib/scan/store.ts'
import {migrateOutreach} from '../lib/outreach/store.ts'
import {migrateConnectors} from '../lib/connectors/store.ts'
import {messageProvenance,publicSourceUrl} from '../lib/outreach/provenance.ts'
import {listMessages} from '../lib/outreach/service.ts'
function setup(){
 const db=new Database(':memory:');migrateScan(db);migrateOutreach(db);migrateConnectors(db)
 const job=createJob(db,'A',{business_name:'Seller',industry:'x',location:'y'})
 db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
 db.prepare('INSERT INTO leads(id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,event_date,date_status,confidence) VALUES(?,?,?,?,?,?,?,?,?,?)').run('lead',job,'Acme','hello@acme.example','Hiring SDRs','https://acme.example/jobs','Acme is hiring an SDR.','2026-10-01','unverified',null)
 return db
}
test('provenance exposes exact current claims and contact match, never upgrades human/quote/date verification',()=>{
 const db=setup();const before=db.serialize();const p=messageProvenance(db,'A','lead',' HELLO@acme.example ')
 assert.deepEqual(p,{company:'Acme',signal:'Hiring SDRs',excerpt:'Acme is hiring an SDR.',source_url:'https://acme.example/jobs',event_date:'2026-10-01',date_status:'unverified',contact_origin:'lead_record',contact_source_url:null})
 assert.deepEqual(db.serialize(),before)
 db.prepare("UPDATE leads SET human_confirmed_at=123 WHERE id='lead'").run()
 assert.deepEqual(messageProvenance(db,'A','lead','hello@acme.example'),p)
})
test('cross-tenant and missing/deleted lead return no private context',()=>{
 const db=setup();assert.equal(messageProvenance(db,'B','lead','hello@acme.example'),null);assert.equal(messageProvenance(db,'A','absent','hello@acme.example'),null)
 db.prepare("DELETE FROM leads WHERE id='lead'").run();assert.equal(messageProvenance(db,'A','lead','hello@acme.example'),null)
})
test('edited or unmatched recipient remains unknown and cannot inherit another contact source',()=>{
 const db=setup();const p=messageProvenance(db,'A','lead','other@acme.example')!;assert.equal(p.contact_origin,'unknown');assert.equal(p.contact_source_url,null)
 assert.equal(messageProvenance(db,'A','lead','')!.contact_origin,'unknown')
})
test('sitecrawl requires same tenant, same lead and exact recipient, selects latest matching record',()=>{
 const db=setup();const ins=db.prepare('INSERT INTO lead_enrichments(id,lead_id,tenant_id,connector,kind,value,source_url,source_date,retrieved_at) VALUES(?,?,?,?,?,?,?,?,?)')
 ins.run('foreign','lead','B','sitecrawl','email','sales@acme.example','https://private.example/secret','2026-10-01',500)
 ins.run('otherlead','different','A','sitecrawl','email','sales@acme.example','https://other.example','2026-10-01',400)
 ins.run('notmail','lead','A','apollo','contact','sales@acme.example','https://apollo.example','2026-10-01',300)
 assert.equal(messageProvenance(db,'A','lead','sales@acme.example')!.contact_origin,'unknown')
 db.prepare("DELETE FROM lead_enrichments WHERE id='foreign'").run()
 ins.run('match','lead','A','sitecrawl','email','sales@acme.example','https://acme.example/contact','2026-10-01',100)
 ins.run('newwrong','lead','A','sitecrawl','email','unrelated@acme.example','https://acme.example/about','2026-10-01',200)
 const p=messageProvenance(db,'A','lead','sales@acme.example')!;assert.equal(p.contact_origin,'sitecrawl_record');assert.equal(p.contact_source_url,'https://acme.example/contact')
})
test('links accept only http/https without embedded credentials; unsafe stored links not returned',()=>{
 for(const s of ['javascript:alert(1)','data:text/html,x','https://user:pass@acme.example','/relative','not-url',null]) assert.equal(publicSourceUrl(s),null)
 assert.equal(publicSourceUrl('https://acme.example/jobs'),'https://acme.example/jobs')
 const db=setup();db.prepare("UPDATE leads SET source_url='https://user:pass@acme.example' WHERE id='lead'").run();const p=messageProvenance(db,'A','lead','hello@acme.example')!;assert.equal(p.source_url,null);assert.equal(p.contact_source_url,null)
})
test('listMessages includes only its tenants context without modifying draft, approval, status or sent fields',()=>{
 const db=setup();db.prepare("INSERT INTO outreach_messages(id,tenant_id,lead_id,to_email,subject,body,status) VALUES('m','A','lead','hello@acme.example','Subject','A sufficiently long draft body.','draft')").run()
 const before=db.prepare('SELECT * FROM outreach_messages').all();const m=listMessages(db,'A')[0];assert.equal(m.provenance?.company,'Acme');assert.equal(listMessages(db,'B').length,0);assert.deepEqual(db.prepare('SELECT * FROM outreach_messages').all(),before)
})
test('missing enrichment table and empty contact do not invent an origin',()=>{
 const db=setup();db.exec('DROP TABLE lead_enrichments');db.prepare("UPDATE leads SET contact=NULL,event_date=NULL,date_status='undated' WHERE id='lead'").run()
 const p=messageProvenance(db,'A','lead','other@acme.example')!;assert.equal(p.contact_origin,'unknown');assert.equal(p.event_date,null);assert.equal(p.date_status,'undated')
})
