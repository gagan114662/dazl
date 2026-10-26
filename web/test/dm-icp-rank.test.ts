import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { titleMatches, roleContradicted, rankPeople } from '../lib/people/rank.ts'

// Decision-maker finder part 2: of the people listed on a company site, keep the ones the seller wants to reach
// (the scan ICP's "who" roles) before falling back to seniority. TEST-ONLY fixture, no network.
const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>We have served the community for many years and we care about every family that walks through our doors every single day.</p>'
async function kept(icp: unknown, team?: string): Promise<string[]> {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(icp === null ? null : JSON.stringify(icp), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'Acme Logistics', null, 'Acme Logistics is hiring', 'https://news.example.test/a', 'Acme Logistics is hiring', 90, 80)
  const pages: Record<string, string> = {
    '/a': html('<a href="https://acmelogistics.com/">site</a>'),
    '/robots.txt': 'User-agent: *\nAllow: /',
    '/': html('Acme Logistics <a href="/team">Team</a>'),
    '/team': html(team ?? `${PROSE}<h3>Dana Lee</h3><p>CEO</p><h3>Ben Ortiz</h3><p>CTO</p><h3>Cara Diaz</h3><p>CFO</p><h3>Eli Novak</h3><p>Head of HR</p>`),
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

test('buyer titles come from the scan ICP roles, not a fixed list: any business, any language; other employers still rejected', async () => {
  const { extractPeople } = await import('../lib/connectors/sitecrawl.ts')
  const one = (t: string, roles?: string) => extractPeople(html(`${PROSE}<h3>Eli Novak</h3><p>${t}</p>`), 'https://a.example/team', roles).map(f => f.value)
  for (const [t, roles] of [['Practice Manager', 'practice owner; practice manager'], ['Store Manager', 'store manager'], ['Gerente de Vendas', 'gerente de vendas'], ['HR Manager', 'HR manager; head of people']]) assert.deepEqual(one(t, roles), [`Eli Novak, ${t}`], t)
  assert.deepEqual(one('HR Manager'), [], 'no ICP roles: only generic executive titles')
  assert.deepEqual(one('Payroll Manager', 'HR manager'), [], 'one shared generic word is not enough')
  assert.deepEqual(one('Store Manager at Rival Inc', 'store manager'), [], 'another employer named')
  assert.deepEqual(one('Head of Human Resources'), ['Eli Novak, Head of Human Resources'], 'two-word Head of is a generic title')
})

// Instinct #191 review: explicitly past, retired, negated and assistant-to titles contain the buyer role's words but must
// never be stored, ranked or take one of the 3 slots. Ordinary current roles keep their "not verified as current" label.
const BAD = ['Former HR Manager', 'Retired HR Manager', 'Ex HR Manager', 'Ex-HR Manager', 'Previous HR Manager', 'Assistant to HR Manager', 'Assistant to the HR Manager', 'HR Manager Assistant', "HR Manager's Assistant", 'Not HR Manager', 'HR Manager Emeritus']
test('roleContradicted: past, retired, negated and assistant-to roles are refused; current roles are not', () => {
  for (const t of BAD) assert.equal(roleContradicted(t, 'HR Manager'), true, t)
  for (const t of ['HR Manager', 'Head of People', 'Senior HR Manager', 'Non-Profit Director']) assert.equal(roleContradicted(t, 'HR Manager'), false, t)
  assert.equal(roleContradicted('Office Assistant', 'office assistant; HR manager'), false, 'the scan itself asks for assistants')
  assert.equal(roleContradicted('Assistant to the Office Assistant', 'office assistant'), true, 'but an assistant TO a role is still refused')
})
test('extraction: contradicted titles are not stored for the buyer role', async () => {
  const { extractPeople, buyerTitle } = await import('../lib/connectors/sitecrawl.ts')
  for (const t of BAD) {
    assert.equal(buyerTitle(t, 'HR Manager'), false, t)
    assert.deepEqual(extractPeople(html(`${PROSE}<h3>Eli Novak</h3><p>${t}</p>`), 'https://a.example/team', 'HR Manager'), [], t)
  }
  assert.deepEqual(extractPeople(html(`${PROSE}<h3>Eli Novak</h3><p>HR Manager</p>`), 'https://a.example/team', 'HR Manager').map(f => f.value), ['Eli Novak, HR Manager'])
})
test('final crawl selection: former and assistant-to people never take one of the 3 slots; the real current buyer does', async () => {
  const team = `${PROSE}<h3>Dana Lee</h3><p>CEO</p><h3>Ben Ortiz</h3><p>CTO</p><h3>Cara Diaz</h3><p>CFO</p>` +
    BAD.map((t, i) => `<h3>Pat Person${'abcdefghijk'[i]}</h3><p>${t}</p>`.replace('Person' + 'abcdefghijk'[i], 'Person' + 'abcdefghijk'[i])).join('') + '<h3>Eli Novak</h3><p>HR Manager</p>'
  const out = await kept({ summary: 's', who: ['HR manager'], industries: [], sizes: [], where: [], signals: [], exclude: [] }, team)
  assert.ok(out.includes('Eli Novak, HR Manager'), JSON.stringify(out))
  assert.ok(!out.some(v => BAD.some(t => v.endsWith(t))), JSON.stringify(out))
  assert.equal(out.length, 3)
})
test('rank path (card, previously stored rows): contradicted titles score zero and sort after a real current buyer', () => {
  const people = [...BAD.map((t, i) => ({ name: `P${i}`, title: t, linkedin: null, connector: 'sitecrawl' })), { name: 'Eli', title: 'HR Manager', linkedin: null, connector: 'sitecrawl' }]
  const r = rankPeople(people, 'HR Manager')
  assert.equal(r[0].name, 'Eli')
  for (const x of r.slice(1)) assert.equal(x.tier, 'none', x.title ?? '')
})
