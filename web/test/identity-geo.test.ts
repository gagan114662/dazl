import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, placeTerms, placeConsistent, type Get } from '../lib/connectors/sitecrawl.ts'

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

test('places come from the scan geography and the evidence; nothing fixed', () => {
  assert.deepEqual(placeTerms(['New York City'], 'New dental practice opens on Greenpoint Avenue in Sunnyside'), ['newyorkcity', 'newyork', 'greenpointavenue', 'sunnyside'])
  assert.deepEqual(placeTerms(['Lisboa, Portugal'], 'abre uma nova clínica em Alfama'), ['lisboaportugal', 'lisboa', 'portugal', 'alfama'])
  assert.deepEqual(placeTerms([], 'Acme is hiring'), [])
  assert.equal(placeConsistent('smileavenuedentalgroupdentistinpicoriveraca', ['newyork', 'sunnyside']), false)
  assert.equal(placeConsistent(undefined, ['sunnyside']), false)
})

test('#197: a same-name business in another state is NOT bound; no domain, no phones, no people', async () => {
  const r = await run({ 'smileavenuedental.com': { '/': CA_HOME, '/team': CA_TEAM, '/contact': CA_CONTACT } }, ['New York City'])
  assert.equal(r.domain, null)
  assert.deepEqual(r.enr, [])
  assert.ok(r.audit.some(a => a.lookup === 'smileavenuedental.com' && /^contact rejected: location mismatch/.test(a.status)), JSON.stringify(r.audit))
})

test('when the guessed domain IS the lead (homepage names its place) it binds, and every contact says the site was found by name search', async () => {
  const NY_HOME = html(`Smile Avenue Dental, 45-04 Greenpoint Ave, Sunnyside, NY 11104 ${PROSE}<a href="/contact">Contact</a>`)
  const r = await run({ 'smileavenuedental.com': { '/': NY_HOME, '/contact': html('<a href="mailto:hello@smileavenuedental.com">hello</a>') } }, ['New York City'])
  assert.equal(r.domain, 'smileavenuedental.com')
  assert.ok(r.enr.length > 0)
  for (const e of r.enr) assert.ok(e.label.includes('site found by name search and location match'), JSON.stringify(e))
})

test('no known place at all (no ICP geography, evidence names none): a guessed domain is refused as geo_unknown', async () => {
  const r = await run({ 'smileavenuedental.com': { '/': CA_HOME, '/contact': CA_CONTACT } }, [], { signal: 'Opened a new practice', excerpt: 'Smile Avenue Dental has opened a new practice offering treatments', article: html('<p>Smile Avenue Dental has opened a new practice offering treatments.</p>') })
  assert.equal(r.domain, null); assert.deepEqual(r.enr, [])
  assert.ok(r.audit.some(a => a.lookup === 'smileavenuedental.com' && /^contact rejected: no location to confirm/.test(a.status)), JSON.stringify(r.audit))
})
