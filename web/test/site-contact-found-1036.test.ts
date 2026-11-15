// #1036 (Hermes 01:25, item 2: a lead with a confirmed website must carry the site's own published contact). Two ways a site's own
// published inbox was never read, both seen on real pages:
//   1. a hyphenated own domain (d-7roofing.com for "D-7 Roofing", cited as the lead's own page) never matched its company, so the crawl
//      probed d7roofing.com (another company, in California) and read nothing of the real site;
//   2. a site behind Cloudflare's email protection prints no address at all (data-cfemail / /cdn-cgi/l/email-protection#<hex>).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { cfEmails, crawlJob, extractContacts, findCompanySitesWithBasis, type Get } from '../lib/connectors/sitecrawl.ts'
import { enrichmentsForLeads } from '../lib/connectors/store.ts'

test('a hyphenated own domain is the company\'s own site, like the same name without the hyphen', () => {
  assert.deepEqual(findCompanySitesWithBasis('D-7 Roofing', '<html></html>', 'https://www.d-7roofing.com/'), [{ site: 'd-7roofing.com', basis: 'evidence_own_domain' }])
  assert.deepEqual(findCompanySitesWithBasis('Smith Dental', '<a href="https://smith-dental.com/">Smith Dental</a>', 'https://jobs.example.org/posting/1'), [{ site: 'smith-dental.com', basis: 'evidence_link_domain_label' }])
  assert.deepEqual(findCompanySitesWithBasis('Roof Royale', '<html></html>', 'https://roofroyale.com/'), [{ site: 'roofroyale.com', basis: 'evidence_own_domain' }], 'unchanged without a hyphen')
  assert.deepEqual(findCompanySitesWithBasis('Smith Dental', '<html></html>', 'https://jones-dental.com/'), [], 'another company is still another company')
})

const enc = (email: string, key = 0x42) => key.toString(16).padStart(2, '0') + [...email].map(c => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('')
test('Cloudflare-protected addresses are decoded and go through the same role + same-site filter', () => {
  const html = `<p>Write to us</p><a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${enc('info@smith-dental.com')}">[email&#160;protected]</a>`
    + `<a href="/cdn-cgi/l/email-protection#${enc('jane.doe@smith-dental.com', 0x7a)}">email Jane</a><span data-cfemail="${enc('sales@othersite.com')}"></span><span data-cfemail="zz12"></span><span data-cfemail="${enc('not an email')}"></span>`
  assert.deepEqual(cfEmails(html), ['info@smith-dental.com', 'jane.doe@smith-dental.com', 'sales@othersite.com'])
  assert.deepEqual(extractContacts(html, 'https://smith-dental.com/contact', 'smith-dental.com').filter(f => f.kind === 'email').map(f => f.value), ['info@smith-dental.com'], 'role inbox on this site only; a personal or another site\'s address is not a role contact')
  assert.deepEqual(cfEmails(`<span data-cfemail="${enc('a@b.co')}"></span>`.repeat(60)).length, 40, 'bounded')
})

test('end to end: a lead citing its own hyphenated, Cloudflare-protected site gets the site\'s published inbox during the scan', async () => {
  const PROSE = '<p>D-7 Roofing is a commercial roofing contractor serving Austin and Central Texas. We install, repair and maintain roofs for warehouses, offices and retail buildings, and we answer every call within the hour.</p>'
  const pages: Record<string, string> = {
    '/robots.txt': 'User-agent: *\nAllow: /',
    '/': `<html><body>${PROSE}<p>D-7 Roofing, 200 Example Rd, Austin, TX 78701</p><a href="/contact-us">Contact</a><a href="/cdn-cgi/l/email-protection" data-cfemail="${enc('info@d-7roofing.com')}">[email&#160;protected]</a></body></html>`,
    '/contact-us': `<html><body>${PROSE}</body></html>`,
  }
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const job = createJob(db, 'T', { business_name: 'Seller', industry: 'roofing', location: 'Austin, TX' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', who: ['Owner'], where: ['Austin, TX'], signals: [] }), job)
  const lead = 'e'.repeat(24)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)').run(lead, job, 'D-7 Roofing', null, 'Commercial roofer in Austin', 'https://www.d-7roofing.com/', 'D-7 Roofing is a commercial roofing contractor', 90, 80)
  const asked: string[] = []
  const get: Get = async url => { const u = new URL(url); asked.push(u.hostname); const p = u.hostname.endsWith('d-7roofing.com') ? pages[u.pathname] : undefined; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 'T', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-15T06:00:00Z') })
  const rows = enrichmentsForLeads(db, 'T', [lead])[lead] ?? []
  assert.ok(rows.some(r => r.kind === 'domain' && r.value === 'd-7roofing.com|evidence_own_domain'), JSON.stringify(rows.map(r => [r.kind, r.value])))
  assert.deepEqual(rows.filter(r => r.kind === 'email').map(r => [r.value, r.source_url]), [['info@d-7roofing.com', 'https://d-7roofing.com/']])
  assert.ok(!asked.includes('d7roofing.com'), 'the own site is read first; no name probe of an unhyphenated stranger is needed')
})
