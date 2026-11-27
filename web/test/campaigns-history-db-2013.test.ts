import assert from 'node:assert/strict'
import * as campaigns from '../lib/outreach/campaigns.ts'
import { bothEngines } from './helpers/engines.ts'

bothEngines('Campaign history includes only the requesting workspace’s scans', async ({ db }) => {
  const tenants = ['first-workspace', 'second-workspace']
  const jobs = ['1'.repeat(24), '2'.repeat(24)]
  for (const [index, tenant] of tenants.entries()) {
    await db.run('INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [jobs[index], tenant, 'Fixture business', 'services', 'Fixture market', 'running', 'Find companies'])
    await db.run('INSERT INTO leads (id, scan_job_id, company, signal, source_url, evidence_excerpt) VALUES (?, ?, ?, ?, ?, ?)',
      ['lead-' + index, jobs[index], 'Fixture buyer', 'Opened an office', 'https://buyer.example/news', 'The buyer opened an office'])
    await db.run("UPDATE scan_jobs SET status = 'done' WHERE id = ? AND user_id = ?", [jobs[index], tenant])
  }
  for (const [index, tenant] of tenants.entries()) {
    const rows = await campaigns.historyCampaignsDb(db, tenant, jobs)
    assert.deepEqual(rows.map(row => [row.id, row.discovery.leads]), [[jobs[index], 1]])
    assert.deepEqual(await campaigns.historyCampaignsDb(db, tenant, jobs.filter(id => id !== jobs[index])), [])
  }
})
