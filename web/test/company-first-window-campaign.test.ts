import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { campaignDetail } from '../lib/outreach/campaign-detail.ts'
import { historyCampaigns } from '../lib/outreach/campaigns.ts'
import { leadWindowHeld, windowHeld } from '../lib/outreach/currentness.ts'
import { timingProofGap } from '../lib/scan/timing-proof.ts'
import { jobWindowDays, windowCutoff } from '../lib/scan/window.ts'
import { markCompanyFirstBudget } from '../lib/company-first/product-discovery.ts'

const marked = markCompanyFirstBudget(null)
test('marked job does not invent a 45-day window from corrupt saved criteria', () => {
  const now = new Date('2026-11-20T12:00:00Z')
  const event_date = windowCutoff(10, now)
  for (const icp of ['{"window_days":"3"}', '{"window_days":0}', '{"window_days":2.5}', '{"window_days":900}', '{"window_days":{}}']) {
    const row = { event_date, icp, query: 'Find companies', run_budget: marked }
    assert.equal(jobWindowDays(row), null)
    assert.equal(windowHeld(row, now), true)
    assert.equal(jobWindowDays({ ...row, query: 'Find companies in past 20 days' }), 20, 'recover an explicit original bound')
    assert.equal(windowHeld({ ...row, query: 'Find companies in past 20 days' }, now), false)
    assert.equal(windowHeld({ ...row, query: 'Find companies in past 3 days' }, now), true)
  }
  assert.equal(windowHeld({ event_date, icp: '{', query: 'Find companies in past 20 days', run_budget: marked }, now), true)
  assert.equal(jobWindowDays({ icp: '{}', run_budget: marked }), 45, 'valid absent window keeps the product maximum')
  assert.equal(jobWindowDays({ icp: '{"window_days":90}' }), 90, 'ordinary job keeps its longer bound')
})
test('campaign detail and history use the stored company-first marker without returning it', async () => {
  const raw = new Database(':memory:')
  try {
    migrateAllSqlite(raw)
    const db = sqliteDb(raw)
    const id = '1'.repeat(24), other = '2'.repeat(24), now = new Date()
    for (const [j, budget] of [[id, marked], [other, null]] as const) {
      await db.run("INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status,query,icp,run_budget) VALUES (?,'A','fixture','services','Example','running','Find companies','{\"window_days\":90}',?)", [j,budget])
      await db.run("INSERT INTO leads (id,scan_job_id,company,signal,source_url,evidence_excerpt,confidence,event_date) VALUES (?,?,'fixture','opened office','https://example.test/','Opened office',80,?)", ['l'+j,j,windowCutoff(50,now)])
      await db.run("UPDATE scan_jobs SET status='done' WHERE id=?", [j])
    }
    const d = await campaignDetail(db,'A',id), ordinary = await campaignDetail(db,'A',other)
    assert.equal(leadWindowHeld(raw,'A','l'+id,now),true)
    assert.deepEqual(d?.leads,[],'a marked row held by its real window never appears in campaign detail')
    assert.equal(d?.company_first_counts?.held,1)
    assert.equal(ordinary?.leads[0].window_held,false)
    assert.ok(d && !('run_budget' in d.job))
    const history = await historyCampaigns(raw,db,'A',[id,other],now)
    assert.equal(history.find(x=>x.id===id)?.qualification.heldResearchSourceChecked,1)
    assert.equal(history.find(x=>x.id===other)?.qualification.heldResearchSourceChecked,0)
    await db.run('UPDATE scan_jobs SET icp = ? WHERE id = ?', ['{"window_days":"bogus"}',id])
    assert.equal(timingProofGap(raw,'A','l'+id,now),'unresolved_recency_bound')
  } finally {raw.close()}
})
