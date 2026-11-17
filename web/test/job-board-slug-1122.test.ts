import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import * as sc from '../lib/connectors/sitecrawl.ts'
import * as fsf from '../lib/connectors/free-site-finder.ts'

// #1122 / #1037: the live prod run of 2026-11-16 (prod 10e3dc3e, job 6b7e54aaf53b67fc7e874115, "Small marketing and creative agencies in
// Toronto, Ontario hiring an SDR") kept one lead, War Room, held for review, with no company website and "No buyer named yet". Its source was
// an aggregator posting whose page links no company site, only the employer's Rippling posting. Shapes below are from that real page.
const SRC = 'https://growthroles.com/jobs/war-room-business-development-representative-torontoremote-toronto-7d65eab6263dde76'
const ATS = 'https://ats.rippling.com/war-room-careers/jobs/3d46c27a-6efa-4505-b2b4-790d52ce4ee7'
const html = (b: string) => `<html><body>${b}</body></html>`
const GROWTHROLES = html(`<a href="/">Jobs</a><a href="/companies/war-room">War Room</a><h1>Business Development Representative - Toronto/Remote</h1>
<p>War Room is looking for a Business Development Representative (BDR) to join our growing team!</p>
<a href="${ATS}">Apply</a><a href="https://ats.rippling.com/other-agency-careers/jobs/1">Other job</a>
<a href="/jobs/citylitics-business-development-representative-toronto-d141a5f3a1d98032">Citylitics</a>
<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Business Development Representative - Toronto/Remote', hiringOrganization: { '@type': 'Organization', name: 'War Room', logo: 'https://growthroles.com/logos/war-room.webp' } })}</script>`)
const PROSE = '<p>We are a highly specialized programmatic advertising agency and we focus all of our efforts on digital media buying for clients.</p>'
const HOME = html(`<h1>War Room</h1><p>Visit us at 156 Front Street West, Toronto, ON M5J 2L6.</p>${PROSE}<a href="/contact">Contact</a>`)

test('#1122 the real aggregator URL + its ATS link give the employer slug; another employer\'s ATS link on the page is never used', () => {
  const b = sc.jobBoardSlugs('War Room', SRC, GROWTHROLES)
  assert.equal(b.slug, 'war-room-careers')
  assert.deepEqual(b.ats, [ATS])
  assert.deepEqual(sc.slugDomains(b.slug, ['Toronto, Ontario']), ['warroom.com', 'warroom.ca', 'warroominc.com', 'warroomhq.com'])
  // no ATS link: the aggregator's own /jobs/<company>-... path still gives the slug
  assert.equal(sc.jobBoardSlugs('War Room', SRC, '').slug, 'war-room')
  // a page about another company gives nothing for this one
  assert.deepEqual(sc.jobBoardSlugs('Citylitics', SRC, GROWTHROLES), { slug: '', ats: [] })
  assert.deepEqual(sc.slugDomains('ab'), [])
})

