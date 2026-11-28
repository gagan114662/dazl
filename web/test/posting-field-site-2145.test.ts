import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import * as sc from '../lib/connectors/sitecrawl.ts'

// #2145: a posting's template field "Website" (dt/dd or table row) names the employer's site; a "Website:" sentence in running text does not.
const wrap = (b: string) => `<html><body><h1>Tax Accountant</h1><p>Birchwood Tax LLP is hiring in Calgary.</p>${b}</body></html>`
const find = (b: string) => sc.findCompanySitesWithBasis('Birchwood Tax LLP', wrap(b), 'https://jobs.example-board.ca/job/1').map(o => o.site)

test('#2145 a Website field in a dt/dd pair or a table row names the employer site', () => {
  assert.deepEqual(find('<dl><dt>Website:</dt><dd>bwlp.ca</dd></dl>'), ['bwlp.ca'])
  assert.deepEqual(find('<dl><dt>Website</dt><dd><a href="https://www.bwlp.ca/">www.bwlp.ca</a></dd></dl>'), ['bwlp.ca'])
  assert.deepEqual(find('<table><tr><th>Employer website</th><td>bwlp.ca</td></tr></table>'), ['bwlp.ca'])
})

test('#2145 control: a Website sentence in running text is not a field (the Job Bank scoping guard)', () => {
  assert.deepEqual(find('<p>Website: bwlp.ca</p>'), [])
  assert.deepEqual(find('<ul><li>Website: bwlp.ca</li></ul>'), [])
  assert.deepEqual(find('<p>Our Website</p><p>bwlp.ca</p>'), [])
})

test('#2145 control: a field naming a social, board or government host is not taken', () => {
  assert.deepEqual(find('<dl><dt>Website</dt><dd>linkedin.com</dd></dl>'), [])
  assert.deepEqual(find('<dl><dt>Website</dt><dd>jobs.example-board.ca</dd></dl>'), [])
  assert.deepEqual(find('<dl><dt>Contact</dt><dd>bwlp.ca</dd></dl>'), [])
})

// The header card of a provincial association's job board (markup read by Gagan's QA on 2026-11-27, firm names kept as printed there):
// a <dl class="grid"> of label/value pairs inside wrapper divs, the label text padded with whitespace, the value a classless link.
const CARD = (label: string) => `<div class="block--larger card highlight-lighter"><dl class="grid">
  <div class="cf margin-bottom-5 job-detail-description__recruiter">
    <dt class="grid-item two-fifths portable-one-whole palm-one-half">Employer</dt>
    <dd class="grid-item three-fifths portable-one-whole palm-one-half"><a href="/employer/203842/l-bloxham-professional-corporation/"><span>L Bloxham Professional Corporation</span></a></dd>
  </div>
  <div class="cf margin-bottom-5 job-detail-description__website-upsell">
    <dt class="grid-item two-fifths portable-one-whole palm-one-half">
      ${label}
    </dt>
    <dd class="grid-item three-fifths portable-one-whole palm-one-half">
      <a href="https://www.lbpccpa.ca/" target="_blank">https://www.lbpccpa.ca/</a>
    </dd>
  </div>
  <div class="cf margin-bottom-5 job-detail-description__location">
    <dt class="grid-item two-fifths portable-one-whole palm-one-half">Location</dt>
    <dd class="grid-item three-fifths portable-one-whole palm-one-half"><span>Calgary (City), Alberta</span></dd>
  </div></dl></div>`
const cardSites = (label: string) => sc.findCompanySitesWithBasis('L Bloxham Professional Corporation', `<html><body>${CARD(label)}</body></html>`, 'https://jobs.cpaalberta.ca/job/2000742/senior-staff-accountant/?TrackID=10')

test('#2145 the header card shape: a whitespace-padded "Website" dt with a classless link in the dd names the employer site', () => {
  assert.deepEqual(cardSites('Website'), [{ site: 'lbpccpa.ca', basis: 'evidence_link_text', structured: true }])
})

test('#2145 control: the same card without a Website label gives no site (the Employer link is the board\'s own profile page)', () => {
  assert.deepEqual(cardSites('Salary'), [])
})

