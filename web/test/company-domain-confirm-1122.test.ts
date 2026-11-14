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
  assert.ok(r.refused.some(v => /shortened company name, so it must give a postal address in the requested city/.test(v)), JSON.stringify(r.refused))
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
  assert.equal(sc.structuredAddressText(ld({ '@type': 'Dentist', address: { streetAddress: '200 Queen St W', addressLocality: 'Toronto', addressRegion: 'ON', postalCode: 'M5V 1Z4' } })), '200 Queen St W, Toronto, ON M5V 1Z4')
  assert.equal(sc.structuredAddressText(ld({ '@type': 'Dentist', address: { addressLocality: 'Toronto' } })), '', 'a city without its region is not an address')
  assert.equal(sc.structuredAddressText(ld({ address: { streetAddress: '1 A St', addressLocality: 'Toronto', addressRegion: 'ON' } })), '', 'an address on a node that is not typed as an organisation is not the site\'s own')
  assert.equal(sc.structuredAddressText('<script type="application/ld+json">{bad</script>' + ld(Array(300_000).fill(0))), '')
})

// ---------- council round 1 (all three found ways a short name could be confirmed without a real address) ----------
test('#1122 council: a SHORT name is confirmed only by a POSTAL address in the requested city: "projects in Austin" on the contact page and a list of cities on a locations page are not one', async () => {
  const base = { company: 'Tadco Roofing & Waterproofing', where: ['Austin, Texas'], urls: ['https://tadcoroofing.example/'] }
  const home = html(`<h1>TADCO Roofing</h1>${PROSE}<a href="/contact">Contact</a><a href="/locations">Locations</a>`)
  const mention = await run({ ...base, sites: { 'tadcoroofing.example': { '/': home, '/contact': html('<p>We have completed projects in Austin, Texas and beyond.</p> Email: info@tadcoroofing.example') } } })
  assert.deepEqual(kept(mention), NOTHING, 'a mention is not an address')
  const list = await run({ ...base, sites: { 'tadcoroofing.example': { '/': home, '/contact': html('Email: info@tadcoroofing.example'), '/locations': html('<p>Austin, Texas; Dallas, Texas; Tulsa, Oklahoma; Atlanta, Georgia.</p>') } } })
  assert.deepEqual(kept(list), NOTHING, 'a list of cities served is not an address')
  // the real Tadco shape: several offices, one of them a full postal address in the requested city -> binds, and the rows say a short name was used
  const offices = await run({ ...base, sites: { 'tadcoroofing.example': { '/': html(`<h1>TADCO Roofing</h1><p>The commercial roofing specialists of Texas.</p>${PROSE}<a href="/contact">Contact</a><footer>902 E. Owassa Rd, Edinburg, TX 78542 5440 Guhn Rd Houston, TX 77040 4437 Supply Court, Bldg 4, Austin, TX 78744</footer>`), '/contact': html('Email: info@tadcoroofing.example') } } })
  assert.equal(offices.domain, 'tadcoroofing.example')
  assert.ok(sc.postalAddressInCity('4437 Supply Court, Bldg 4, Austin, TX 78744', ['Austin, Texas'])); assert.ok(sc.postalAddressInCity('200 Queen Street West, Toronto, ON M5V 1Z4', ['Toronto, Ontario']))
  for (const t of ['We have completed projects in Austin, Texas and beyond.', 'Austin, Texas; Dallas, Texas', '77 Peachtree St, Atlanta, GA 30303. Projects in Austin, TX 78701', '1 Elm St, Tulsa, OK 74103']) assert.equal(sc.postalAddressInCity(t, ['Austin, Texas']), false, t)
  assert.equal(sc.postalAddressInCity('1 Main St, Austin, TX 78701', []), false, 'a request with no city confirms no short name')
})

