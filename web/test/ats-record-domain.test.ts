import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'

// Run 9697d013 (LiveKit): a lead whose source is its own Ashby posting, with no requested place, stayed domainless ("no location to confirm
// the company"): the posting page is a JS shell, but the board's own API record writes the site out ("livekit.io"). That record binds the
// domain like a link; the homepage name check still decides. A record naming no such domain adds nothing (no guess).
const ID = '7387a987-24f3-424c-8dd3-bb7ed16f95e0', SRC = `https://jobs.ashbyhq.com/livekit/${ID}`
const PROSE = '<p>The realtime platform for voice, video and AI agents, used by developers and companies building production applications every day.</p>'
async function run(description: string, homeName = 'LiveKit') {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: [] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,event_date,event_date_proof) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'LiveKit', null, 'Hiring an SDR', SRC, 'Sales Development Representative', 90, 85, '2026-11-13', 'ats_structured')
  const get: Get = async url => {
    const u = new URL(url)
    if (url === SRC) return { status: 200, body: '<html><head><title>Jobs</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>', finalUrl: url }
    if (url === 'https://api.ashbyhq.com/posting-api/job-board/livekit') return { status: 200, body: JSON.stringify({ jobs: [{ id: ID, isListed: true, title: 'Sales Development Representative', publishedAt: '2026-11-13T21:24:44Z', descriptionPlain: description, descriptionHtml: `<p>${description}</p>`, jobUrl: SRC }] }), finalUrl: url }
    if (u.hostname.replace(/^www\./, '') !== 'livekit.io') return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    return u.pathname === '/' ? { status: 200, body: `<html><body><title>${homeName}</title>${homeName} ${PROSE}<a href="/contact">Contact</a></body></html>`, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, redirectOf: async () => null, now: Date.parse('2026-11-21T09:00:00Z') })
  return (db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as { company_domain: string | null }).company_domain
}
test('LiveKit (9697d013): the domain its own posting record writes out is confirmed by the homepage, with no requested place', async () => {
  assert.equal(await run('ABOUT LIVEKIT LiveKit is the realtime layer for AI. Learn more at livekit.io.'), 'livekit.io')
})
test('a posting record that names no site leaves the lead unresolved (no guessed domain)', async () => {
  assert.equal(await run('ABOUT LIVEKIT LiveKit is the realtime layer for AI.'), null)
})
test('the record-named domain still needs the homepage to name the company', async () => {
  assert.equal(await run('Learn more at livekit.io.', 'Parked Domain For Sale'), null)
})
