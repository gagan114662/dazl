import assert from 'node:assert/strict'
import test from 'node:test'
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
import { draftBlockReason } from '../lib/outreach/service.ts'

test('a genuinely verified published contact can be shown without lifting the send hold', async () => {
  const db = new Database(':memory:')
  try {
    migrateAllSqlite(db)
    migrateCompanyFirstPublishedDisplay(db)
    const tenant = 'display-test-owner', id = '1'.repeat(24), lead = '2'.repeat(24)
    const now = new Date(), at = Math.floor(now.getTime() / 1000)
    const day = new Date(now.getTime() - 3 * 86_400_000).toISOString().slice(0, 10)
    const query = 'Companies hiring sales reps', icp = JSON.stringify({ who: ['Owner'], window_days: 20 })
    const host = 'riverledger.co.uk', team = `https://${host}/team`, signalPage = `https://${host}/vacancy`
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
    assert.deepEqual(await verifiedCompanyFirstDisplay(db,'different-owner',id,[lead],now),{})
    db.prepare("UPDATE leads SET event_date_proof=NULL WHERE id=?").run(lead)
    assert.deepEqual(await verifiedCompanyFirstDisplay(db,tenant,id,[lead],now),{},'the published address cannot replace a verified event')
  } finally { db.close() }
})