test('#1122 council: a short-name bind says so on its rows (the identity check and each contact), a full-name bind keeps the old words', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: ['Austin, Texas'] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)').run('L1', job, 'Tadco Roofing & Waterproofing', null, 's', 'https://www.linkedin.example/p', 'Tadco Roofing & Waterproofing is hiring', 90, 85)
  const home = html(`<h1>TADCO Roofing</h1>${PROSE}<a href="/contact">Contact</a><footer>4437 Supply Court, Bldg 4, Austin, TX 78744</footer>`)
  const get: Get = async url => { const u = new URL(url); const h = u.hostname.replace(/^www\./, ''); if (h === 'linkedin.example') return { status: 200, body: html('x'), finalUrl: url }; if (h !== 'tadcoroofing.example') return null; return u.pathname === '/robots.txt' ? { status: 200, body: '', finalUrl: url } : u.pathname === '/' ? { status: 200, body: home, finalUrl: url } : u.pathname === '/contact' ? { status: 200, body: html('Email: info@tadcoroofing.example'), finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, siteSearch: async () => ({ ok: true, urls: ['https://tadcoroofing.example/'] }) })
  const rows = db.prepare("SELECT kind, label FROM lead_enrichments WHERE kind IN ('domain_check', 'email')").all() as { kind: string; label: string }[]
  assert.equal(rows.find(x => x.kind === 'domain_check')?.label, 'identity-check-v2: the site uses the short name "Tadco Roofing" and gives a postal address in the requested city')
  assert.match(rows.find(x => x.kind === 'email')?.label ?? '', /site found by name search and location match, not linked from the source; short name on site$/)
})

test('#1122 council: a short name that is only trade words or the request\'s own city is no name at all, and the city inside a company name is not a place', async () => {
  const A = ['Austin, Texas']
  for (const c of ['Family Dental & Orthodontics', 'First National Bank and Trust', 'Best Roofing - Austin', 'Austin Roofing & Construction', 'Austin Roofing Services', 'Dental Group & Associates Services', 'Smith & Sons', 'Johnson and Johnson']) assert.equal(sc.shortCompanyName(c, A), null, c)
  assert.equal(sc.shortCompanyName('Tadco Roofing & Waterproofing', A), 'Tadco Roofing'); assert.equal(sc.shortCompanyName('Queen Street Dental Centre', ['Toronto, Ontario']), 'Queen Street Dental')
  assert.equal(sc.shortCompanyName(`${'Very Long Name '.repeat(20)}& Co`, A), null, 'no unbounded name')
  // through the crawl: a site that says only "Austin Roofing" with a Houston phone and no address is never the Austin lead's site
  const r = await run({ company: 'Austin Roofing & Construction', where: A, urls: ['https://austinroofing.example/'],
    sites: { 'austinroofing.example': { '/': html(`<h1>Austin Roofing</h1><p>Residential roofing since 1990. Call (713) 555 0100.</p>${PROSE}<a href="/contact">Contact</a>`), '/contact': html('Email: info@austinroofing.example') } } })
  assert.deepEqual(kept(r), NOTHING)
})

test('#1122 council: a structured address that belongs to someone else (a review\'s author, the parent organisation, the area served, an event venue) is never the site\'s own', async () => {
  const ad = (city: string, region: string, zip: string) => ({ '@type': 'PostalAddress', streetAddress: '12 Oak St', addressLocality: city, addressRegion: region, postalCode: zip })
  const node = { '@type': 'RoofingContractor', name: 'TADCO Roofing', address: ad('Dallas', 'TX', '75201'), review: { '@type': 'Review', author: { '@type': 'Person', address: ad('Austin', 'TX', '78701') } },
    parentOrganization: { '@type': 'Organization', address: ad('Austin', 'TX', '78702') }, areaServed: { '@type': 'City', address: ad('Austin', 'TX', '78703') }, event: { '@type': 'Event', location: { '@type': 'Place', address: ad('Austin', 'TX', '78704') } } }
  assert.equal(sc.structuredAddressText(ld(node)), '12 Oak St, Dallas, TX 75201')
  const r = await run({ company: 'Tadco Roofing & Waterproofing', where: ['Austin, Texas'], urls: ['https://tadcoroofing.example/'],
    sites: { 'tadcoroofing.example': { '/': html(`<h1>TADCO Roofing</h1>${PROSE}<a href="/contact">Contact</a>${ld(node)}`), '/contact': html('Email: info@tadcoroofing.example') } } })
  assert.deepEqual(kept(r), NOTHING, 'the site is in Dallas; the Austin addresses on it are other people\'s')
})

