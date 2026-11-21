import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { markCompanyFirstBudget } from '../lib/company-first/product-discovery.ts'
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
    await db.run("UPDATE scan_jobs SET status='done',enrich_finished_at=1,candidates=2,verified=0,needs_review=1,dropped=1 WHERE id=? AND user_id=?", [jobId,tenant])
    const result = await companyFirstResults(db,tenant,jobId)
    const campaign = await campaignDetail(db,tenant,jobId)
    assert.deepEqual(result?.counts,{candidates:2,ready:0,reviewable:0,held:1,dropped:1})
    assert.deepEqual(campaign?.company_first_counts,result?.counts)
    assert.equal(result?.visibleIds.size,0)
    assert.deepEqual(campaign?.leads,[])
    assert.ok(!JSON.stringify(campaign).includes('Held Company'))
    assert.equal(await companyFirstResults(db,'other-tenant',jobId),null)
    assert.equal(await campaignDetail(db,'other-tenant',jobId),null)
    await db.run('UPDATE scan_jobs SET run_budget=NULL WHERE id=? AND user_id=?',[jobId,tenant])
    assert.equal(await companyFirstResults(db,tenant,jobId),null)
    assert.equal((await campaignDetail(db,tenant,jobId))?.leads.length,1)
  } finally { raw.close() }
})
