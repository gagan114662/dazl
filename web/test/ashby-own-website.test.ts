import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ashbyOrgWebsite } from '../lib/connectors/sitecrawl.ts'

// Run 679a7354: n8n and Mintlify held no_company_domain; their postings never write out a domain. Each Ashby posting page (saved live
// 2026-11-21) carries the employer's own organization setting "publicWebsite" - the company's own statement, bound like a link.
const fx = (f: string) => readFileSync(new URL(`./fixtures/ashby-site/${f}`, import.meta.url), 'utf8')
test('the employer\'s own Ashby website setting names its domain (n8n, Mintlify)', () => {
  assert.equal(ashbyOrgWebsite(fx('n8n.html'), 'n8n'), 'n8n.io')
  assert.equal(ashbyOrgWebsite(fx('mintlify.html'), 'Mintlify'), 'mintlify.com')
})
test('holds: another company\'s page, a website whose name differs, a social or missing setting is nothing', () => {
  assert.equal(ashbyOrgWebsite(fx('mintlify.html'), 'n8n'), null)
  const org = (name: string, site: string | null) => `<script>window.__appData = {"organization":{"name":${JSON.stringify(name)},"publicWebsite":${JSON.stringify(site)}}}</script>`
  assert.equal(ashbyOrgWebsite(org('Acme', 'https://othername.com'), 'Acme'), null)
  assert.equal(ashbyOrgWebsite(org('Acme', 'https://linkedin.com/company/acme'), 'Acme'), null)
  assert.equal(ashbyOrgWebsite(org('Acme', null), 'Acme'), null)
  assert.equal(ashbyOrgWebsite(org('Other Co', 'https://acme.com'), 'Acme'), null)
})

// Qodo #1515 (1): a UK employer's own setting, "acme.co.uk": its name label is "acme" (the public suffix co.uk is not part of the name)
test('Qodo #1515: a website under a multi-label public suffix matches its own name (acme.co.uk is Acme), and still only its own', () => {
  const org = (name: string, site: string) => `<script>window.__appData = {"organization":{"name":${JSON.stringify(name)},"publicWebsite":${JSON.stringify(site)}}}</script>`
  assert.equal(ashbyOrgWebsite(org('Acme', 'https://www.acme.co.uk/'), 'Acme'), 'acme.co.uk')
  assert.equal(ashbyOrgWebsite(org('Acme', 'https://acme.com.au'), 'Acme'), 'acme.com.au')
  assert.equal(ashbyOrgWebsite(org('Acme', 'https://acmeco.uk'), 'Acme'), null)      // a different name, not a suffix split
  assert.equal(ashbyOrgWebsite(org('Acme', 'https://other.co.uk'), 'Acme'), null)
})

// Qodo #1515 (2): the posting also links a company-labelled site that is stale (the domain lapsed and is parked). That link must not hide the employer's own
// Ashby website setting: both are tried, each under the homepage name check, and the one that confirms wins. Real crawlJob path.
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
const AID = '4f0b8a52-6c11-4d6e-9a3e-0d2b7c9e1a55', ASRC = `https://jobs.ashbyhq.com/brightloom/${AID}`
const APROSE = '<p>Brightloom builds scheduling software for clinics and studios, used by thousands of small teams to run their day and get paid.</p>'
async function runAnchored(link: boolean, homeName = 'Brightloom') {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: [] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,event_date,event_date_proof) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'Brightloom', null, 'Hiring an SDR', ASRC, 'Sales Development Representative', 90, 85, '2026-11-13', 'ats_structured')
  const page = `<html><head><title>Sales Development Representative - Brightloom</title></head><body>${link ? '<a href="https://brightloom-old.com/">Brightloom</a>' : ''}<div id="root"></div>`
    + `<script>window.__appData = {"organization":{"name":"Brightloom","publicWebsite":"https://brightloom.io"}}</script></body></html>`
  const get: Get = async url => {
    const u = new URL(url)
    if (url === ASRC) return { status: 200, body: page, finalUrl: url }
    if (u.hostname === 'api.ashbyhq.com') return { status: 200, body: JSON.stringify({ jobs: [{ id: AID, isListed: true, title: 'Sales Development Representative', publishedAt: '2026-11-13T21:24:44Z', descriptionPlain: 'Join Brightloom.' }] }), finalUrl: url }
    const h = u.hostname.replace(/^www\./, '')
    if (h === 'brightloom-old.com') {                                             // the stale linked site: the domain lapsed and is parked now
      if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
      return u.pathname === '/' ? { status: 200, body: `<html><body><title>Domain for sale</title>This domain may be for sale. ${APROSE.replace(/Brightloom/g, 'This business')}</body></html>`, finalUrl: url } : { status: 404, body: '', finalUrl: url }
    }
    if (h !== 'brightloom.io') return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    return u.pathname === '/' ? { status: 200, body: `<html><body><title>${homeName}</title>${homeName} ${APROSE.replace(/Brightloom/g, homeName)}<a href="/contact">Contact</a></body></html>`, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, redirectOf: async () => null, now: Date.parse('2026-11-21T09:00:00Z') })
  return (db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as { company_domain: string | null }).company_domain
}
test('Qodo #1515: a stale company-labelled link on the posting does not hide the employer\'s own Ashby website', async () => {
  assert.equal(await runAnchored(false), 'brightloom.io', 'precondition: with no link the setting confirms')
  assert.equal(await runAnchored(true), 'brightloom.io')
})
test('Qodo #1515 holds: the setting still needs the homepage to name the company, link or not', async () => {
  assert.equal(await runAnchored(true, 'Parked Domain For Sale'), null)
})
