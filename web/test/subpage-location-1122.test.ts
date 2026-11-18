import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'

// #1122 F1 (real 5-lead replay, job 8df272f3bf68d6bee36ea722): TapMango's homepage names the company but no city; its own
// about-us / leadership / careers pages say Toronto. The crawl fetched those pages and then judged location on the homepage only,
// so the domain was refused and the lead got no website. A positive location check now reads the company's own fetched pages too;
// a homepage that names ANOTHER place is still refused.
const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>Loyalty and online ordering for restaurants and retailers, built by a team that cares about small business owners everywhere.</p>'

async function run(sites: Record<string, Record<string, string>>) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: ['Toronto, Ontario'] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,review_reason) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'TapMango', null, 'Hiring an SDR in Toronto', 'https://board.example/jobs/sdr-1', 'TapMango is hiring an SDR in Toronto, Ontario', 90, 85, null)
  const get: Get = async url => {
    const u = new URL(url); const host = u.hostname.replace(/^www\./, '')
    if (host === 'board.example') return { status: 200, body: html('<p>TapMango is hiring an SDR in Toronto.</p>'), finalUrl: url }
    const site = sites[host]; if (!site) return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    const b = site[u.pathname]
    return b !== undefined ? { status: 200, body: b, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-18T12:00:00Z'), redirectOf: async () => null, findSites: async () => ['tapmango.com'] })
  return (db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as { company_domain: string | null }).company_domain
}

const HOME = html(`<h1>TapMango</h1>${PROSE}<a href="/about-us">About us</a>`)
const ABOUT = html('<h1>About TapMango</h1><p>TapMango is headquartered in Toronto, Ontario, Canada.</p>')

test('#1122 F1: homepage names no place, the company\'s own about page says Toronto: the domain is kept', async () => {
  assert.equal(await run({ 'tapmango.com': { '/': HOME, '/about-us': ABOUT } }), 'tapmango.com')
})

test('#1122 F1 control: no first-party page names the place: still no domain', async () => {
  assert.equal(await run({ 'tapmango.com': { '/': HOME, '/about-us': html('<p>About TapMango. We love loyalty.</p>') } }), null)
})

test('#1122 F1 guard: a homepage naming ANOTHER place is still refused, even if a subpage mentions Toronto', async () => {
  const home = html(`<h1>TapMango</h1><p>Visit us at 8500 Whittier Blvd, Pico Rivera, CA 90660.</p>${PROSE}<a href="/about-us">About us</a>`)
  assert.equal(await run({ 'tapmango.com': { '/': home, '/about-us': ABOUT } }), null)
})
