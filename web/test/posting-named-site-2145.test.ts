import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import * as sc from '../lib/connectors/sitecrawl.ts'

// #2145: a dated job-board lead (a provincial association's job board) showed "No contact found yet": every domain tried was a name guess,
// and a guess must state the place itself. The posting page can name the employer's own site under a plain label ("Visit employer website")
// that does not repeat the company name. Such a site is a candidate that keeps every identity and place check; a guess stays held.
// Fictional firm and hosts; the page shape (a board page with an employer-website link) is a sample, not a live read.
const SRC = 'https://jobs.example-board.ca/job/tax-accountant-birchwood-llp-4411'
const html = (b: string) => `<html><body>${b}</body></html>`
const page = (link: string, desc = '') => html(`<h1>Tax Accountant</h1><h2>Birchwood Tax LLP</h2><p>Birchwood Tax LLP is hiring a Tax Accountant in Calgary, Alberta.</p>${link}${desc}<a href="https://www.example-board.ca/post-a-job">Post a job</a>`)
const HOME_CALGARY = html('<h1>Birchwood Tax LLP</h1><p>Suite 400, 123 8 Ave SW, Calgary, AB T2P 1B3</p><a href="/contact">Contact</a>')
const HOME_OTHER_FIRM = html('<h1>Northline Marketing</h1><p>Suite 5, 40 Queen St, Halifax, NS</p><a href="/contact">Contact</a>')

async function run(evidence: string, sites: Record<string, Record<string, string>>) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: ['Calgary, Alberta'] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,review_reason) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'Birchwood Tax LLP', null, 'Hiring a Tax Accountant in Calgary', SRC, 'Birchwood Tax LLP is hiring a Tax Accountant in Calgary, Alberta', 90, 70, null)
  const get: sc.Get = async url => {
    const u = new URL(url); const host = u.hostname.replace(/^www\./, '')
    if (url === SRC) return { status: 200, body: evidence, finalUrl: url }
    const site = sites[host]
    if (!site) return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    const b = site[u.pathname]
    return b !== undefined ? { status: 200, body: b, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  await sc.crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-27T12:00:00Z'), redirectOf: async () => null })
  return (db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as { company_domain: string | null }).company_domain
}

test('#2145 a site the posting names under a plain "employer website" label is tried, and kept when its homepage names the firm and the place', async () => {
  const d = await run(page('<a href="https://birchwoodlp.ca/">Visit employer website</a>'), { 'birchwoodlp.ca': { '/': HOME_CALGARY, '/contact': html('Email: partners@birchwoodlp.ca') } })
  assert.equal(d, 'birchwoodlp.ca')
})

test('#2145 control: the same page with no named site leaves a same-name guessed domain held (the search place alone proves nothing)', async () => {
  const noPlace = html('<h1>Birchwood Tax LLP</h1><p>Tax and advisory services.</p><a href="/contact">Contact</a>')
  const d = await run(page(''), { 'birchwoodtaxllp.com': { '/': noPlace, '/contact': html('Email: info@birchwoodtaxllp.com') } })
  assert.equal(d, null)
})

test('#2145 control: a named site whose homepage is another business is refused', async () => {
  const d = await run(page('<a href="https://northline.example/">Visit employer website</a>'), { 'northline.example': { '/': HOME_OTHER_FIRM } })
  assert.equal(d, null)
  const d2 = await run(page('', '<p>Questions? Visit northline.example</p>'), { 'northline.example': { '/': HOME_OTHER_FIRM } })
  assert.equal(d2, null)
})

test('#2145 control: a named site with the firm\'s name that is in another city is refused', async () => {
  const halifax = html('<h1>Birchwood Tax LLP</h1><p>Suite 5, 40 Queen St, Halifax, NS B3J 1A1</p>')
  const d = await run(page('<a href="https://birchwoodtax.ca/">Visit employer website</a>'), { 'birchwoodtax.ca': { '/': halifax } })
  assert.equal(d, null)
})

test('#2145 control: a link without an employer-website label, and a host only mentioned in running text, are not taken', async () => {
  assert.equal(await run(page('<a href="https://birchwoodlp.ca/">Apply now</a>'), { 'birchwoodlp.ca': { '/': HOME_CALGARY, '/contact': html('Email: partners@birchwoodlp.ca') } }), null)
  assert.equal(await run(page('', '<p>Questions: hr@somevendor.ca, or see www.birchwoodlp.ca</p>'), { 'somevendor.ca': { '/': HOME_CALGARY }, 'birchwoodlp.ca': { '/': HOME_CALGARY } }), null)
})