// End to end through crawlJob: the posting's Website field gives the candidate, the homepage identity and place checks decide, and the
// domain plus the published contact are persisted only for the right firm. Company domain found is not "Ready"; that is decided elsewhere.
const FIELD_PAGE = `<html><body><h1>Tax Accountant</h1><p>Birchwood Tax LLP is hiring a Tax Accountant in Calgary, Alberta.</p><dl class="grid"><div><dt class="grid-item">
  Website
</dt><dd class="grid-item"><a href="https://bwlp.ca/" target="_blank">https://bwlp.ca/</a></dd></div></dl></body></html>`
const SRC = 'https://jobs.example-board.ca/job/tax-accountant-birchwood-llp-4411'
async function crawlField(sites: Record<string, Record<string, string>>, page = FIELD_PAGE) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: ['Calgary, Alberta'] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,review_reason) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'Birchwood Tax LLP', null, 'Hiring a Tax Accountant in Calgary', SRC, 'Birchwood Tax LLP is hiring a Tax Accountant in Calgary, Alberta', 90, 70, null)
  const get: sc.Get = async url => {
    const u = new URL(url); const host = u.hostname.replace(/^www\./, '')
    if (url === SRC) return { status: 200, body: page, finalUrl: url }
    const site = sites[host]
    if (!site) return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    const b = site[u.pathname]
    return b !== undefined ? { status: 200, body: b, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  await sc.crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-27T12:00:00Z'), redirectOf: async () => null })
  const domain = (db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as { company_domain: string | null }).company_domain
  const emails = (db.prepare("SELECT value FROM lead_enrichments WHERE lead_id = 'L1' AND connector = 'sitecrawl' AND kind = 'email'").all() as { value: string }[]).map(r => r.value)
  return { domain, emails }
}
const HOME_OK = '<html><body><h1>Birchwood Tax LLP</h1><p>Suite 400, 123 8 Ave SW, Calgary, AB T2P 1B3</p><a href="/contact">Contact</a></body></html>'

test('#2145 end to end: the Website field gives the site, and its domain and published contact are persisted', async () => {
  const r = await crawlField({ 'bwlp.ca': { '/': HOME_OK, '/contact': '<html><body>Email our partner: partners@bwlp.ca</body></html>' } })
  assert.equal(r.domain, 'bwlp.ca')
  assert.deepEqual(r.emails, ['partners@bwlp.ca'])
})

test('#2145 end to end control: the field names a site that is another firm, nothing is persisted', async () => {
  const r = await crawlField({ 'bwlp.ca': { '/': '<html><body><h1>Northline Marketing</h1><p>Suite 5, Calgary, AB</p></body></html>', '/contact': '<html><body>hello@bwlp.ca</body></html>' } })
  assert.equal(r.domain, null)
  assert.deepEqual(r.emails, [])
})

test('#2145 end to end control: the field names the right firm in another city, nothing is persisted', async () => {
  const r = await crawlField({ 'bwlp.ca': { '/': '<html><body><h1>Birchwood Tax LLP</h1><p>Suite 5, 40 Queen St, Halifax, NS B3J 1A1</p></body></html>', '/contact': '<html><body>partners@bwlp.ca</body></html>' } })
  assert.equal(r.domain, null)
  assert.deepEqual(r.emails, [])
})

test('#2145 end to end control: a Website field a visitor cannot see (commented, scripted, templated, hidden) persists nothing', async () => {
  const field = '<dl><dt>Website</dt><dd><a href="https://bwlp.ca/">bwlp.ca</a></dd></dl>'
  const live = { 'bwlp.ca': { '/': HOME_OK, '/contact': '<html><body>Email our partner: partners@bwlp.ca</body></html>' } }
  const wrap = (inner: string) => `<html><body><h1>Tax Accountant</h1><p>Birchwood Tax LLP is hiring a Tax Accountant in Calgary, Alberta.</p>${inner}</body></html>`
  for (const inner of [`<!-- ${field} -->`, `<script>var f = '${field}'</script>`, `<template>${field}</template>`, `<div hidden>${field}</div>`, `<div aria-hidden="true">${field}</div>`, `<div style="display: none">${field}</div>`]) {
    const r = await crawlField(live, wrap(inner))
    assert.equal(r.domain, null, inner)
    assert.deepEqual(r.emails, [], inner)
  }
  const r = await crawlField(live, wrap(`<div hidden><p>x</p></div>${field}`))
  assert.equal(r.domain, 'bwlp.ca')
})

test('#2145 end to end: a plain unlinked address (bare or with https://) in a visible Website field names the site; the same text in body copy does not', async () => {
  const live = { 'bwlp.ca': { '/': HOME_OK, '/contact': '<html><body>Email our partner: partners@bwlp.ca</body></html>' } }
  const wrap = (inner: string) => `<html><body><h1>Tax Accountant</h1><p>Birchwood Tax LLP is hiring a Tax Accountant in Calgary, Alberta.</p>${inner}</body></html>`
  for (const v of ['https://bwlp.ca/', 'http://www.bwlp.ca', 'bwlp.ca']) {
    const r = await crawlField(live, wrap(`<dl><div><dt>\n  Website\n</dt><dd>${v}</dd></div></dl>`))
    assert.equal(r.domain, 'bwlp.ca', v)
    assert.deepEqual(r.emails, ['partners@bwlp.ca'], v)
  }
  for (const inner of ['<p>Website: https://bwlp.ca/</p>', '<p>Questions? See https://bwlp.ca/ for details.</p>', '<ul><li>Website https://bwlp.ca/</li></ul>']) {
    const r = await crawlField(live, wrap(inner))
    assert.equal(r.domain, null, inner)
  }
  // a plain value is still gated by identity and place
  const other = await crawlField({ 'bwlp.ca': { '/': '<html><body><h1>Northline Marketing</h1><p>Suite 5, Calgary, AB</p></body></html>' } }, wrap('<dl><dt>Website</dt><dd>https://bwlp.ca/</dd></dl>'))
  assert.equal(other.domain, null)
})
