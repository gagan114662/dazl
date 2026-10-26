import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { titleMatches } from '../lib/people/rank.ts'

// Decision-maker finder part 2: of the people listed on a company site, keep the ones the seller wants to reach
// (the scan ICP's "who" roles) before falling back to seniority. TEST-ONLY fixture, no network.
const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>We have served the community for many years and we care about every family that walks through our doors every single day.</p>'
async function kept(icp: unknown): Promise<string[]> {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(icp === null ? null : JSON.stringify(icp), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'Acme Logistics', null, 'Acme Logistics is hiring', 'https://news.example.test/a', 'Acme Logistics is hiring', 90, 80)
  const pages: Record<string, string> = {
    '/a': html('<a href="https://acmelogistics.com/">site</a>'),
    '/robots.txt': 'User-agent: *\nAllow: /',
    '/': html('Acme Logistics <a href="/team">Team</a>'),
    '/team': html(`${PROSE}<h3>Dana Lee</h3><p>CEO</p><h3>Ben Ortiz</h3><p>CTO</p><h3>Cara Diaz</h3><p>CFO</p><h3>Eli Novak</h3><p>Head of HR</p>`),
  }
  const get: Get = async url => { const p = pages[new URL(url).pathname]; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-10-26T12:00:00Z') })
  return (db.prepare("SELECT value FROM lead_enrichments WHERE kind = 'person' ORDER BY value").all() as { value: string }[]).map(r => r.value)
}

test('titleMatches shares rankPeople word rules', () => {
  assert.deepEqual(titleMatches('Head of HR', 'HR manager; Head of People'), ['head', 'hr'])
  assert.deepEqual(titleMatches('CTO', 'HR manager'), [])
})

test('ICP buyer roles decide which 3 people are kept; seniority breaks ties', async () => {
  const withIcp = await kept({ summary: 's', who: ['HR manager', 'Head of People'], industries: [], sizes: [], where: [], signals: [], exclude: [] })
  assert.ok(withIcp.includes('Eli Novak, Head of HR'), JSON.stringify(withIcp))
  assert.equal(withIcp.length, 3)
})

test('no ICP (or no who roles): seniority only, as before', async () => {
  for (const icp of [null, { summary: 's', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] }]) {
    const out = await kept(icp)
    assert.equal(out.length, 3)
    assert.ok(!out.includes('Eli Novak, Head of HR'), JSON.stringify(out)) // three C-suite titles outrank a Head of
  }
})

test('department buyer titles are whole titles; other-company and generic titles still rejected', async () => {
  const { extractPeople } = await import('../lib/connectors/sitecrawl.ts')
  const one = (t: string) => extractPeople(html(`${PROSE}<h3>Eli Novak</h3><p>${t}</p>`), 'https://a.example/team').map(f => f.value)
  for (const t of ['HR Manager', 'Payroll Manager', 'Head of Human Resources', 'IT Director', 'Marketing Lead']) assert.deepEqual(one(t), [`Eli Novak, ${t}`], t)
  for (const t of ['Store Manager', 'Head of Sales at Rival Inc', 'Director, Other Corp']) assert.deepEqual(one(t), [], t)
})