async function crawlWarRoom(reviewReason: string | null, sites: Record<string, Record<string, string>>, atsBody = html('<p>War Room careers</p>')) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: ['Toronto, Ontario'] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,review_reason) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'War Room', null, 'Hiring a Business Development Representative in Toronto', SRC, 'War Room is looking for a Business Development Representative (BDR) in Toronto, Ontario', reviewReason === null ? 90 : null, 70, reviewReason)
  const fetched: string[] = []
  const get: sc.Get = async url => {
    const u = new URL(url); const host = u.hostname.replace(/^www\./, ''); fetched.push(host + u.pathname)
    if (url === SRC) return { status: 200, body: GROWTHROLES, finalUrl: url }
    if (url === ATS) return { status: 200, body: atsBody, finalUrl: url }
    const site = sites[host]
    if (!site) return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    const b = site[u.pathname]
    return b !== undefined ? { status: 200, body: b, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  await sc.crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-16T12:00:00Z'), redirectOf: async () => null })
  const domain = (db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as { company_domain: string | null }).company_domain
  const src = (db.prepare("SELECT source_url FROM lead_enrichments WHERE lead_id = ? AND connector = 'sitecrawl' AND kind = 'domain'").get('L1') as { source_url: string } | undefined)?.source_url ?? null
  return { domain, fetched, src }
}

test('#1122 #1037 a HELD War Room lead (needs review: no sales-hiring evidence) still gets its company domain from the job-board slug', async () => {
  const r = await crawlWarRoom('no_sales_hiring_evidence', { 'warroominc.com': { '/': HOME, '/contact': html('Email: hello@warroominc.com') } })
  assert.equal(r.domain, 'warroominc.com')
  assert.ok(r.fetched.includes('ats.rippling.com/war-room-careers/jobs/3d46c27a-6efa-4505-b2b4-790d52ce4ee7'), 'the employer\'s ATS posting is read once')
  assert.ok(!r.fetched.some(f => f.startsWith('ats.rippling.com/other-agency')), 'another employer\'s posting is never read')
})

test('#1122 the ATS posting that links the company site gives it, ahead of the guesses', async () => {
  const r = await crawlWarRoom('source_review_required', { 'wearewarroom.com': { '/': HOME } }, html('<a href="https://wearewarroom.com/">War Room website</a>'))
  assert.equal(r.domain, 'wearewarroom.com')
  // 1328-F1: the domain's provenance is the ATS page that linked it, not the aggregator page (which never linked this site)
  assert.equal(r.src, ATS)
})

test('1328-F1 control: a site the original page links itself keeps the original page as its provenance', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: ['Toronto, Ontario'] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,review_reason) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'War Room', null, 'Hiring a Business Development Representative in Toronto', SRC, 'War Room is looking for a Business Development Representative (BDR) in Toronto, Ontario', null, 70, 'source_review_required')
  const page = html('<h1>War Room</h1><a href="https://wearewarroom.com/">War Room website</a>')
  const get: sc.Get = async url => {
    const u = new URL(url)
    if (url === SRC) return { status: 200, body: page, finalUrl: url }
    if (u.hostname.replace(/^www\./, '') !== 'wearewarroom.com') return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    return u.pathname === '/' ? { status: 200, body: HOME, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  await sc.crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-16T12:00:00Z'), redirectOf: async () => null })
  assert.equal((db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as { company_domain: string | null }).company_domain, 'wearewarroom.com')
  assert.equal((db.prepare("SELECT source_url FROM lead_enrichments WHERE lead_id = ? AND connector = 'sitecrawl' AND kind = 'domain'").get('L1') as { source_url: string }).source_url, SRC)
})

test('#1122 a slug domain whose homepage names another business is refused (the identity check is unchanged)', async () => {
  const r = await crawlWarRoom(null, { 'warroom.com': { '/': html(`<h1>The War Room Steakhouse</h1><p>8500 Whittier Blvd, Pico Rivera, CA 90660</p>${PROSE}`) } })
  assert.equal(r.domain, null)
})

test('#1122 #1037 the free web search: parses DuckDuckGo HTML results and runs only when Wikidata and OpenStreetMap placed nothing', async () => {
  const ddg = html(`<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwarroominc.com%2F&amp;rut=x">War Room | Programmatic Agency</a>
<a class="result__a" href="https://www.linkedin.com/company/war-room-inc">War Room - LinkedIn</a>`)
  assert.deepEqual(fsf.parseDuckDuckGoHtml(ddg), ['https://warroominc.com/', 'https://www.linkedin.com/company/war-room-inc'])
  const asked: string[] = []
  const fetchImpl = (async (url: string) => { asked.push(new URL(url).hostname); return new URL(url).hostname === 'html.duckduckgo.com' ? new Response(ddg, { status: 200 }) : new Response('x', { status: 500 }) }) as unknown as typeof fetch
  fsf.resetFreeSiteFinderPacing()
  const r = await fsf.freeCompanySitesDetailed('War Room', ['Toronto, Ontario'], { fetchImpl, sleep: async () => {}, now: () => 1e12, webSearch: true })
  assert.equal(r.outcomes.websearch, 'ok')
  assert.deepEqual(r.hits.map(h => h.url), ['https://warroominc.com/', 'https://www.linkedin.com/company/war-room-inc'])
  assert.deepEqual(sc.companyHostsFromSearch('War Room', r.hits, 3, ['Toronto, Ontario']), ['warroominc.com'], 'only a host carrying the name survives')
  const off = await fsf.freeCompanySitesDetailed('War Room', [], { fetchImpl, sleep: async () => {}, now: () => 2e12 })
  assert.equal(off.outcomes.websearch, undefined)
})
