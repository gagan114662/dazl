import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'

// Issue #197 (confirmed in production): a guessed (name_probe) domain of a same-name business in another state passed
// the homepage name check and its phones and people were attached to the lead. Fixture mirrors that case; no network.
const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>We have served the community for many years and we care about every family that walks through our doors every single day.</p>'
const ARTICLE = html('<h1>New dental practice opens on Greenpoint Avenue in Sunnyside</h1><p>Smile Avenue Dental has opened at 45-04 Greenpoint Ave in Sunnyside, offering state-of-the-art treatments.</p>')
const CA_HOME = html(`Smile Avenue Dental Group - Dentist in Pico Rivera, CA ${PROSE}<a href="/team">Team</a><a href="/contact">Contact</a>`)
const CA_TEAM = html(`${PROSE}<h3>Sophia Rozov</h3><p>Dentist</p>`)
const CA_CONTACT = html('<a href="tel:+15629040400">(562) 904-0400</a> <a href="mailto:info@smileavenuedental.com">info</a>')

async function run(homeBySite: Record<string, Record<string, string>>, icpWhere: string[], lead = { signal: 'Opened a new practice in Sunnyside', excerpt: 'Smile Avenue Dental has opened at 45-04 Greenpoint Ave in Sunnyside', article: ARTICLE }) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: icpWhere }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'Smile Avenue Dental', null, lead.signal, 'https://qns.example/smile-avenue-dental-sunnyside', lead.excerpt, 90, 85)
  const get: Get = async url => {
    const u = new URL(url)
    if (u.hostname === 'qns.example') return { status: 200, body: lead.article, finalUrl: url }
    const site = homeBySite[u.hostname.replace(/^www\./, '')]
    if (!site) return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    const b = site[u.pathname]
    return b !== undefined ? { status: 200, body: b, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-10-26T12:00:00Z') })
  return {
    domain: (db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as { company_domain: string | null }).company_domain,
    enr: db.prepare("SELECT kind, value, label FROM lead_enrichments WHERE kind <> 'domain' ORDER BY kind, value").all() as { kind: string; value: string; label: string }[],
    audit: (db.prepare("SELECT lookup, status FROM connector_audit WHERE connector = 'sitecrawl'").all() as { lookup: string; status: string }[]),
  }
}


// Contacts are attached only when the company's own site agrees with the place the request names (city-scoped for New York City / London).
// Same-name practices in another state or another UK city are refused, and a guessed domain must AGREE for a city request. INVENTED pages.
const NYC_OK = html(`Smile Avenue Dental, 45-04 Greenpoint Ave, Sunnyside, NY 11104 ${PROSE}<a href="/contact">Contact</a>`)
const CONTACT = html('<a href="mailto:hello@smileavenuedental.com">hello</a> <a href="tel:+17185550100">(718) 555-0100</a>')
const attached = (r: Awaited<ReturnType<typeof run>>) => r.enr.length > 0 || r.domain !== null

test('NYC request: the same-name practice in Rome, NY (a New York town, not the city) is not bound', async () => {
  const home = html(`Smile Avenue Dental, 12 Black River Blvd, Rome, NY 13440. Serving New York families. ${PROSE}<a href="/contact">Contact</a>`)
  const r = await run({ 'smileavenuedental.com': { '/': home, '/contact': CONTACT } }, ['New York City'])
  assert.equal(attached(r), false); assert.ok(r.audit.some(a => /^contact rejected: location mismatch/.test(a.status)), JSON.stringify(r.audit))
})
test('NYC request: Albany, NY and a Texas practice are refused even though the page says "New York" somewhere', async () => {
  for (const home of [html(`Smile Avenue Dental, Albany, NY 12207. We also welcome patients from New York City. ${PROSE}<a href="/contact">Contact</a>`), html(`Smile Avenue Dental of Dallas, TX. New York style care. ${PROSE}<a href="/contact">Contact</a>`)]) {
    const r = await run({ 'smileavenuedental.com': { '/': home, '/contact': CONTACT } }, ['New York City'])
    assert.equal(attached(r), false)
  }
})
test('NYC request: a guessed domain whose homepage only says "New York" (no city address) is refused as geo_unknown; the right NYC address binds', async () => {
  const vague = html(`Smile Avenue Dental - quality care across New York. ${PROSE}<a href="/contact">Contact</a>`)
  const r1 = await run({ 'smileavenuedental.com': { '/': vague, '/contact': CONTACT } }, ['New York City'])
  assert.equal(attached(r1), false); assert.ok(r1.audit.some(a => /^contact rejected: location unconfirmed/.test(a.status)), JSON.stringify(r1.audit))
  const r2 = await run({ 'smileavenuedental.com': { '/': NYC_OK, '/contact': CONTACT } }, ['New York City'])
  assert.equal(r2.domain, 'smileavenuedental.com'); assert.ok(r2.enr.length > 0)
})
test('London request: East London, South Africa and Manchester, England are refused; a London postcode address binds', async () => {
  const lead = { signal: 'Opened a new practice in London', excerpt: 'Smile Avenue Dental has opened a new practice in London offering treatments', article: html('<p>Smile Avenue Dental has opened a new practice in London offering treatments to local families today.</p>') }
  for (const home of [html(`Smile Avenue Dental, Oxford Rd, East London, South Africa. ${PROSE}<a href="/contact">Contact</a>`), html(`Smile Avenue Dental, 3 Deansgate, Manchester, England. Our London partners welcome you. ${PROSE}<a href="/contact">Contact</a>`)]) {
    const r = await run({ 'smileavenuedental.com': { '/': home, '/contact': CONTACT } }, ['London, UK'], lead)
    assert.equal(attached(r), false)
  }
  const ok = html(`Smile Avenue Dental, 1 Old Street, London EC1V 9HX. ${PROSE}<a href="/contact">Contact</a>`)
  const r = await run({ 'smileavenuedental.com': { '/': ok, '/contact': CONTACT } }, ['London, UK'], lead)
  assert.equal(r.domain, 'smileavenuedental.com')
})
test('a request with no place makes no place demand beyond the existing evidence check', async () => {
  const r = await run({ 'smileavenuedental.com': { '/': NYC_OK, '/contact': CONTACT } }, [])
  assert.ok(r.domain === 'smileavenuedental.com' || r.audit.some(a => /^contact rejected: location unconfirmed/.test(a.status) || /^contact rejected: location mismatch/.test(a.status)))
})

test('the crawl refusal reads like the others: "contact rejected: location mismatch Pico Rivera, CA vs New York, NY"', async () => {
  const home = html(`Smile Avenue Dental Group - Dentist in Pico Rivera, CA 90660. ${PROSE}<a href="/contact">Contact</a>`)
  const r = await run({ 'smileavenuedental.com': { '/': home, '/contact': CONTACT } }, ['New York City'])
  assert.equal(attached(r), false)
  assert.ok(r.audit.some(a => a.status === 'contact rejected: location mismatch Pico Rivera, CA vs New York, NY'), JSON.stringify(r.audit))
})
