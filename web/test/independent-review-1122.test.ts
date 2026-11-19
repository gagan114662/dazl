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
    if (mode === 'failed' || (host !== wanted && !(mode === 'posting' && host === 'warroominc.com'))) return null
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


test("independent: matching ATS slug must precede posting website when both sites pass identity", async () => { const r = await run("posting"); assert.equal(r.row.company_domain, "warroominc.com"); assert.ok(r.events.some(e => e.includes("warroominc.com"))); });

async function runForeign(mode: 'slug' | 'posting' | 'search' | 'failed' | 'namesake' | 'blocked') {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'B', { business_name: 'S', industry: 'x', location: 'Toronto' })
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
    if (mode === 'slug' || mode === 'posting') return []
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


test("independent: tenant A cannot mutate tenant B job during domain resolution", async () => { const r = await runForeign("posting"); assert.equal(r.row.company_domain, null); });


test('tenant boundary: supplied lead subsets cannot cross jobs or tenants; missing jobs send nothing', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const own = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'Toronto' })
  const foreign = createJob(db, 'B', { business_name: 'S', industry: 'x', location: 'Toronto' })
  db.prepare('UPDATE scan_jobs SET status = ?').run('running')
  db.prepare('INSERT INTO leads (id,scan_job_id,company,signal,source_url,confidence,score) VALUES (?,?,?,?,?,?,?)')
    .run('foreign', foreign, 'War Room', 'Hiring', SRC, 90, 70)
  const calls: string[] = []
  const deps = { env: {}, gapMs: 0, leads: [{ id: 'foreign', company: 'War Room', source_url: SRC }],
    get: async (url: string) => { calls.push(url); return null },
    findSites: async () => { calls.push('search'); return [] } }
  await crawlJob(db, 'A', foreign, deps)
  await crawlJob(db, 'A', own, deps)
  await crawlJob(db, 'A', 'missing', deps)
  assert.deepEqual(calls, [])
  assert.equal((db.prepare('SELECT COUNT(*) n FROM lead_enrichments').get() as { n: number }).n, 0)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM connector_audit').get() as { n: number }).n, 0)
  assert.equal((db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('foreign') as { company_domain: null }).company_domain, null)
  db.close()
})
