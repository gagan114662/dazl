import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import * as sc from '../lib/connectors/sitecrawl.ts'

// Scenarios originally reproduced by Fo on #2131.
const SRC = 'https://jobs.example-board.ca/job/tax-accountant-birchwood-llp-4411'
const html = (b: string) => `<html><body>${b}</body></html>`
const page = (link: string, desc = '') => html(`<h1>Tax Accountant</h1><h2>Birchwood Tax LLP</h2><p>Birchwood Tax LLP is hiring a Tax Accountant in Calgary, Alberta.</p>${link}${desc}<a href="https://www.example-board.ca/post-a-job">Post a job</a>`)

const postingId = '7387a987-24f3-424c-8dd3-bb7ed16f95e0'
const atsSource = `https://jobs.ashbyhq.com/birchwood/${postingId}`

async function run(evidence: string, sites: Record<string, Record<string, string>>, atsLocation?: string, company = 'Birchwood Tax LLP', description = 'Birchwood Tax LLP is hiring. Learn more at birchwoodtaxllp.ca.', expectedProof?: string | null) {
  const source = atsLocation === undefined ? SRC : atsSource
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: ['Calgary, Alberta'] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,review_reason) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('L1', job, company, null, 'Hiring a Tax Accountant in Calgary', source, 'Birchwood Tax LLP is hiring a Tax Accountant in Calgary, Alberta', 90, 70, null)
  const get: sc.Get = async url => {
    const u = new URL(url); const host = u.hostname.replace(/^www\./, '')
    if (url === 'https://api.ashbyhq.com/posting-api/job-board/birchwood' && atsLocation !== undefined) {
      return { status: 200, body: JSON.stringify({ jobs: [{ id: postingId, isListed: true,
        title: 'Tax Accountant', location: atsLocation, jobUrl: source,
        descriptionPlain: description }] }), finalUrl: url }
    }
    if (url === source) return { status: 200, body: evidence, finalUrl: url }
    const site = sites[host]
    if (!site) return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    const b = site[u.pathname]
    return b !== undefined ? { status: 200, body: b, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  await sc.crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-27T12:00:00Z'), redirectOf: async () => null })
  const domain = (db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as { company_domain: string | null }).company_domain
  if (expectedProof !== undefined) {
    const proofs = db.prepare("SELECT source_url FROM lead_enrichments WHERE lead_id = ? AND kind = 'domain_check' AND value LIKE '%|identity_checked'")
      .pluck().all('L1')
    assert.deepEqual(proofs, expectedProof === null ? [] : [expectedProof])
  }
  db.close()
  return domain
}


const site = 'birchwoodtax.ca'
const namedLink = '<a href="https://birchwoodtax.ca/">Visit employer website</a>'
const noPlace = html('<h1>Birchwood Tax LLP</h1><p>Tax and advisory services.</p>')

test('uses the fetched employer posting when its named site omits location', async () => {
  assert.equal(await run(page(namedLink), { [site]: { '/': noPlace } }), site)
})

test('keeps a site held when its homepage states a conflicting place', async () => {
  const elsewhere = html('<h1>Birchwood Tax LLP</h1><p>Suite 5, 40 Queen St, Halifax, NS B3J 1A1</p>')
  assert.equal(await run(page(namedLink), { [site]: { '/': elsewhere } }), null)
})

test('keeps a same-name guessed site held when it omits location', async () => {
  assert.equal(await run(page(''), { 'birchwoodtaxllp.com': { '/': noPlace } }), null)
})

test('never uses a lead summary to supply a place absent from the posting', async () => {
  const posting = html(`<h1>Tax Accountant</h1><h2>Birchwood Tax LLP</h2>${namedLink}`)
  assert.equal(await run(posting, { [site]: { '/': noPlace } }), null)
})

const atsEmployerPage = html('<h1>Jobs</h1><script type="application/json">{"organization":{"name":"Birchwood Tax LLP","publicWebsite":"https://birchwoodtaxllp.ca/"}}</script>')

test('uses the employer ATS record when it names its site and states the requested place', async () => {
  assert.equal(await run(atsEmployerPage, { 'birchwoodtaxllp.ca': { '/': noPlace } }, 'Calgary, Alberta'), 'birchwoodtaxllp.ca')
})

test('holds a record-named site when only the lead summary states the place', async () => {
  assert.equal(await run(atsEmployerPage, { 'birchwoodtaxllp.ca': { '/': noPlace } }, ''), null)
})

test('holds a named site when the posting location appears only in hidden markup', async () => {
  const posting = html(`<h1>Tax Accountant</h1><h2>Birchwood Tax LLP</h2>${namedLink}<div hidden>Birchwood Tax LLP is hiring in Calgary, Alberta.</div>`)
  assert.equal(await run(posting, { [site]: { '/': noPlace } }), null)
})

test('holds a named site when the employer explicitly denies operating in the requested place', async () => {
  const posting = html(`<p>Birchwood Tax LLP does not operate in Calgary, Alberta.</p>${namedLink}`)
  assert.equal(await run(posting, { [site]: { '/': noPlace } }), null)
})

test('does not use ATS location to confirm another same-named firm mentioned in passing', async () => {
  const description = 'Our training partner is Birchwood Tax LLP at birchwoodtaxllp.ca.'
  assert.equal(await run(html('<h1>Jobs</h1>'), { 'birchwoodtaxllp.ca': { '/': noPlace } },
    'Calgary, Alberta', 'Birchwood Tax LLP', description), null)
})

test('recognizes a hiring statement with a period in the legal company name', async () => {
  const posting = html(`<p>Birchwood Tax Inc. is hiring a Tax Accountant in Calgary, Alberta.</p>${namedLink}`)
  assert.equal(await run(posting, { [site]: { '/': html('<h1>Birchwood Tax Inc.</h1>') } },
    undefined, 'Birchwood Tax Inc.'), site)
})

for (const [city, shouldKeep] of [['Calgary, AB T2P 1B3', true], ['Halifax, NS B3J 1A1', false]] as const) {
  test(`checks the named site's contact office in ${city} before using posting evidence`, async () => {
    const sites = { [site]: {
      '/': html('<h1>Birchwood Tax LLP</h1><a href="/contact">Contact</a>'),
      '/contact': html(`<h1>Contact Birchwood Tax LLP</h1><p>Birchwood Tax LLP, 40 Queen St, ${city}</p><p>Our office is at 40 Queen St, ${city}.</p>`),
    } }
    assert.equal(await run(page(namedLink), sites, undefined, undefined, undefined,
      shouldKeep ? `https://${site}/contact` : null), shouldKeep ? site : null)
  })
}

test('holds a named site if the posting later corrects the role location', async () => {
  const posting = page(namedLink, '<p>Correction: Birchwood Tax LLP is hiring for this role in Halifax, Nova Scotia.</p>')
  assert.equal(await run(posting, { [site]: { '/': noPlace } }), null)
})

for (const [city, shouldKeep] of [['Calgary, Alberta', true], ['Halifax, Nova Scotia', false]] as const) {
  test(`requires the ATS role description in ${city} to agree with the location field`, async () => {
    const description = `Birchwood Tax LLP is hiring a Tax Accountant in ${city}. Learn more at birchwoodtaxllp.ca.`
    assert.equal(await run(atsEmployerPage, { 'birchwoodtaxllp.ca': { '/': noPlace } },
      'Calgary, Alberta', undefined, description), shouldKeep ? 'birchwoodtaxllp.ca' : null)
  })
}
