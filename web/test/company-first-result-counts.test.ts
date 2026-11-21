import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { markCompanyFirstBudget } from '../lib/company-first/product-discovery.ts'
import { scanMessages } from '../lib/outreach/campaign-view.ts'
import { campaignDetail } from '../lib/outreach/campaign-detail.ts'
import { companyFirstResults } from '../lib/scan/company-first-results.ts'

test('ordinary Leads count and campaign describe the same held/dropped result without exposing held data', async () => {
  const raw = new Database(':memory:')
  try {
    migrateAllSqlite(raw)
    const db = sqliteDb(raw)
    const tenant = 'fixture-tenant', jobId = '1'.repeat(24), held = '2'.repeat(24)
    const columns = "(id,user_id,business_name,industry,location,status,attempts,query,icp,run_budget)"
    await db.run(`INSERT INTO scan_jobs ${columns} VALUES (?,?,'Seller','-','-','running',1,'Find companies','{}',?)`, [jobId,tenant,markCompanyFirstBudget(null)])
    await db.run("INSERT INTO leads (id,scan_job_id,company,signal,source_url,evidence_excerpt,review_reason) VALUES (?,?,'Held Company','Hiring','https://held.example/','Unproven quote','quote_unconfirmed')", [held,jobId])
    const draftHeld='3'.repeat(24)
    await db.run("INSERT INTO leads (id,scan_job_id,company,signal,source_url,review_reason) VALUES (?,?,'Another Held Company','Hiring','https://held.example/','quote_unconfirmed')", [draftHeld,jobId])
    await db.run("UPDATE scan_jobs SET status='done',enrich_finished_at=1,candidates=3,verified=0,needs_review=2,dropped=1 WHERE id=? AND user_id=?", [jobId,tenant])
    const result = await companyFirstResults(db,tenant,jobId)
    const campaign = await campaignDetail(db,tenant,jobId)
    assert.deepEqual(result?.counts,{candidates:3,ready:0,reviewable:0,held:2,dropped:1})
    assert.deepEqual(campaign?.company_first_counts,result?.counts)
    assert.equal(result?.visibleIds.size,0)
    assert.deepEqual(campaign?.leads,[])
    assert.ok(!JSON.stringify(campaign).includes('Held Company'))
    const msg = (id: string, leadId:string, status: string, sentAt: number|null) =>
      db.run("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body,status,created_at,sent_at) VALUES (?,?,?,'recipient@example.test',?,'Historic fixture body',?,100,?)", [id,tenant,leadId,id,status,sentAt])
    await msg('old-send',held,'sent',101)
    await msg('unproved-draft',draftHeld,'draft',null)
    const withHistory=(await campaignDetail(db,tenant,jobId))!
    assert.deepEqual(withHistory.leads,[], 'sent history never grants the lead current visibility')
    assert.deepEqual(withHistory.messages.map(m=>m.id),['old-send'])
    assert.deepEqual(scanMessages(withHistory.messages,withHistory.leads,true).map(m=>m.id),['old-send'])
    const withoutProof=(await campaignDetail({...db,companyFirstResults:undefined},tenant,jobId))!
    assert.equal(withoutProof.company_first_counts,null)
    assert.deepEqual(withoutProof.leads,[])
    assert.deepEqual(withoutProof.messages.map(m=>m.id),['old-send'], 'no-proof adapter retains only sent history')

    assert.equal(await companyFirstResults(db,'other-tenant',jobId),null)
    assert.equal(await campaignDetail(db,'other-tenant',jobId),null)
    await db.run('UPDATE scan_jobs SET run_budget=NULL WHERE id=? AND user_id=?',[jobId,tenant])
    assert.equal(await companyFirstResults(db,tenant,jobId),null)
    assert.equal((await campaignDetail(db,tenant,jobId))?.leads.length,2)
  } finally { raw.close() }
})
