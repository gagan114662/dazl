import test from 'node:test'
import assert from 'node:assert/strict'
import{readFileSync}from'node:fs'
import{pgDb}from'../lib/db/client.ts'
import{runPgMigrations}from'../lib/db/migrate-pg.ts'
import{PG_URL,pgSkip,freshSchema}from'./helpers/pg-test.ts'
import{evidenceRecheck}from'../lib/scan/evidence-recheck.ts'
test('[pg] saved-play recheck preserves exact offer/lead, isolates tenant and refuses changed context',{skip:pgSkip},async()=>{
 const schema=await freshSchema(),db=pgDb({connectionString:PG_URL!,searchPath:schema.schema})
 try{await runPgMigrations(db.pool)
 await db.run("INSERT INTO users(id,email,password_hash,salt,sells)VALUES('recheck-u','recheck@example.test','x','y','Dental software')")
 const icp=JSON.stringify({summary:'London SaaS',who:[],industries:[],sizes:[],where:['London','UK'],signals:['seed'],exclude:[],window_days:90})
 await db.run("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,query,offer,icp)VALUES('recheck-j','recheck-u','Request','SaaS','London','running',?,?,?)",['Find London startups funded in the last 90 days. We sell CRM consulting.','CRM consulting',icp])
 const id='a'.repeat(24)
 await db.run("INSERT INTO leads(id,scan_job_id,company,signal,source_url,evidence_excerpt,event_date,review_reason)VALUES(?,'recheck-j','Revnu','Raised seed funding',?,?,'2026-10-01','counterparty_signal')",[id,'https://www.saasrise.com/deals/ai-sales-startup-revnu-raises-us30m-26m-to-build-team-and-accelerate-international-growth-bef3a306-10e4-4880-baf1-1c7eab95dfc1','AI sales startup Revnu secured US$3.0 million (€2.6 million) in a venture round on Oct. 1, 2026, led by NPIF II – PXN Equity Finance and joined by Y Combinator'])
 const before=await db.get('SELECT * FROM leads WHERE id=?',[id]),page=JSON.parse(readFileSync(new URL('./fixtures/349-revnu-source.json',import.meta.url),'utf8'))
 let calls=0;const fetcher=async()=>{calls++;return page}
 assert.equal(await evidenceRecheck(db,'other',id,fetcher),null);assert.equal(calls,0)
 const p=await evidenceRecheck(db,'recheck-u',id,fetcher,new Date('2026-10-31T05:00:00Z'))
 assert.equal(p?.offer,'CRM consulting');assert.equal(p?.checks?.place,'mismatch');assert.equal(p?.can_draft,false);assert.deepEqual(await db.get('SELECT * FROM leads WHERE id=?',[id]),before)
 const stale=await evidenceRecheck(db,'recheck-u',id,async()=>{await db.run("UPDATE scan_jobs SET offer='changed' WHERE id='recheck-j'");return page});assert.equal(stale?.status,'not_checked')
 }finally{await db.close();await schema.drop()}
})
