import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'

// Prod run c4d2fd9c: every source was an aggregator list (landbase, roledawn) that links no company site, so the site lookup only
// guessed <name>.com/.io and refused them all ("no location to confirm"). cf_runner stage 2: the homepage the scan's own search cited
// is a candidate when its domain label is the company's name; the homepage is then read and must name the company.
const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>We help revenue teams find and book meetings with the right buyers, and we care about every customer we work with every single day.</p>'
const LIST = html('<h1>Companies hiring their first SDR</h1><p>LevelUp Leads is hiring its first Sales Development Representative.</p><a href="/other">More lists</a>')
const HOME = (name: string) => html(`<title>${name}</title>${name} - outbound pipeline for B2B teams. ${PROSE}<a href="/contact">Contact</a>`)
const CONTACT = html('<a href="mailto:hello@levelupleads.io">hello</a>')

async function run(citedUrls: string[] | undefined, homeName = 'LevelUp Leads') {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: [] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'LevelUp Leads', null, 'Hiring its first SDR', 'https://lists.example/first-sdr', 'LevelUp Leads is hiring its first Sales Development Representative.', 90, 85)
  const get: Get = async url => {
    const u = new URL(url)
    if (u.hostname === 'lists.example') return { status: 200, body: LIST, finalUrl: url }
    if (!['levelupleads.io', 'lul-growth.io'].includes(u.hostname.replace(/^www\./, ''))) return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    const b = ({ '/': HOME(homeName), '/contact': CONTACT } as Record<string, string>)[u.pathname]
    return b !== undefined ? { status: 200, body: b, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-21T09:00:00Z'), ...(citedUrls ? { citedUrls } : {}) })
  return {
    domain: (db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as { company_domain: string | null }).company_domain,
    audit: db.prepare("SELECT lookup, status FROM connector_audit WHERE connector = 'sitecrawl'").all() as { lookup: string; status: string }[],
  }
}

test('an aggregator lead takes the homepage the search cited, when its domain is the company name and the homepage names it', async () => {
  const r = await run(['https://lists.example/first-sdr', 'https://www.levelupleads.io/about'])
  assert.equal(r.domain, 'levelupleads.io', JSON.stringify(r.audit))
})
test('without the cited homepage the same lead stays unresolved (main behaviour)', async () => {
  assert.equal((await run(undefined)).domain, null)
})
test('a cited site whose domain is not the company name is never taken', async () => {
  assert.equal((await run(['https://lul-growth.io/'])).domain, null)
})
test('a cited same-label homepage that does not name the company is refused (name proof)', async () => {
  const r = await run(['https://levelupleads.io/'], 'Totally Different Co')
  assert.equal(r.domain, null, JSON.stringify(r.audit))
})
test('review: a cited same-name homepage in another city than the evidence names is refused, and guesses still run after it', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: [] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'LevelUp Leads', null, 'Hiring its first SDR', 'https://lists.example/first-sdr', 'LevelUp Leads, based in Austin, TX, is hiring its first SDR.', 90, 85)
  const seen: string[] = []
  const get: Get = async url => {
    const u = new URL(url); seen.push(u.hostname)
    if (u.hostname === 'lists.example') return { status: 200, body: html('<p>LevelUp Leads, based in Austin, TX, is hiring its first SDR.</p>'), finalUrl: url }
    if (u.hostname.replace(/^www\./, '') !== 'levelupleads.io') return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    return u.pathname === '/' ? { status: 200, body: html(`<title>LevelUp Leads</title>LevelUp Leads, Leeds, United Kingdom. ${PROSE}`), finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-21T09:00:00Z'), citedUrls: ['https://levelupleads.io/'] })
  assert.equal((db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as { company_domain: string | null }).company_domain, null)
  assert.ok(seen.some(h => /^(?:www\.)?levelup(?:leads)?\.com$/.test(h) || h.endsWith('.com')), JSON.stringify([...new Set(seen)]))
})
