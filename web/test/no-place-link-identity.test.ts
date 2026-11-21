import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'

// Prod case-1 run df4f657f (request names NO place): levelupleads.io / mercor.com were linked from the lead's own evidence page,
// yet refused "contact rejected: location mismatch Choices San Francisco, CA vs the requested place" - a place the evidence page
// mentioned was treated as the request's. With no requested place, a LINKED site is not compared on location; a guessed one still is.
const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>We help revenue teams find and book meetings with the right buyers, and we care about every customer we work with every single day.</p>'
const ARTICLE = (link: boolean | 'text') => html(`<h1>LevelUp Leads hires its first SDR</h1><p>LevelUp Leads, based in Austin, TX, is hiring its first Sales Development Representative this month.</p>${link === 'text' ? '<a href="https://lul-growth.io/">LevelUp Leads</a>' : link ? '<a href="https://levelupleads.io/">levelupleads.io</a>' : ''}`)
const HOME = html(`<title>LevelUp Leads</title>LevelUp Leads - outbound pipeline for B2B teams. Choices San Francisco, CA ${PROSE}<a href="/contact">Contact</a>`)
const CONTACT = html('<a href="mailto:hello@levelupleads.io">hello</a>')

async function run(where: string[], link: boolean | 'text', legacyLocation?: string) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  if (legacyLocation) db.prepare("UPDATE scan_jobs SET status = 'running', icp = NULL, location = ? WHERE id = ?").run(legacyLocation, job)
  else db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'LevelUp Leads', null, 'Hiring its first SDR', 'https://news.example/levelup-first-sdr', 'LevelUp Leads, based in Austin, TX, is hiring its first Sales Development Representative this month.', 90, 85)
  const get: Get = async url => {
    const u = new URL(url)
    if (u.hostname === 'news.example') return { status: 200, body: ARTICLE(link), finalUrl: url }
    if (!['levelupleads.io', 'lul-growth.io'].includes(u.hostname.replace(/^www\./, ''))) return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    const b = ({ '/': HOME, '/contact': CONTACT } as Record<string, string>)[u.pathname]
    return b !== undefined ? { status: 200, body: b, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-21T09:00:00Z') })
  return {
    domain: (db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as { company_domain: string | null }).company_domain,
    audit: db.prepare("SELECT lookup, status FROM connector_audit WHERE connector = 'sitecrawl'").all() as { lookup: string; status: string }[],
  }
}

test('no requested place: a site the evidence page links to is not refused on a place the evidence happens to name', async () => {
  const r = await run([], true)
  assert.ok(!r.audit.some(a => /vs the requested place/.test(a.status)), JSON.stringify(r.audit))
  assert.equal(r.domain, 'levelupleads.io', JSON.stringify(r.audit))
})
test('a requested place still applies the location check to the same linked site', async () => {
  const r = await run(['Austin, TX'], true)
  assert.notEqual(r.domain, 'levelupleads.io', JSON.stringify(r.audit))
})
test('no requested place: a guessed (unlinked) same-name site is still refused without location agreement', async () => {
  const r = await run([], false)
  assert.equal(r.domain, null, JSON.stringify(r.audit))
})
test('review: no requested place, but a text-only link (anchor names the company) keeps the location check', async () => {
  const r = await run([], 'text')
  assert.notEqual(r.domain, 'lul-growth.io', JSON.stringify(r.audit))
})
test('review: a legacy scan with a stored location and no ICP still applies the location check', async () => {
  const r = await run([], true, 'Austin, TX')
  assert.notEqual(r.domain, 'levelupleads.io', JSON.stringify(r.audit))
})