test('#1122 council (opus S1-S7): seven wrong-site shapes that bound at the first head and never bound on #1219 - each keeps NOTHING', async () => {
  const A = ['Austin, Texas']
  const site = (home: string, pages: Record<string, string> = {}) => ({ '/': html(`${home}${PROSE}<a href="/contact">Contact</a><a href="/about">About</a><a href="/locations">Locations</a>`), '/contact': html('Email: hi@x.example'), ...pages })
  const cases: [string, Parameters<typeof run>[0]][] = [
    ['S1 the city is only inside the short name', { company: 'Austin Roofing Services', where: A, urls: ['https://austinroofing.example/'], sites: { 'austinroofing.example': site('<h1>Austin Roofing</h1>') } }],
    ['S2 a passing mention on the about page', { company: 'Corey Construction Residential', where: A, urls: ['https://coreyconstruction.example/'], sites: { 'coreyconstruction.example': site('<h1>Corey Construction</h1>', { '/about': html('<p>Recent work: a kitchen remodel for a client who moved to Austin last spring.</p>') }) } }],
    ['S3 its own address is in Dallas; Austin is in a list of places served', { company: 'Tadco Roofing & Waterproofing', where: A, urls: ['https://tadcoroofing.example/'], sites: { 'tadcoroofing.example': site('<h1>TADCO Roofing</h1>', { '/contact': html('<p>TADCO Roofing, 100 Elm St, Dallas, TX 75201. Proudly serving Dallas, Fort Worth, Austin and San Antonio.</p> Email: info@tadcoroofing.example') }) } }],
    ['S4 the homepage is in Tulsa; a locations page lists a bare Austin ZIP', { company: 'Tadco Roofing & Waterproofing', where: A, urls: ['https://tadcoroofing.example/'], sites: { 'tadcoroofing.example': site('<h1>TADCO Roofing</h1><p>1 Elm St, Tulsa, OK 74103</p>', { '/locations': html('<p>Tulsa, OK 74103 · Wichita, KS 67202 · Austin, TX 78701</p>') }) } }],
    ['S5 FULL name, homepage states no place, the about page only mentions jobs in Austin', { company: 'Gerken Roofing', where: A, urls: ['https://gerkenroofing-co.example/'], sites: { 'gerkenroofing-co.example': site('<h1>Gerken Roofing</h1>', { '/about': html('<p>Recent jobs in Austin, TX and Round Rock, TX.</p>') }) } }],
    ['S6 an event venue in Austin in the structured data', { company: 'Tadco Roofing & Waterproofing', where: A, urls: ['https://tadcoroofing.example/'], sites: { 'tadcoroofing.example': site(`<h1>TADCO Roofing</h1>${ld({ '@type': 'Event', location: { '@type': 'Place', address: { streetAddress: '500 E Cesar Chavez St', addressLocality: 'Austin', addressRegion: 'TX', postalCode: '78701' } } })}`) } }],
    ['S7 only a street that exists in every town matches the lead', { company: 'Tadco Roofing & Waterproofing', where: A, excerpt: 'Tadco Roofing & Waterproofing, 100 Main Street, is hiring', urls: ['https://tadcoroofing.example/'], sites: { 'tadcoroofing.example': site('<h1>TADCO Roofing</h1>', { '/contact': html('<p>Find us at 100 Main Street.</p> Email: info@tadcoroofing.example') }) } }],
  ]
  for (const [name, c] of cases) assert.deepEqual(kept(await run(c)), NOTHING, name)
  // and the pages can only ADD: a homepage whose own address is in another state stays refused even when another page gives a full Austin address
  const override = await run({ company: 'Gerken Roofing', where: A, urls: ['https://gerkenroofing-co.example/'], sites: { 'gerkenroofing-co.example': site('<h1>Gerken Roofing</h1><p>Family owned. 123 Main Street, Irwin, PA 15642.</p>', { '/locations': html('<p>Gerken Roofing, 77 Congress Ave, Austin, TX 78701</p>') }) } })
  assert.deepEqual(kept(override), NOTHING, 'what the homepage says is never cleared by another page')
})

test('#1122 council (R8): a page of unclosed <script> tags costs linear time, and addresses are read from every page as short lines, never as prose', () => {
  const hostile = '<script type="application/ld+json" '.repeat(18_000)   // ~650 KB, under the crawl's page cap
  const t0 = Date.now()
  assert.deepEqual(sc.ldJsonBlocks(hostile), []); assert.equal(sc.structuredAddressText(hostile), ''); assert.deepEqual(sc.jsonLdCompanySites('Restor Dental', hostile), []); assert.deepEqual(sc.postalAddressSnippets(hostile), [])
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`)
  assert.deepEqual(sc.ldJsonBlocks('<SCRIPT type="application/ld+json">{"a":1}</SCRIPT><script>x</script><script type=\'application/ld+json\'>[2]</script>'), ['{"a":1}', '[2]'])
  assert.deepEqual(sc.postalAddressSnippets('<p>We serve Austin, Texas.</p><footer>4437 Supply Court, Bldg 4, <b>Austin</b>, TX 78744 &nbsp; 200 Queen Street West, Toronto, ON M5V 1Z4</footer>'), ['4437 Supply Court, Bldg 4, Austin , TX 78744', '200 Queen Street West, Toronto, ON M5V 1Z4'])
})
