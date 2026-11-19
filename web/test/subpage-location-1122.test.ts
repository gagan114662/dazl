import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'

// #1122 F1 (real 5-lead replay, job 8df272f3bf68d6bee36ea722): TapMango's homepage names the company but no city; its own
// about-us / leadership / careers pages say Toronto. The crawl fetched those pages and then judged location on the homepage only,
// so the domain was refused and the lead got no website. A positive location check now reads the company's own fetched pages too;
// a homepage that names ANOTHER place is still refused.
const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>Loyalty and online ordering for restaurants and retailers, built by a team that cares about small business owners everywhere.</p>'

async function crawl(sites: Record<string, Record<string, string>>, company = 'TapMango', domain = 'tapmango.com') {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: ['Toronto, Ontario'] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,review_reason) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('L1', job, company, null, 'Hiring an SDR in Toronto', 'https://board.example/jobs/sdr-1', `${company} is hiring an SDR in Toronto, Ontario`, 90, 85, null)
  const get: Get = async url => {
    const u = new URL(url); const host = u.hostname.replace(/^www\./, '')
    if (host === 'board.example') return { status: 200, body: html(`<p>${company} is hiring an SDR in Toronto.</p>`), finalUrl: url }
    const site = sites[host]; if (!site) return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    const b = site[u.pathname]
    return b !== undefined ? { status: 200, body: b, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-18T12:00:00Z'), redirectOf: async () => null, findSites: async () => [domain] })
  const lead = db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as { company_domain: string | null }
  const proof = db.prepare("SELECT source_url, label, retrieved_at FROM lead_enrichments WHERE lead_id = ? AND kind = 'domain_check'").get('L1') as { source_url: string; label: string; retrieved_at: number } | undefined
  db.close()
  return { domain: lead.company_domain, proof }
}

const run = async (sites: Record<string, Record<string, string>>) => (await crawl(sites)).domain

const HOME = html(`<h1>TapMango</h1>${PROSE}<a href="/about-us">About us</a>`)
const ABOUT = html('<h1>About TapMango</h1><p>TapMango is headquartered in Toronto, Ontario, Canada.</p>')

test('#1122 F1: homepage names no place, the company\'s own about page says Toronto: the domain is kept', async () => {
  assert.equal(await run({ 'tapmango.com': { '/': HOME, '/about-us': ABOUT } }), 'tapmango.com')
})

test('#1122 F1 control: no first-party page names the place: still no domain', async () => {
  assert.equal(await run({ 'tapmango.com': { '/': HOME, '/about-us': html('<p>About TapMango. We love loyalty.</p>') } }), null)
})

test('#1122 F1 guard: a homepage naming ANOTHER place is still refused, even if a subpage mentions Toronto', async () => {
  const home = html(`<h1>TapMango</h1><p>Visit us at 8500 Whittier Blvd, Pico Rivera, CA 90660.</p>${PROSE}<a href="/about-us">About us</a>`)
  assert.equal(await run({ 'tapmango.com': { '/': home, '/about-us': ABOUT } }), null)
})

for (const claim of [
  'Our customer Maple Bakery in Toronto, Ontario recommends TapMango.',
  'Maple Bakery is headquartered in Toronto, Ontario, Canada.',
  'We serve customers in Toronto, Ontario, Canada.',
]) {
  test(`#1122 a third-party or service-area mention cannot confirm the website: ${claim}`, async () => {
    const result = await crawl({ 'tapmango.com': { '/': HOME, '/about-us': html(`<h1>About TapMango</h1><p>${claim}</p>`) } })
    assert.equal(result.domain, null)
    assert.equal(result.proof, undefined)
  })
}

test('#1122 an explicitly company-bound location retains the exact proof page', async () => {
  const result = await crawl({ 'tapmango.com': { '/': HOME, '/about-us': ABOUT } })
  assert.equal(result.domain, 'tapmango.com')
  assert.equal(result.proof?.source_url, 'https://tapmango.com/about-us')
  assert.match(result.proof?.label ?? '', /headquartered in Toronto/)
  assert.equal(result.proof?.retrieved_at, Date.parse('2026-11-18T12:00:00Z') / 1000)
})

test('#1122 a Toronto office on a first-party contact page survives a separately listed US office', async () => {
  const home = html(`<h1>TapMango</h1>${PROSE}<a href="/contact">Contact</a>`)
  const contact = html('<h1>Contact TapMango</h1><h2>Where We Are</h2><h3>Atlanta</h3><p>245 North Highland Ave, Atlanta, GA 30307-1912, United States</p><h3>Toronto</h3><p>5775 Yonge St, Suite 1801, Toronto, Ontario M2M 4J1, Canada</p><h2>Support</h2>')
  const result = await crawl({ 'tapmango.com': { '/': home, '/contact': contact } })
  assert.equal(result.domain, 'tapmango.com')
  assert.equal(result.proof?.source_url, 'https://tapmango.com/contact')
  assert.match(result.proof?.label ?? '', /Toronto/)
})

test('#1122 a company-named location entry is evaluated independently of other offices', async () => {
  const home = html('<h1>Burson</h1><a href="/locations">Locations</a>')
  const locations = html('<h1>Locations</h1><h4>Burson Atlanta</h4><p>150 Spring Street, Atlanta, GA 30303</p><h4>Burson Toronto</h4><p>155 Queens Quay E, Toronto, Canada, M5A 0W4</p><h4>Burson Ottawa</h4><p>45 O’Connor, Ottawa, Canada, K1P 1A4</p>')
  const result = await crawl({ 'bursonglobal.com': { '/': home, '/contact': html('Contact us'), '/contact-us': html('Get in touch'), '/about': html('About Burson'), '/team': html('Our team'), '/locations': locations } }, 'Burson', 'bursonglobal.com')
  assert.equal(result.domain, 'bursonglobal.com')
  assert.equal(result.proof?.source_url, 'https://bursonglobal.com/locations')
  assert.match(result.proof?.label ?? '', /Toronto/)
})


test('#1122 an unrelated company name cannot qualify as a city heading in an office directory', async () => {
  const contact = html('<h1>Contact TapMango</h1><h2>Where We Are</h2><h3>Maple Bakery Toronto</h3><p>5775 Yonge St, Toronto, Ontario M2M 4J1, Canada</p>')
  const result = await crawl({ 'tapmango.com': { '/': HOME, '/contact': contact } })
  assert.equal(result.domain, null)
  assert.equal(result.proof, undefined)
})

test('#1122 a quoted first-person claim is not the company’s office', async () => {
  const contact = html('<h1>About TapMango</h1><blockquote><p>Our office is in Toronto, Ontario, Canada.</p></blockquote>')
  const result = await crawl({ 'tapmango.com': { '/': HOME, '/about-us': contact } })
  assert.equal(result.domain, null)
  assert.equal(result.proof, undefined)
})

test('#1122 a first-party statement names the remote company’s home base', async () => {
  const location = html('<h1>About TapMango</h1><p>We are remote-first with a Toronto home base. Explore open roles.</p>')
  const result = await crawl({ 'tapmango.com': { '/': HOME, '/about-us': location } })
  assert.equal(result.domain, 'tapmango.com')
  assert.equal(result.proof?.source_url, 'https://tapmango.com/about-us')
  assert.match(result.proof?.label ?? '', /Toronto home base/)
})

test('#1122 a company footer confirms a separately listed Toronto office beside US offices', async () => {
  const home = html(`<h1>Trevant</h1>${PROSE}<footer><p>Corporate HQ</p><p>Kansas City</p><p>5440 West 110th Street, Overland Park, KS 66211</p><p>New York</p><p>300 Vesey St, New York, NY 10282</p><p>Toronto</p><p>320 Bay St. Toronto, Ontario, M5H 4A6</p></footer>`)
  const result = await crawl({ 'trevant.com': { '/': home } }, 'Trevant', 'trevant.com')
  assert.equal(result.domain, 'trevant.com')
  assert.match(result.proof?.label ?? '', /320 Bay St.*Toronto/)
})

test('#1122 a homepage/footer customer address cannot establish the company’s Toronto location', async () => {
  const home = html(`<h1>Trevant</h1><p>Our headquarters are in Kansas City, KS 66211.</p><footer><h2>Customer story</h2><p>Maple Bakery</p><p>320 Bay St. Toronto, Ontario, M5H 4A6</p></footer>`)
  const result = await crawl({ 'trevant.com': { '/': home } }, 'Trevant', 'trevant.com')
  assert.equal(result.domain, null)
})

for (const section of ['Customers', 'Clients', 'Partners', 'Testimonials', 'Service areas', 'Customer story']) {
  test(`#1122 a footer ${section} section ends the corporate office list`, async () => {
    const home = html(`<h1>Northstar Design</h1>${PROSE}<footer><h2>Corporate HQ</h2><h3>Raleigh</h3><p>100 Fayetteville St, Raleigh, NC 27601</p><h2>${section}</h2><h3>Toronto</h3><p>320 Bay St. Toronto, Ontario, M5H 4A6</p></footer>`)
    const result = await crawl({ 'northstar-design.example': { '/': home } }, 'Northstar Design', 'northstar-design.example')
    assert.equal(result.domain, null)
    assert.equal(result.proof, undefined)
  })
}

test('#1122 company careers can confirm a market separately from an out-of-market HQ', async () => {
  const home = html(`<h1>Levitate</h1><p>Our headquarters are in Raleigh, NC 27601.</p><a href="/careers">Careers</a>`)
  const careers = (employer: string) => html(`<h1>Careers at Levitate</h1><h3>Raleigh, NC</h3><a href="https://job-boards.greenhouse.io/levitate/jobs/7777777">Accounts</a><h3>Toronto, ON</h3><a href="https://job-boards.greenhouse.io/${employer}/jobs/5209244008">Sales Development Representative</a>`)
  const result = await crawl({ 'levitate.ai': { '/': home, '/careers': careers('levitate') } }, 'Levitate', 'levitate.ai')
  assert.equal(result.domain, 'levitate.ai')
  assert.equal(result.proof?.source_url, 'https://levitate.ai/careers')
  const wrongEmployer = await crawl({ 'levitate.ai': { '/': home, '/careers': careers('differentcompany') } }, 'Levitate', 'levitate.ai')
  assert.equal(wrongEmployer.domain, null)
})
