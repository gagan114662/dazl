import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'

// (ATS name-slug, run 5b11cd4f) Prod run c4d2fd9c: every source was an aggregator list (landbase, roledawn) that links no company site, so the site lookup only
// guessed <name>.com/.io and refused them all. A scan citation is admitted only when the lead's own publisher
// pairs that exact company and domain without a link. The homepage still has to pass identity/place checks.
const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>We help revenue teams find and book meetings with the right buyers, and we care about every customer we work with every single day.</p>'
const LIST = (q: string) => html(`<h1>Companies hiring their first SDR</h1><p>${q}</p><a href="/other">More lists</a>`)

const HOME = (name: string) => html(`<title>${name}</title>${name} - outbound pipeline for B2B teams. ${PROSE}<a href="/contact">Contact</a>`)
const CONTACT = html('<a href="mailto:hello@levelupleads.io">hello</a>')


const BOARD = (opts: { name: string; site: string | null }) => (async (input: string | URL | Request) => {
  const u = String(input)
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
  if (u === 'https://boards-api.greenhouse.io/v1/boards/levelupleads/jobs') return json({ jobs: [{ id: 11, title: 'Sales Development Representative' }] })
  if (u === 'https://boards-api.greenhouse.io/v1/boards/levelupleads') return json({ name: opts.name })
  if (u === 'https://boards-api.greenhouse.io/v1/boards/levelupleads/jobs/11') return json({ id: 11, title: 'Sales Development Representative', first_published: '2026-11-10T00:00:00Z',
    absolute_url: 'https://job-boards.greenhouse.io/levelupleads/jobs/11', content: opts.site ? `Join us. Learn more at https://${opts.site}/about` : 'Join us.' })
  return new Response('', { status: 404 })
}) as typeof fetch

async function runAts(fetchImpl: typeof fetch | undefined, homeName = 'LevelUp Leads') {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: [] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'LevelUp Leads', null, 'Hiring its first SDR', 'https://lists.example/first-sdr', 'LevelUp Leads is hiring its first Sales Development Representative.', 90, 85)
  const get: Get = async url => {
    const u = new URL(url)
    if (u.hostname === 'lists.example') return { status: 200, body: LIST('LevelUp Leads is hiring its first Sales Development Representative.'), finalUrl: url }
    if (u.hostname.replace(/^www\./, '') !== 'levelupleads.org') return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    const b = ({ '/': HOME(homeName), '/contact': CONTACT } as Record<string, string>)[u.pathname]
    return b !== undefined ? { status: 200, body: b, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, redirectOf: async () => null, now: Date.parse('2026-11-21T09:00:00Z'), ...(fetchImpl ? { atsLookup: true, atsFetch: fetchImpl } : {}) })
  return (db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as { company_domain: string | null }).company_domain
}

test('a domainless lead takes the website its own ATS board (found by name slug) names, then passes homepage name proof', async () => {
  assert.equal(await runAts(BOARD({ name: 'LevelUp Leads', site: 'levelupleads.org' })), 'levelupleads.org')
})
test('without the ATS lookup the same lead stays unresolved (main behaviour)', async () => {
  assert.equal(await runAts(undefined), null)
})
test('a board matched by name only, with no website, gives nothing', async () => {
  assert.equal(await runAts(BOARD({ name: 'LevelUp Leads', site: null })), null)
})
test('a board whose name is another company gives nothing', async () => {
  assert.equal(await runAts(BOARD({ name: 'Totally Other Inc', site: 'levelupleads.org' })), null)
})
test('the board website must still pass homepage name proof', async () => {
  assert.equal(await runAts(BOARD({ name: 'LevelUp Leads', site: 'levelupleads.org' }), 'Different Brand'), null)
})
