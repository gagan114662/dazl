import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { addEnrichment } from '../lib/connectors/store.ts'
import { markCompanyFirstBudget } from '../lib/company-first/product-discovery.ts'
import { COMPANY_FIRST_ROLE_LABEL, migrateCompanyFirstPublishedDisplay, recordCompanyFirstPublishedDisplay } from '../lib/people/company-first-published-display.ts'
import { recordActionability, verifiedCompanyFirstDisplay } from '../lib/scan/actionable.ts'
import { recordNeedEvidence } from '../lib/scan/need-evidence.ts'
import { recordTimingProof } from '../lib/scan/timing-proof.ts'
import { companyFirstResults } from '../lib/scan/company-first-results.ts'
import { currentnessHeld } from '../lib/outreach/currentness.ts'
import { publishedCandidateFor, recordEmailGuesses, usEvidence, verifyCandidates } from '../lib/people/email-pattern.ts'
import { findWorkEmail, strictPublishedWorkEmailsForLeads, workEmailsFor } from '../lib/people/work-email.ts'
import { targetKey } from '../lib/people/work-email-eligible.ts'
import { approveBlockReason, createDraft, domainReviewStatus, draftBlockReason, sendBlockReason, sendMessage } from '../lib/outreach/service.ts'

for (const [country, market, host] of [
  ['CA', 'Toronto, Ontario, Canada', 'riverledger.ca'],
  ['UK', 'London, England, United Kingdom', 'riverledger.co.uk'],
] as const) test(`${country}: verified company-first published email stays display-only through lookup, draft, approval and send`, async () => {
  const db = new Database(':memory:')
  try {
    migrateAllSqlite(db)
    migrateCompanyFirstPublishedDisplay(db)
    const tenant = 'display-test-owner', id = '1'.repeat(24), lead = '2'.repeat(24)
    const now = new Date(), at = Math.floor(now.getTime() / 1000)
    const day = new Date(now.getTime() - 3 * 86_400_000).toISOString().slice(0, 10)
    const query = 'Companies hiring sales reps', icp = JSON.stringify({ who: ['Owner'], where: [market], window_days: 20 })
    const team = `https://${host}/team`, signalPage = `https://${host}/vacancy`
    const role = 'Ada Lane, Owner', address = `ada.lane@${host}`
    db.prepare("INSERT INTO users (id,email,business_name,password_hash,salt) VALUES (?, 'owner@example.test','Seller','salted','salt')").run(tenant)
    db.prepare("INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status,attempts,query,icp,run_budget) VALUES (?,?,'Seller','-','-','running',1,?,?,?)").run(id,tenant,query,icp,markCompanyFirstBudget(null))
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, confidence, fit, score, signal, signal_kind, source_url, evidence_excerpt, event_date, event_date_proof, company_domain) VALUES (?,?,'','River Ledger',80,5,75,'Open sales representative vacancy','hiring',?,?,?,'page_bound',?)")
      .run(lead,id,signalPage,`River Ledger posted a sales representative vacancy on ${day}.`,day,host)
    const add = (connector:string,kind:string,value:string,label:string|null,url:string) => addEnrichment(db,tenant,lead,{connector,kind,value,label,confidence:null,source_url:url,source_date:day,retrieved_at:at})
    add('sitecrawl','domain',`${host}|evidence_own_domain`,'domain-basis-v1:evidence_own_domain',signalPage)
    add('sitecrawl','person',role,COMPANY_FIRST_ROLE_LABEL+'Owner',team)
    add('scan:gate','gate_passed','requested_role_v1','role verified',signalPage)
    add('scan:gate','gate_passed','sales_hiring','role verified',signalPage)
    await recordCompanyFirstPublishedDisplay(sqliteDb(db),tenant,lead,id,1,{domain:host,person:role,address,source_url:team,role_quote:'Owner',observed_at:at})
    const job = {id,user_id:tenant,query,icp}
    const needs = await recordNeedEvidence(sqliteDb(db),tenant,id,{asOf:now,windowDays:20})
    assert.equal(needs.trigger_only, 1)
    const action = recordActionability(db,job)
    assert.equal(action.actionable,0)
    assert.equal(action.missing.no_published_contact,1)
    assert.deepEqual(recordTimingProof(db,job,now),{proven:0,held:1})
    assert.deepEqual(await verifiedCompanyFirstDisplay(db,tenant,id,[lead],now),{},'unfinished enrichment remains hidden')
    db.prepare("UPDATE scan_jobs SET status='done',candidates=1,dropped=0,enrich_finished_at=? WHERE id=? AND user_id=?").run(at,id,tenant)
    const rows = await verifiedCompanyFirstDisplay(db,tenant,id,[lead],now)
    assert.equal(rows[lead]?.address,address)
    assert.equal(rows[lead]?.display_only,true)
    const result = await companyFirstResults(sqliteDb(db),tenant,id,now)
    assert.deepEqual(result?.counts,{candidates:1,ready:0,reviewable:1,held:0,dropped:0})
    assert.equal(result?.visibleIds.has(lead),true)
    assert.equal(result?.readyIds.has(lead),false)

    assert.equal(currentnessHeld(db,tenant,lead,now),true)
    assert.equal(draftBlockReason(db,tenant,lead),'lead_currentness_unconfirmed')
    assert.equal(usEvidence('Portland, OR 97201',[market]).us,false,'explicit foreign scope cannot borrow a US homepage address')
    assert.equal(recordEmailGuesses(db,tenant,lead,host,['ada.lane'],[role],{
      env:{EMAIL_GUESS_ENABLED:'1'},where:[market],homeText:market,seen:[{address,url:team}],
    }),null)
    assert.equal(publishedCandidateFor(db,tenant,lead,'Ada Lane'),null)
    assert.equal(db.prepare("SELECT count(*) AS n FROM email_candidates WHERE tenant_id=? AND lead_id=?").pluck().get(tenant,lead),0)
    assert.deepEqual(strictPublishedWorkEmailsForLeads(db,tenant,[lead],at)[lead]??[],[])
    assert.deepEqual(workEmailsFor(db,tenant,lead,at),[])
    const lookup=await findWorkEmail(db,tenant,lead,targetKey({name:'Ada Lane',title:'Owner'}),{now:at,env:{}})
    assert.equal(lookup.status,'not_eligible')
    let verifies=0
    const verify=await verifyCandidates(db,tenant,lead,{name:'fixture-never-dispatch',verify:async()=>{
      verifies++
      throw new Error('display-only address reached a mailbox verifier')
    }},{address,env:{EMAIL_GUESS_ENABLED:'1',EMAIL_VERIFY_DAILY_CAP:'5',EMAIL_VERIFY_MONTHLY_CAP:'5'}})
    assert.equal(verify.checked,0)
    assert.equal(verify.skipped,null,'real verifier selection was enabled, not short-circuited by flags')
    assert.equal(verifies,0)

    assert.throws(()=>createDraft(db,tenant,lead,'Seller'),{code:'lead_currentness_unconfirmed'})
    assert.equal(db.prepare('SELECT count(*) FROM outreach_messages WHERE tenant_id=?').pluck().get(tenant),0)
    // A synthetic legacy draft/approval cannot launder a display-only recipient into a send.
    const msg='3'.repeat(24)
    db.prepare("INSERT INTO outreach_messages(id,tenant_id,lead_id,to_email,subject,body) VALUES (?,?,?,?,?,?)")
      .run(msg,tenant,lead,address,'Fixture subject','Fixture body for refusal only; never send.')
    assert.equal(approveBlockReason(db,tenant,msg,{skipAccount:true}),'lead_currentness_unconfirmed')
    db.prepare("UPDATE outreach_messages SET status='approved' WHERE id=?").run(msg)
    assert.equal(sendBlockReason(db,tenant,msg,{skipAccount:true}),'lead_currentness_unconfirmed')
    await assert.rejects(sendMessage(db,tenant,msg),{code:'lead_currentness_unconfirmed'})
    assert.deepEqual(db.prepare('SELECT status,attempts,claimed_at,sent_at FROM outreach_messages WHERE id=?').get(msg),
      {status:'approved',attempts:0,claimed_at:null,sent_at:null})

    // An independently published telephone route is sufficient for genuine machine currentness,
    // without making the separately displayed mailbox a recipient. Re-run the actual actionability
    // and timing recorders rather than dropping or patching the earlier hold.
    add('sitecrawl','phone','+1 416 555 0101','Company telephone',team)
    assert.equal(recordActionability(db,job).actionable,1)
    assert.deepEqual(recordTimingProof(db,job,now),{proven:1,held:0})
    assert.equal(currentnessHeld(db,tenant,lead,now),false)
    assert.equal((await verifiedCompanyFirstDisplay(db,tenant,id,[lead],now))[lead]?.address,address)
    const currentLookup=await findWorkEmail(db,tenant,lead,targetKey({name:'Ada Lane',title:'Owner'}),{now:at,env:{}})
    assert.equal(currentLookup.status,'not_found')
    assert.equal(draftBlockReason(db,tenant,lead),'no_email_contact')
    assert.throws(()=>createDraft(db,tenant,lead,'Seller'),{code:'no_email_contact'})
    const subject='Fixture subject', body='Fixture body for refusal only; never send.'
    const digest=createHash('sha256').update(JSON.stringify([address,subject,body])).digest('hex')
    db.prepare("UPDATE outreach_messages SET approved_hash=? WHERE id=?").run(digest,msg)
    assert.equal(sendBlockReason(db,tenant,msg,{skipAccount:true}),'recipient_provenance_missing')
    await assert.rejects(sendMessage(db,tenant,msg),{code:'recipient_provenance_missing'})
    assert.deepEqual(db.prepare('SELECT status,attempts,claimed_at,sent_at FROM outreach_messages WHERE id=?').get(msg),
      {status:'approved',attempts:0,claimed_at:null,sent_at:null})
    db.prepare("UPDATE outreach_messages SET status='draft' WHERE id=?").run(msg)
    assert.equal(approveBlockReason(db,tenant,msg,{skipAccount:true}),'recipient_provenance_missing')
    // A separate independently published email passes this authority check: no country/domain-wide denial.
    const independent='office@'+host
    add('sitecrawl','email',independent,'General business inquiries',team)
    assert.equal(domainReviewStatus(db,tenant,lead,' '+independent.toUpperCase()+' '),'ok')
    assert.equal(domainReviewStatus(db,tenant,lead,' '+address.toUpperCase()+' '),'recipient_provenance_missing')
    assert.deepEqual(await verifiedCompanyFirstDisplay(db,'different-owner',id,[lead],now),{})
    db.prepare("UPDATE leads SET event_date_proof=NULL WHERE id=?").run(lead)
    assert.deepEqual(await verifiedCompanyFirstDisplay(db,tenant,id,[lead],now),{},'the published address cannot replace a verified event')
  } finally { db.close() }
})

