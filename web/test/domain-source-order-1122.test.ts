import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { jobBoardSlugs } from '../lib/connectors/job-board-slug.ts'

// Real reported War Room source shape (job 6b7e54aaf53b67fc7e874115).
const ATS = 'https://ats.rippling.com/war-room-careers/jobs/3d46c27a-6efa-4505-b2b4-790d52ce4ee7'
const SRC = 'https://growthroles.com/jobs/war-room-business-development-representative-torontoremote-toronto-7d65eab6263dde76'
const HOME = '<h1>War Room</h1><p>Programmatic advertising agency. Visit us at 156 Front Street West, Toronto, ON M5J 2L6.</p>'

test('#1122 direct ATS source supplies its own employer slug without re-fetching the source', () => {
  assert.deepEqual(jobBoardSlugs('War Room', ATS), { slug: 'war-room-careers', ats: [] })
  assert.deepEqual(jobBoardSlugs('Other Agency', ATS), { slug: '', ats: [] })
  assert.deepEqual(jobBoardSlugs('War Room', ATS.replace('ats.rippling.com', 'ats.rippling.com.evil.example')), { slug: '', ats: [] })
})

async function run(mode: 'slug' | 'posting' | 'search' | 'failed' | 'namesake' | 'blocked') {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ where: ['Toronto, Ontario'] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,signal,source_url,review_reason,confidence,score) VALUES (?,?,?,?,?,?,?,?)')
    .run('L', job, 'War Room', 'Hiring a BDR in Toronto', SRC, mode === 'blocked' ? 'blocked_by_site' : 'no_sales_hiring_evidence', null, 70)
  const events: string[] = []; const ctrl = new AbortController()
  const get: Get = async url => {
    events.push(url)
    if (url === SRC) return { status: 200, body: '<a href="' + ATS + '">Apply</a>', finalUrl: url }
    if (url === ATS) return { status: 200, body: mode === 'posting' ? '<a href="https://wearewarroom.com/">War Room website</a>' : '', finalUrl: url }
    const u = new URL(url); const host = u.hostname.replace(/^www\./, '')
    const wanted = mode === 'slug' || mode === 'namesake' ? 'warroominc.com' : mode === 'posting' ? 'wearewarroom.com' : 'warroomagency.com'
    if (mode === 'failed' || host !== wanted) return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    return { status: 200, body: mode === 'namesake' ? '<h1>War Room</h1><p>8500 Whittier Blvd, Pico Rivera, CA 90660.</p>' : HOME, finalUrl: url }
  }
  const findSites = async () => {
    events.push('external_lookup')
    if (mode === 'slug' || mode === 'posting') { ctrl.abort(); return [] }
    if (mode === 'failed') throw new Error('source unavailable')
    return ['warroomagency.com']
  }
  try {
    await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, signal: ctrl.signal, findSites, redirectOf: async () => null })
    const row = db.prepare('SELECT company_domain,review_reason,confidence FROM leads WHERE id = ?').get('L') as { company_domain: string | null; review_reason: string; confidence: number | null }
    const domain = db.prepare("SELECT source_url FROM lead_enrichments WHERE lead_id = 'L' AND kind = 'domain'").get() as { source_url: string } | undefined
    return { row, events, domain }
  } finally { db.close() }
}

for (const mode of ['slug', 'posting'] as const) test('#1122 ' + mode + ' candidate is checked before external lookup can exhaust the crawl deadline', async () => {
  const r = await run(mode)
  assert.equal(r.row.company_domain, mode === 'slug' ? 'warroominc.com' : 'wearewarroom.com')
  assert.ok(!r.events.includes('external_lookup'))
  assert.equal(r.row.review_reason, 'no_sales_hiring_evidence')
  assert.equal(r.row.confidence, null)
  if (mode === 'posting') assert.equal(r.domain?.source_url, ATS)
})

test('#1122 external search still runs after local candidates fail, never before the employer posting', async () => {
  const r = await run('search')
  assert.equal(r.row.company_domain, 'warroomagency.com')
  assert.ok(r.events.indexOf(ATS) < r.events.indexOf('external_lookup'))
  assert.ok(r.events.some((e, i) => i < r.events.indexOf('external_lookup') && e.includes('warroominc.com')))
})

test('#1122 provider failure and wrong-place namesakes preserve zero domains and the original hold', async () => {
  for (const mode of ['failed', 'namesake'] as const) {
    const r = await run(mode)
    assert.equal(r.row.company_domain, null)
    assert.equal(r.row.review_reason, 'no_sales_hiring_evidence')
    assert.equal(r.row.confidence, null)
  }
})

test('#1122 a blocked evidence page is never re-fetched while an independent site search remains usable', async () => {
  const r = await run('blocked')
  assert.ok(!r.events.includes(SRC))
  assert.ok(!r.events.includes(ATS))
  assert.equal(r.row.company_domain, 'warroomagency.com')
  assert.equal(r.row.review_reason, 'blocked_by_site')
})
