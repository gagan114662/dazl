import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { latestLeadSourceReviews } from '../lib/db/lead-source-reviews.ts'

bothEngines('source review batch uses one latest, deterministic tenant-owned review for each lead', async ({ db }) => {
  for (const [job, tenant] of [['owned', 'owner'], ['other', 'foreign']]) {
    await db.run(`INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status,candidates,created_at)
      VALUES (?,?,'Fixture','services','-','running',3,1)`, [job, tenant])
  }
  for (const [id, job] of [['reviewed', 'owned'], ['unreviewed', 'owned'], ['foreign-lead', 'other']]) {
    await db.run(`INSERT INTO leads (id,scan_job_id,company,signal,source_url)
      VALUES (?,?,'Fixture','Expansion','https://example.test/source')`, [id, job])
  }
  const source = 'https://example.test/source'
  for (const [id, tenant, job, lead, time, quote] of [
    ['old', 'owner', 'owned', 'reviewed', 10, 0],
    ['tie-a', 'owner', 'owned', 'reviewed', 20, 0],
    ['tie-z', 'owner', 'owned', 'reviewed', 20, 1],
    ['wrong-job', 'owner', 'other', 'reviewed', 40, 0],
    ['wrong-tenant', 'foreign', 'owned', 'reviewed', 50, 0],
    ['foreign-review', 'foreign', 'other', 'foreign-lead', 60, 1],
  ] as const) {
    await db.run(`INSERT INTO source_reviews (id,tenant_id,job_id,lead_id,input_json,fetch_status,quote_match,
      company_named,contact_match,checked_at) VALUES (?,?,?,?,?,'ok',?,1,?,?)`,
      [id, tenant, job, lead, JSON.stringify({ contact_context: { excerpt: id, source_url: source } }), quote, quote, time])
  }

  let reads = 0
  const measured = {
    ...db,
    async all<T>(...args: Parameters<typeof db.all>) {
      reads++
      return db.all<T>(...args)
    },
  }
  const expected = {
    check: { fetch_status: 'ok', quote_match: true, company_named: true, contact_match: true, checked_at: 20 },
    contactContext: { excerpt: 'tie-z', source_url: source },
  }
  for (const ids of [['reviewed'], ['foreign-lead', 'unreviewed', 'reviewed', 'reviewed']]) {
    reads = 0
    assert.deepEqual(await latestLeadSourceReviews(measured, 'owner', 'owned', ids), new Map([['reviewed', expected]]))
    assert.equal(reads, 1)
  }
  assert.deepEqual(await latestLeadSourceReviews(db, 'owner', 'other', ['foreign-lead']), new Map())
  assert.equal((await latestLeadSourceReviews(db, 'foreign', 'other', ['foreign-lead'])).get('foreign-lead')?.check.checked_at, 60)
})
