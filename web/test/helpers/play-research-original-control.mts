// One-off local acceptance proof from read-only original control and previously fetched pages.
import fs from 'node:fs'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {migrateAllSqlite} from '../../lib/db/sqlite-migrations.ts'
import {savePlayResearch,playResearchCards} from '../../lib/scan/play-research.ts'
import {draftBlockReason} from '../../lib/outreach/service.ts'
const {control,pages}=JSON.parse(fs.readFileSync(process.env.RESEARCH_CONTROL!,'utf8'))
const d=new Database(':memory:');migrateAllSqlite(d)
const j=control.play,tenant=j.user_id
d.prepare("INSERT INTO users(id,email,password_hash,salt) VALUES(?,'local-proof@example.test','proof','proof')").run(tenant)
d.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,query,icp,offer,created_at) VALUES(?,?,'Original London CRM','SaaS','London','running',?,?,?,?)").run(j.id,tenant,j.query,j.icp,j.offer,j.created_at)
for(const l of control.leads)d.prepare('INSERT INTO leads(id,scan_job_id,company,name,contact,signal,source_url,event_date,review_reason,confidence,fit,intent,evidence_excerpt,human_confirmed_at,quarantined_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(l.id,j.id,l.company,l.name,l.contact,l.signal,l.source_url,l.event_date,l.review_reason,l.confidence,l.fit,l.intent,l.evidence_excerpt,l.human_confirmed_at,l.quarantined_at)
d.prepare("UPDATE scan_jobs SET status='done' WHERE id=?").run(j.id)
const snapshot=()=>JSON.stringify({job:d.prepare('SELECT * FROM scan_jobs').all(),leads:d.prepare('SELECT * FROM leads').all(),drafts:d.prepare('SELECT * FROM outreach_messages').all()})
const before=snapshot(),refusals=()=>control.leads.map((l:{id:string})=>({id:l.id,firstDraftRefusal:draftBlockReason(d,tenant,l.id)})),beforeRefusals=refusals()
const announcement=pages.find((p:{url:string})=>p.url==='https://epoch.blue/article/epoch-raises-6-26m'),person=pages.find((p:{url:string})=>p.url.includes('linkedin.com/posts/mario'))
const quote=announcement.page.text.match(/London, 26 October 2026.{0,390}/)[0].split(' Rather')[0]
const input={company:'Epoch',signal:'Own October 26 London announcement says launch follows closed $4.25M seed round; research only, no buying intent verified.',source_url:announcement.url,excerpt:quote,event_date:'2026-10-26',contact:null,person_name:'Mario Romero Garoz',person_role:'Head of Sales, EMEA',professional_url:person.url,person_excerpt:'New chapter: I’ve joined Epoch as Head of Sales, EMEA.'}
// Keep the exact quote within the product's bounded input, not a rewritten paraphrase.
input.excerpt=announcement.page.text.slice(announcement.page.text.indexOf('The launch follows'),announcement.page.text.indexOf(' Rather than'))
assert.ok(input.excerpt.length<=400)
const saved=await savePlayResearch(d,tenant,j.id,input,async url=>pages.find((p:{url:string})=>p.url===url).page)
assert.equal(snapshot(),before);assert.deepEqual(refusals(),beforeRefusals)
const card=playResearchCards(d,tenant,j.id)[0];assert.equal(card.source_check.quote_match,true);assert.equal(card.person_check?.quote_match,true);assert.equal(card.query_snapshot,j.query);assert.equal(card.offer_snapshot,j.offer);assert.equal(card.email_claim,null)
const proof={scratch_only:true,live_changes:false,paid_calls:0,original_control_as_of:control.checked_at,job_id:j.id,original_jobs_leads_drafts_unchanged:true,original_anchor:j.created_at,original_draft_refusals:beforeRefusals,after_draft_refusals:refusals(),saved,card}
fs.writeFileSync('/tmp/dazl-review/play-research-original-proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));d.close()