test('an independently published US Company First recipient keeps its existing candidate and draft path', async () => {
  const db = new Database(':memory:')
  try {
    migrateAllSqlite(db)
    const tenant='company-first-us-fixture', jobId='4'.repeat(24), lead='5'.repeat(24)
    const host='riverledger.example', address='ada.lane@'+host, team='https://'+host+'/team', signal='https://'+host+'/open'
    const role='Ada Lane, Owner', now=new Date(), at=Math.floor(now.getTime()/1000)
    const day=new Date(now.getTime()-3*86400000).toISOString().slice(0,10)
    const query='Companies hiring sales reps', icp=JSON.stringify({who:['Owner'],where:['Portland, Oregon, United States'],window_days:20})
    db.prepare("INSERT INTO users (id,email,business_name,password_hash,salt) VALUES (?, 'us-owner@example.test','Seller','salted','salt')").run(tenant)
    db.prepare("INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status,attempts,query,icp,run_budget) VALUES (?,?,'Seller','-','-','running',1,?,?,?)")
      .run(jobId,tenant,query,icp,markCompanyFirstBudget(null))
    db.prepare("UPDATE scan_jobs SET seller='Laboratory operations software' WHERE id=?").run(jobId)
    db.prepare("INSERT INTO leads (id,scan_job_id,company,confidence,fit,score,signal,signal_kind,source_url,evidence_excerpt,event_date,event_date_proof,company_domain) VALUES (?,?,'River Ledger',80,5,75,'Open sales representative vacancy','hiring',?,?,?,'page_bound',?)")
      .run(lead,jobId,signal,'River Ledger advertised a sales representative vacancy.',day,host)
    const add=(connector:string,kind:string,value:string,label:string,url:string) =>
      addEnrichment(db,tenant,lead,{connector,kind,value,label,confidence:null,source_url:url,source_date:day,retrieved_at:at})
    add('sitecrawl','domain',host+'|evidence_own_domain','domain-basis-v1:evidence_own_domain',signal)
    add('sitecrawl','person',role,COMPANY_FIRST_ROLE_LABEL+'Owner',team)
    add('sitecrawl','email',address,'Named published work email',team)
    add('scan:gate','gate_passed','requested_role_v1','role verified',signal)
    add('scan:gate','gate_passed','sales_hiring','role verified',signal)
    const job={id:jobId,user_id:tenant,query,icp}
    await recordNeedEvidence(sqliteDb(db),tenant,jobId,{asOf:now,windowDays:20})
    assert.equal(recordActionability(db,job).actionable,1)
    assert.deepEqual(recordTimingProof(db,job,now),{proven:1,held:0})
    assert.equal(currentnessHeld(db,tenant,lead,now),false)
    assert.equal(recordEmailGuesses(db,tenant,lead,host,['ada.lane'],[role],{
      env:{},where:['Portland, Oregon, United States'],homeText:'Portland, OR 97201',seen:[{address,url:team}],
    })?.published,1)
    assert.deepEqual(publishedCandidateFor(db,tenant,lead,'Ada Lane'),{address,url:team})
    assert.equal(domainReviewStatus(db,tenant,lead,' '+address.toUpperCase()+' '),'ok')
    const draft=createDraft(db,tenant,lead,'Seller')
    assert.equal(db.prepare('SELECT to_email FROM outreach_messages WHERE id=?').pluck().get(draft),address)
    assert.equal(approveBlockReason(db,tenant,draft,{skipAccount:true}),null)
  } finally { db.close() }
})
