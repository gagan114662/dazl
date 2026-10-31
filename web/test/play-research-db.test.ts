import assert from 'node:assert/strict'
import {bothEngines} from './helpers/engines.ts'
import {savePlayResearch,playResearchCards} from '../lib/scan/play-research.ts'
const job='a'.repeat(24),input={company:'Epoch',signal:'Announced seed round',source_url:'https://epoch.example/round',excerpt:'Epoch announced a seed round in London.',person_name:'Mario Example',person_role:'Head of Sales',professional_url:'https://people.example/mario',person_excerpt:'Mario Example joined Epoch as Head of Sales.'}
const fetcher=async(url:string)=>({title:'Epoch',text:url===input.source_url?input.excerpt:input.person_excerpt,retrievedAt:1793286117})
bothEngines('same-play research persists/reloads without changing finished job/leads/outreach; tenant and context boundaries',async({db})=>{
 await db.run("INSERT INTO users(id,email,password_hash,salt,sells) VALUES('A','research@example.test','proof','proof','CRM setup')")
 await db.run("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,query,offer,created_at) VALUES(?,'A','Original','SaaS','London','running','London SaaS seed in 90 days','CRM setup',1793286117)",[job])
 await db.run("INSERT INTO leads(id,scan_job_id,company,signal,source_url,review_reason) VALUES('old',?,'Revnu','Original held claim','https://old.example','counterparty_signal')",[job])
 await db.run("UPDATE scan_jobs SET status='done' WHERE id=?",[job])
 const snap=async()=>JSON.stringify({jobs:await db.all('SELECT * FROM scan_jobs'),leads:await db.all('SELECT * FROM leads'),drafts:await db.all('SELECT * FROM outreach_messages')})
 const before=await snap(),r=await savePlayResearch(db,'A',job,input,fetcher),card=(await playResearchCards(db,'A',job))[0]
 assert.equal(card.id,r.id);assert.equal(card.email_claim,null);assert.equal(card.professional_url,input.professional_url);assert.equal(card.source_check.quote_match,true);assert.equal(card.person_check?.quote_match,true);assert.equal(Number(card.play_created_at),1793286117);assert.equal(card.offer_snapshot,'CRM setup');assert.equal(await snap(),before)
 const duplicates=await Promise.all([savePlayResearch(db,'A',job,input,fetcher),savePlayResearch(db,'A',job,input,fetcher)]);assert.ok(duplicates.every(x=>x.id===r.id));assert.equal((await savePlayResearch(db,'A',job,input,fetcher)).id,r.id);assert.equal((await playResearchCards(db,'A',job)).length,1)
 assert.deepEqual(await playResearchCards(db,'B',job),[]);await assert.rejects(savePlayResearch(db,'B',job,input,fetcher),/Play not found/)
 await assert.rejects(savePlayResearch(db,'A',job,{...input,signal:'Changed'},async u=>{await db.run("UPDATE scan_jobs SET offer='Changed offer' WHERE id=?",[job]);return fetcher(u)}),/context changed/)
 assert.equal((await playResearchCards(db,'A',job)).length,1)
 await assert.rejects(db.run("INSERT INTO leads(id,scan_job_id,company,signal,source_url) VALUES('bad',?,'X','X','https://x.example')",[job]))
 await assert.rejects(db.run("UPDATE scan_jobs SET status='running' WHERE id=?",[job]))
})
bothEngines('research conflict rollback keeps original context and no supplemental row',async({db})=>{
 const id='c'.repeat(24)
 await db.run("INSERT INTO users(id,email,password_hash,salt) VALUES('C','c-research@example.test','test','test')")
 await db.run("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,query,seller) VALUES(?,'C','Original','SaaS','London','running','We sell CRM setup to SaaS companies.','CRM setup')",[id])
 await db.run("UPDATE scan_jobs SET status='done' WHERE id=?",[id])
 await assert.rejects(savePlayResearch(db,'C',id,input,async u=>{await db.run("INSERT INTO tenant_memory(tenant_id,positioning) VALUES('C','Changed context')");return fetcher(u)}),/context changed/)
 assert.deepEqual(await playResearchCards(db,'C',id),[])
})
