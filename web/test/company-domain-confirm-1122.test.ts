import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import * as sc from '../lib/connectors/sitecrawl.ts'   // helpers by namespace: on the base they do not exist, and each test then fails on its own behaviour

// #1122 follow-up (Hermes's decision 2026-11-14): a site found by the web search may prove its place on its OWN contact / about page or in its
// structured-data address, and may use a shortened company name - but a short name counts only together with that place. The companies, hosts
// and places below are the real ones from the local matrix scans of 2026-11-14 (the crawl's own audit rows); the page bodies are written to match
// what those audits recorded. The crawl runs for real (crawlJob); only the network is a table of pages.
const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>We have served our neighbours for many years and we stand behind every job we take on, large or small, rain or shine.</p>'
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`
type Search = (q: string) => Promise<{ ok: true; urls: string[] } | { ok: false; reason: string }>

async function run(o: { company: string; where: string[]; excerpt?: string; urls: string[]; sites: Record<string, Record<string, string>> }) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: o.where }), job)
  const ev = 'https://www.linkedin.example/posts/hiring-123'
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('L1', job, o.company, null, 'Hiring an estimator', ev, o.excerpt ?? `${o.company} is hiring an estimator`, 90, 85)
  const fetched: string[] = []
  const get: Get = async url => {
    const u = new URL(url); const host = u.hostname.replace(/^www\./, ''); fetched.push(host + u.pathname)
    if (host === 'linkedin.example') return { status: 200, body: html(`<p>${o.company} is hiring.</p>`), finalUrl: url }
    const site = o.sites[host]; if (!site) return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    const b = site[u.pathname]
    return b !== undefined ? { status: 200, body: b, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  const siteSearch: Search = async () => ({ ok: true, urls: o.urls })
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-14T12:00:00Z'), siteSearch })
  return {
    domain: (db.prepare("SELECT company_domain d FROM leads WHERE id = 'L1'").get() as { d: string | null }).d,
    basis: (db.prepare("SELECT value FROM lead_enrichments WHERE kind = 'domain'").all() as { value: string }[]).map(r => r.value),
    contacts: (db.prepare("SELECT value FROM lead_enrichments WHERE kind IN ('email','phone','person')").all() as { value: string }[]).map(r => r.value),
    unresolved: (db.prepare("SELECT label FROM lead_enrichments WHERE kind = 'domain_unresolved'").all() as { label: string }[]).map(r => r.label),
    refused: (db.prepare("SELECT value FROM lead_enrichments WHERE kind = 'contact_rejected'").all() as { value: string }[]).map(r => r.value),
    audit: (db.prepare("SELECT lookup, status FROM connector_audit WHERE connector = 'sitecrawl'").all() as { lookup: string; status: string }[]),
    fetched,
  }
}
const kept = (r: { domain: string | null; basis: string[]; contacts: string[] }) => ({ domain: r.domain, basis: r.basis, contacts: r.contacts })
const NOTHING = { domain: null, basis: [], contacts: [] }

// ---------- what now binds ----------
test('#1122 a searched site whose homepage states no place binds when its own CONTACT page gives the request\'s city (Queen Street Dental-shaped)', async () => {
  const r = await run({ company: 'Queen Street Dental', where: ['Toronto, Ontario'], urls: ['https://queenstreetdental-to.example/'],
    sites: { 'queenstreetdental-to.example': { '/': html(`<h1>Queen Street Dental</h1>${PROSE}<a href="/contact">Contact</a>`), '/contact': html('<p>Queen Street Dental, 200 Queen Street West, Toronto, ON M5V 1Z4</p><p>Email: info@queenstreetdental-to.example</p>') } } })
  assert.deepEqual(kept(r), { domain: 'queenstreetdental-to.example', basis: ['queenstreetdental-to.example|name_probe'], contacts: ['info@queenstreetdental-to.example'] })
  assert.deepEqual(r.unresolved, [])
})

test('#1122 a searched site that uses the SHORT name binds only because its structured-data address is in the request\'s city (the real Tadco case: "TADCO Roofing" for "Tadco Roofing & Waterproofing")', async () => {
  assert.equal(sc.shortCompanyName('Tadco Roofing & Waterproofing'), 'Tadco Roofing')
  const home = html(`<h1>TADCO Roofing</h1><p>The commercial roofing and waterproofing specialists of Texas.</p>${PROSE}<a href="/contact">Contact</a>${ld({ '@type': 'RoofingContractor', name: 'TADCO Roofing', address: { '@type': 'PostalAddress', streetAddress: '9001 Research Blvd', addressLocality: 'Austin', addressRegion: 'TX', postalCode: '78758' } })}`)
  const r = await run({ company: 'Tadco Roofing & Waterproofing', where: ['Austin, Texas'], urls: ['https://www.tadcoroofing.example/'], sites: { 'tadcoroofing.example': { '/': home, '/contact': html('Email: info@tadcoroofing.example') } } })
  assert.deepEqual(kept(r), { domain: 'tadcoroofing.example', basis: ['tadcoroofing.example|name_probe'], contacts: ['info@tadcoroofing.example'] })
})

// ---------- what must never bind (real wrong-company cases of 2026-11-14 and the short-name guards) ----------
test('#1122 NEGATIVE (real, kept): d-7 Roofing - the name-built d7roofing.com is another company in Rancho Cordova, CA and stays refused, even with a contact page; only the searched d-7roofing site in Austin binds', async () => {
  const ca = html(`<h1>D7 Roofing</h1><p>Visit us at 3131 Sunrise Blvd, Rancho Cordova, CA 95742.</p>${PROSE}<a href="/contact">Contact</a>`)
  const r = await run({ company: 'd-7 Roofing', where: ['Austin, Texas'], urls: ['https://d7roofing.com/', 'https://d-7roofing.example/'],
    sites: { 'd7roofing.com': { '/': ca, '/contact': html('<p>D7 Roofing, 3131 Sunrise Blvd, Rancho Cordova, CA 95742. We also quote jobs in Austin, TX.</p> Email: info@d7roofing.com') },
      'd-7roofing.example': { '/': html(`<h1>d-7 Roofing</h1><p>1200 Barton Springs Rd, Austin, TX 78704</p>${PROSE}<a href="/contact">Contact</a>`), '/contact': html('Email: office@d-7roofing.example') } } })
  assert.deepEqual(kept(r), { domain: 'd-7roofing.example', basis: ['d-7roofing.example|name_probe'], contacts: ['office@d-7roofing.example'] })
  assert.ok(r.audit.some(a => a.lookup === 'd7roofing.com' && /location mismatch Rancho Cordova, CA/.test(a.status)), JSON.stringify(r.audit))
  assert.ok(!r.contacts.includes('info@d7roofing.com'))
})

test('#1122 NEGATIVE (real): Gerken Roofing - gerkenroofs.com is a roofer in Irwin, PA; a searched site in another state is refused whatever its contact page says about serving Austin', async () => {
  const pa = html(`<h1>Gerken Roofing</h1><p>Family owned. 123 Main Street, Irwin, PA 15642.</p>${PROSE}<a href="/contact">Contact</a>`)
  const r = await run({ company: 'Gerken Roofing', where: ['Austin, Texas'], urls: ['https://gerkenroofing-pa.example/'],
    sites: { 'gerkenroofing-pa.example': { '/': pa, '/contact': html('<p>Gerken Roofing, 123 Main Street, Irwin, PA 15642. Ask about our projects in Austin, Texas.</p> Email: info@gerkenroofing-pa.example') } } })
  assert.deepEqual(kept(r), NOTHING)
  assert.deepEqual(r.unresolved, ['domain-unresolved-v1:search_result_not_confirmed'])
  assert.ok(r.refused.some(v => /location (mismatch|unconfirmed) Irwin, PA vs Austin, Texas/.test(v)), JSON.stringify(r.refused))
})

test('#1122 NEGATIVE (real): Mammoth Recruitment - a name-built site in another place is refused; its contact page is not consulted for a guess, and the search returned only listings', async () => {
  const elsewhere = html(`<h1>Mammoth Recruitment</h1><p>Level 2, 10 King Street, Manchester, England M2 6AG.</p>${PROSE}<a href="/contact">Contact</a>`)
  const r = await run({ company: 'Mammoth Recruitment', where: ['Austin, Texas'], urls: ['https://www.linkedin.com/company/mammoth', 'https://www.ziprecruiter.com/c/Mammoth'],
    sites: { 'mammothrecruitment.com': { '/': elsewhere, '/contact': html('<p>US desk: 500 W 2nd St, Austin, TX 78701</p> Email: hello@mammothrecruitment.com') } } })
  assert.deepEqual(kept(r), NOTHING)
  assert.deepEqual(r.unresolved, ['domain-unresolved-v1:search_found_no_candidate'])
})

test('#1122 NEGATIVE: a SHORT name with no place anywhere on the site is never enough ("Tadco Roofing" could be anyone)', async () => {
  const r = await run({ company: 'Tadco Roofing & Waterproofing', where: ['Austin, Texas'], urls: ['https://tadcoroofing.example/'],
    sites: { 'tadcoroofing.example': { '/': html(`<h1>TADCO Roofing</h1>${PROSE}<a href="/contact">Contact</a>`), '/contact': html('Email: info@tadcoroofing.example') } } })
  assert.deepEqual(kept(r), NOTHING)
  assert.ok(r.refused.some(v => /shortened company name, so its own place must agree/.test(v)), JSON.stringify(r.refused))
  assert.deepEqual(r.unresolved, ['domain-unresolved-v1:search_result_not_confirmed'])
})

test('#1122 NEGATIVE: a SHORT name whose site is in another city or state is refused: structured address elsewhere; contact page elsewhere; the city only mentioned in passing', async () => {
  const base = { company: 'Tadco Roofing & Waterproofing', where: ['Austin, Texas'], urls: ['https://tadcoroofing.example/'] }
  const dallas = ld({ '@type': 'RoofingContractor', name: 'TADCO Roofing', address: { streetAddress: '1 Elm St', addressLocality: 'Tulsa', addressRegion: 'OK', postalCode: '74103' } })
  const a = await run({ ...base, sites: { 'tadcoroofing.example': { '/': html(`<h1>TADCO Roofing</h1>${PROSE}<a href="/contact">Contact</a>${dallas}`), '/contact': html('Email: info@tadcoroofing.example') } } })
  assert.deepEqual(kept(a), NOTHING, 'structured address in Tulsa, OK')
  const b = await run({ ...base, sites: { 'tadcoroofing.example': { '/': html(`<h1>TADCO Roofing</h1>${PROSE}<a href="/contact">Contact</a>`), '/contact': html('<p>TADCO Roofing, 77 Peachtree St, Atlanta, GA 30303</p> Email: info@tadcoroofing.example') } } })
  assert.deepEqual(kept(b), NOTHING, 'contact page in Atlanta, GA')
  const c = await run({ ...base, sites: { 'tadcoroofing.example': { '/': html(`<h1>TADCO Roofing</h1><p>Headquarters: 77 Peachtree St, Atlanta, GA 30303.</p>${PROSE}<a href="/contact">Contact</a>`), '/contact': html('<p>We have completed projects in Austin, Texas and beyond.</p> Email: info@tadcoroofing.example') } } })
  assert.deepEqual(kept(c), NOTHING, 'its own address is in Georgia; Austin is only mentioned')
})

test('#1122 NEGATIVE: the contact-page place and the short name are for a SEARCHED site only: a name-built guess and a site the page links are still judged on the homepage, with the full name', async () => {
  // a name-built guess (bentocafeyvr.com-shaped): homepage states no place, the contact page does -> still refused, as before this PR
  const guess = await run({ company: 'Bento Cafe YVR', where: ['Vancouver, British Columbia'], urls: [],
    sites: { 'bentocafeyvr.com': { '/': html(`<h1>Bento Cafe YVR</h1>${PROSE}<a href="/contact">Contact</a>`), '/contact': html('<p>1055 W Georgia St, Vancouver, BC V6E 3P3</p> Email: hello@bentocafeyvr.com') } } })
  assert.deepEqual(kept(guess), NOTHING)
  assert.equal(sc.shortCompanyName('Bento Cafe YVR'), null); assert.equal(sc.shortCompanyName('d-7 Roofing'), null); assert.equal(sc.shortCompanyName('Smith & Sons'), null, 'a one-word remainder is a common word, not a name')
  assert.equal(sc.shortCompanyName('Queen Street Dental Centre'), 'Queen Street Dental'); assert.equal(sc.shortCompanyName('Johnson and Johnson'), null)
  assert.equal(sc.structuredAddressText(ld({ address: { streetAddress: '200 Queen St W', addressLocality: 'Toronto', addressRegion: 'ON', postalCode: 'M5V 1Z4' } })), '200 Queen St W, Toronto, ON M5V 1Z4')
  assert.equal(sc.structuredAddressText(ld({ address: { addressLocality: 'Toronto' } })), '', 'a city without its region is not an address')
  assert.equal(sc.structuredAddressText('<script type="application/ld+json">{bad</script>' + ld(Array(300_000).fill(0))), '')
})
