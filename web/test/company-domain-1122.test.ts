import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import * as sc from '../lib/connectors/sitecrawl.ts'   // helpers by namespace: on main they do not exist, and each test then fails on its own behaviour, not at import
import { domainUnresolvedText } from '../lib/connectors/domain-unresolved.ts'

// #1122: a lead found on a third-party page (job board, news site, social page) got no company website, so no person or email could be
// found for it. The web search for the company's own site is #1036 / #1217 (`findSites`, tested in find-site-by-search-1036.test.ts);
// this file covers what #1122 adds around it: a site named in the cited page's structured data, the request country's TLD among the name
// guesses, following a name-built domain that only forwards to the real site, and a named reason on every lead left without a website.
// Shapes are from the real local matrix scans of 2026-11-14 and the review at 01140156 (Queen Street Dental Centre, HD Roofing & Repairs,
// TADCO). The crawl runs for real (crawlJob); only the network is a table of pages.
const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>We have cared for families in our neighbourhood for many years and we welcome every new patient who walks through our doors.</p>'
const TORONTO_HOME = (name: string) => html(`<h1>${name}</h1><p>Visit us at 200 Bloor Street West, Toronto, ON M5S 1T8.</p>${PROSE}<a href="/contact">Contact</a>`)
const ELSEWHERE_HOME = (name: string) => html(`<h1>${name}</h1><p>Visit us at 8500 Whittier Blvd, Pico Rivera, CA 90660.</p>${PROSE}<a href="/contact">Contact</a>`)
const CONTACT = (email: string) => html(`Email: ${email}`)
const T = 'domain-unresolved-v1:'

type Lead = { id: string; company: string; reviewReason?: string | null; evidenceUrl?: string }
async function run(o: { company: string; evidenceUrl: string; evidence: string; sites: Record<string, Record<string, string>>; where?: string[]; findSites?: (company: string, where: string[]) => Promise<string[]>; redirects?: Record<string, string>; excerpt?: string; reviewReason?: string | null; more?: Lead[]; robots?: Record<string, string> }) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: o.where ?? ['Toronto, Ontario'] }), job)
  const ins = db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,review_reason) VALUES (?,?,?,?,?,?,?,?,?,?)')
  ins.run('L1', job, o.company, null, 'Hiring a dental receptionist in Toronto', o.evidenceUrl, o.excerpt ?? `${o.company} is hiring a dental receptionist in Toronto, Ontario`, o.reviewReason == null ? 90 : null, 85, o.reviewReason ?? null)
  for (const m of o.more ?? []) ins.run(m.id, job, m.company, null, 'Hiring in Toronto', m.evidenceUrl ?? o.evidenceUrl, `${m.company} is hiring in Toronto, Ontario`, m.reviewReason == null ? 90 : null, 80, m.reviewReason ?? null)
  const evHost = new URL(o.evidenceUrl).hostname
  const fetched: string[] = []
  const get: Get = async url => {
    const u = new URL(url); const host = u.hostname.replace(/^www\./, ''); fetched.push(host + u.pathname)
    if (u.hostname === evHost) return { status: 200, body: o.evidence, finalUrl: url }
    const site = o.sites[host]
    if (!site) return null
    if (u.pathname === '/robots.txt') return { status: 200, body: o.robots?.[host] ?? 'User-agent: *\nAllow: /', finalUrl: url }
    const b = site[u.pathname]
    return b !== undefined ? { status: 200, body: b, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  const searched: string[] = [], asked: string[] = []
  const findSites = o.findSites ? async (c: string, w: string[]) => { searched.push(c); return o.findSites!(c, w) } : undefined
  const redirectOf = async (host: string) => { asked.push(host); return o.redirects?.[host] ?? null }
  const crawl = (extra: Record<string, unknown> = {}) => crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-14T12:00:00Z'), redirectOf, ...(findSites ? { findSites } : {}), ...extra })
  await crawl()
  const lead = (id: string) => ({
    domain: (db.prepare('SELECT company_domain FROM leads WHERE id = ?').get(id) as { company_domain: string | null }).company_domain,
    basis: (db.prepare("SELECT value FROM lead_enrichments WHERE lead_id = ? AND kind = 'domain'").all(id) as { value: string }[]).map(r => r.value),
    emails: (db.prepare("SELECT value FROM lead_enrichments WHERE lead_id = ? AND kind = 'email'").all(id) as { value: string }[]).map(r => r.value),
    unresolved: (db.prepare("SELECT value, label, source_url FROM lead_enrichments WHERE lead_id = ? AND kind = 'domain_unresolved'").all(id) as { value: string; label: string; source_url: string }[]),
  })
  return { ...lead('L1'), lead, searched, asked, fetched, crawl, db, job, audit: db.prepare("SELECT lookup, status FROM connector_audit WHERE connector = 'sitecrawl'").all() as { lookup: string; status: string }[] }
}
const NOTHING = (r: { domain: string | null; basis: string[]; emails: string[] }) => assert.deepEqual({ domain: r.domain, basis: r.basis, emails: r.emails }, { domain: null, basis: [], emails: [] })
const why = (r: { unresolved: { label: string }[] }) => r.unresolved.map(u => u.label.replace(T, ''))

const BOARD = 'https://tempstars.example/jobs/dental-receptionist-toronto-4411'
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`
const boardPage = (o: unknown) => html(`<h1>Dental receptionist</h1><p>Restor Dental is hiring in Toronto.</p>${ld(o)}`)
const plain = (company: string) => html(`<p>${company} is hiring in Toronto.</p>`)

// ---------- structured data on the cited page ----------
test('#1122 a job board page that names the company site only in its JobPosting structured data: the site is read, confirmed and bound', async () => {
  const r = await run({ company: 'Restor Dental', evidenceUrl: BOARD, evidence: boardPage({ '@type': 'JobPosting', title: 'Dental receptionist', hiringOrganization: { '@type': 'Organization', name: 'Restor Dental', sameAs: 'https://www.smilesbyrestor.ca/' } }),
    sites: { 'smilesbyrestor.ca': { '/': TORONTO_HOME('Restor Dental'), '/contact': CONTACT('hello@smilesbyrestor.ca') } } })
  assert.equal(r.domain, 'smilesbyrestor.ca')
  assert.deepEqual(r.basis, ['smilesbyrestor.ca|evidence_link_text'], 'recorded as named by the cited page, never as verified ownership')
  assert.deepEqual(r.emails, ['hello@smilesbyrestor.ca']); assert.deepEqual(r.unresolved, [])
})

test('#1122 structured data: only an organisation node named as this company counts - never the posting\'s own url, the board, a platform or government host, a shorter name inside ours; the walk is bounded and linear', () => {
  const sites = (company: string, o: unknown, host = 'tempstars.example') => sc.jsonLdCompanySites(company, boardPage(o), host)
  assert.deepEqual(sites('Restor Dental', [{ '@type': 'Organization', name: 'TempStars', url: 'https://tempstars-corporate.example/' }, { '@type': 'JobPosting', hiringOrganization: { name: 'Restor Dental Inc.', url: 'https://tempstars.example/employers/restor', sameAs: ['https://www.facebook.com/restordental', 'https://restordental.example/'] } }]), ['restordental.example'])
  assert.deepEqual(sites('Restor Dental', { '@type': 'JobPosting', name: 'Hygienist at Restor Dental Toronto', url: 'https://www.localnews-mirror.example/story', hiringOrganization: { '@type': 'Organization', name: 'Restor Dental', sameAs: 'https://jobs.lever.co/restor' } }), [], 'the posting\'s url is not the employer\'s site; an applicant-tracking host is a platform')
  assert.deepEqual(sites('Restor Dental', { '@type': 'NewsArticle', name: 'Restor Dental opens', url: 'https://news.example/restor' }), [])
  assert.deepEqual(sites('Restor Dental', { '@type': ['LocalBusiness', 'Dentist'], name: 'Restor Dental', url: 'https://restordental.example/' }), ['restordental.example'])
  assert.deepEqual(sites('Restor Dental', { name: 'Another Clinic', url: 'https://another.example/' }), [])
  assert.deepEqual(sites('Canada Goose', { '@type': 'Organization', name: 'Canada', url: 'https://www.canada.ca/' }), [])
  assert.deepEqual(sites('Acme Robotics', { name: 'Acme Robotics', url: 'https://health.gov/acme', sameAs: [7, null, { x: 1 }, 'https://user:pw@acme-robotics.example:8443/about'] }), ['acme-robotics.example'])
  assert.deepEqual(sites('Acme Robotics', { name: 'Acme Robotics', list: Array(300_000).fill(0), url: 'https://acme-robotics.example/' }), ['acme-robotics.example'])
  assert.deepEqual(sites('Acme Robotics', Array(300_000).fill({ name: 'x' })), [], 'bounded walk')
  assert.deepEqual(sc.jsonLdCompanySites('Restor Dental', '<script type="application/ld+json">{not json</script>'), [])
  const hostile = '<script type="application/ld+json" '.repeat(18_000)   // ~650 KB of unclosed tags, under the crawl's page cap
  const t0 = Date.now(); assert.deepEqual(sc.ldJsonBlocks(hostile), []); assert.deepEqual(sc.jsonLdCompanySites('Restor Dental', hostile), []); assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`)
  assert.deepEqual(sc.ldJsonBlocks('<SCRIPT type="application/ld+json">{"a":1}</SCRIPT><script>x</script><script type=\'application/ld+json\'>[2]</script>'), ['{"a":1}', '[2]'])
})

test('#1122 a site named only in structured data is a candidate, not "the linked site": when it is refused, the web search and the name guesses still run; a listing host there is dropped', async () => {
  const other = boardPage({ '@type': 'JobPosting', hiringOrganization: { '@type': 'Organization', name: 'Restor Dental', sameAs: 'https://restor-group.example/' } })
  const a = await run({ company: 'Restor Dental', evidenceUrl: BOARD, evidence: other, findSites: async () => [], sites: { 'restor-group.example': { '/': ELSEWHERE_HOME('Restor Dental') }, 'restordental.ca': { '/': TORONTO_HOME('Restor Dental'), '/contact': CONTACT('info@restordental.ca') } } })
  assert.equal(a.domain, 'restordental.ca', 'the structured-data host was read and refused; the guess still bound the right site')
  assert.deepEqual(a.searched, ['Restor Dental'], 'and the search step still ran')
  const zip = boardPage({ '@type': 'JobPosting', hiringOrganization: { '@type': 'Organization', name: 'Restor Dental', sameAs: 'https://www.ziprecruiter.com/co/Restor-Dental' } })
  const b = await run({ company: 'Restor Dental', evidenceUrl: BOARD, evidence: zip, sites: { 'restordental.ca': { '/': TORONTO_HOME('Restor Dental'), '/contact': CONTACT('info@restordental.ca') } } })
  assert.equal(b.domain, 'restordental.ca'); assert.ok(!b.fetched.some(f => f.startsWith('ziprecruiter.com')))
})

// ---------- the request country's TLD ----------
test('#1122 a Canadian request also guesses the .ca site built from the name: confirmed by name AND place, recorded as a guess; country detection has no US false positives', async () => {
  const tlds = (w: string) => sc.countryTlds([w])
  for (const w of ['Toronto, Ontario', 'Toronto, ON', 'Vancouver, BC', 'Québec', 'Calgary, Alberta', 'Canada']) assert.deepEqual(tlds(w), ['ca'], w)
  for (const w of ['New England', 'New Brunswick, New Jersey', 'Ontario, California', 'Ontario, CA', 'Austin, Texas', 'Indiana', 'Victoria', 'Georgia', 'come on, try it']) assert.deepEqual(tlds(w), [], w)
  assert.deepEqual(tlds('Northern Ireland'), ['co.uk', 'uk'], 'not the Republic\'s TLD'); assert.deepEqual(tlds('Dublin, Ireland'), ['ie']); assert.deepEqual(tlds('London, UK'), ['co.uk', 'uk'])
  assert.deepEqual(sc.probeDomains('Restor Dental', ['Toronto, Ontario']).slice(0, 2), ['restordental.com', 'restordental.ca'])
  assert.deepEqual(sc.probeDomains('Restor Dental'), ['restordental.com', 'restordental.ai', 'restordental.io', 'restordental.co'], 'no geography: the guesses main already made')
  const r = await run({ company: 'Restor Dental', evidenceUrl: BOARD, evidence: plain('Restor Dental'), sites: { 'restordental.ca': { '/': TORONTO_HOME('Restor Dental'), '/contact': CONTACT('info@restordental.ca') } } })
  assert.equal(r.domain, 'restordental.ca'); assert.deepEqual(r.basis, ['restordental.ca|name_probe'])
})

// ---------- a name-built domain that only forwards to the real site ----------
test('#1122 the real Queen Street Dental Centre case: queenstreetdentalcentre.ca only forwards to another host - the target is read under the same checks and bound as a guess', async () => {
  const r = await run({ company: 'Queen Street Dental Centre', evidenceUrl: 'https://ca.linkedin.example/jobs/view/1', evidence: plain('Queen Street Dental Centre'), redirects: { 'queenstreetdentalcentre.ca': 'qsdc.example' },
    sites: { 'qsdc.example': { '/': TORONTO_HOME('Queen Street Dental Centre'), '/contact': CONTACT('info@qsdc.example') } } })
  assert.equal(r.domain, 'qsdc.example')
  assert.deepEqual(r.basis, ['qsdc.example|name_probe'], 'a guess: never "linked from the source"')
  assert.deepEqual(r.emails, ['info@qsdc.example']); assert.deepEqual(r.unresolved, [])
  assert.ok(r.audit.some(a => a.lookup === 'queenstreetdentalcentre.ca' && a.status === 'redirects_to qsdc.example'), JSON.stringify(r.audit))
})

test('#1122 a forwarding target is never trusted for being the target: it must name the company and stand in the right place; a platform, network or government target is never read; at most two are followed', async () => {
  const base = { company: 'Queen Street Dental Centre', evidenceUrl: 'https://ca.linkedin.example/jobs/view/1', evidence: plain('Queen Street Dental Centre') }
  const parked = await run({ ...base, redirects: { 'queenstreetdentalcentre.com': 'qsdc.example' }, sites: { 'qsdc.example': { '/': html(`<h1>This domain is for sale</h1><p>Toronto, ON</p>${PROSE}`) } } })
  NOTHING(parked); assert.deepEqual(why(parked), ['not_confirmed'])
  // council (blocker): the company-named domain was sold and forwards to a chain's portal that LISTS the company and its Toronto address. The
  // portal's own name is not the company's, so it is never read, let alone bound (the real queenstreetdentalcentre.com forwards to 123dentist.com)
  const portal = await run({ ...base, redirects: { 'queenstreetdentalcentre.com': '123dentist.example', 'queenstreetdentalcentre.ca': 'toronto-dental-directory.example' },
    sites: { '123dentist.example': { '/': html(`<h1>123Dentist</h1><p>Queen Street Dental Centre - 200 Bloor Street West, Toronto, ON M5S 1T8</p><p>Yonge Smiles - Toronto</p>${PROSE}<a href="/contact">Contact</a>`), '/contact': CONTACT('info@123dentist.example') }, 'toronto-dental-directory.example': { '/': TORONTO_HOME('Queen Street Dental Centre') } } })
  NOTHING(portal); assert.ok(!portal.fetched.some(f => /123dentist|directory/.test(f)), JSON.stringify(portal.fetched)); assert.ok(!portal.audit.some(a => a.status.startsWith('redirects_to')))
  for (const [t, ok] of [['qsdc.ca', true], ['queenstreetdental.ca', true], ['getqueenstreetdentalcentre.com', true], ['123dentist.com', false], ['qsd.ca', false], ['qsdcdental.ca', false], ['dentalportal.example', false], ['10.0.0.1', false]] as [string, boolean][]) assert.equal(sc.redirectTargetIsCompanys(t, 'Queen Street Dental Centre', ['Toronto, Ontario']), ok, t)
  const elsewhere = await run({ ...base, redirects: { 'queenstreetdentalcentre.com': 'qsdc.example' }, sites: { 'qsdc.example': { '/': ELSEWHERE_HOME('Queen Street Dental Centre'), '/contact': CONTACT('info@qsdc.example') } } })
  NOTHING(elsewhere); assert.ok(elsewhere.audit.some(a => a.lookup === 'qsdc.example' && /location mismatch/.test(a.status)), JSON.stringify(elsewhere.audit))
  for (const target of ['facebook.com', 'linktr.ee', 'ontario.gov.on.ca', 'wixsite.com']) {
    const p = await run({ ...base, redirects: { 'queenstreetdentalcentre.com': target }, sites: { [target]: { '/': TORONTO_HOME('Queen Street Dental Centre') } } })
    NOTHING(p); assert.ok(!p.fetched.some(f => f.startsWith(target)), `${target} is never read as the company's site`)
  }
  const many = await run({ ...base, redirects: { 'queenstreetdentalcentre.com': 'qsdc.example', 'queenstreetdentalcentre.ca': 'qsdc.test', 'queenstreetdentalcentre.ai': 'queenstreetdental.example', 'queenstreetdentalcentre.io': 'queenstreetdental.test', 'qsdc.example': 'queenstreetdentalcentre.example' }, sites: {} })
  assert.equal(many.audit.filter(a => a.status.startsWith('redirects_to ')).length, 2, 'at most two forwarding targets per lead')
  assert.ok(many.asked.length <= 3, `at most three lookups per lead, asked ${many.asked.length}`); assert.ok(!many.asked.includes('qsdc.example'), 'a forwarding target is never followed further (no chains)')
  // a site linked by the page itself is never chased through a redirect, and without a redirect a dead guess is just dead
  const none = await run({ ...base, sites: {} }); NOTHING(none); assert.deepEqual(why(none), ['not_confirmed'])
})

// ---------- a named reason on every lead left without a website ----------
test('#1122 each outcome says what happened, in words that claim no more than the crawl knows', async () => {
  const base = { company: 'TDot Dental', evidenceUrl: BOARD, evidence: plain('TDot Dental'), sites: {} }
  const guessed = await run({ ...base, findSites: async () => ['tdot-dental.example'] })
  assert.deepEqual(guessed.unresolved, [{ value: 'No company website confirmed', label: `${T}not_confirmed`, source_url: BOARD }], 'searched and guessed sites tried, none confirmed')
  assert.deepEqual(why(await run({ ...base, company: 'Abc' })), ['no_site_linked'], 'a name too short to build or search a site from')
  const linked = await run({ company: 'Restor Dental', evidenceUrl: BOARD, evidence: html('<p><a href="https://restor-dental-ca.example/">Restor Dental</a> is hiring at 200 Bloor Street West, Toronto.</p>'), excerpt: 'Restor Dental is hiring at 200 Bloor Street West, Toronto',
    findSites: async () => ['restordental.ca'], sites: { 'restor-dental-ca.example': { '/': ELSEWHERE_HOME('Restor Dental') }, 'restordental.ca': { '/': TORONTO_HOME('Restor Dental') } } })
  NOTHING(linked); assert.deepEqual(linked.searched, [], 'a site the page itself links and that is refused ends it there: no search, no guess overrides the refusal'); assert.deepEqual(why(linked), ['linked_site_not_confirmed'])
  const robots = await run({ ...base, company: 'Blocked Dental', evidence: plain('Blocked Dental'), robots: { 'blockeddental.com': 'User-agent: *\nDisallow: /' }, sites: { 'blockeddental.com': { '/': TORONTO_HOME('Blocked Dental') } } })
  NOTHING(robots); assert.deepEqual(why(robots), ['site_not_readable'])
  for (const c of ['no_site_linked', 'linked_site_not_confirmed', 'not_confirmed', 'own_site_refused_reading', 'own_site_needs_javascript', 'probe_limit_reached', 'time_budget', 'site_not_readable', 'site_not_read', 'not_checked']) {
    assert.doesNotMatch(domainUnresolvedText(T + c), /[_[\]]|search|listing/, c); assert.notEqual(domainUnresolvedText(T + c), 'the company website could not be confirmed', c)
  }
  assert.equal(domainUnresolvedText(null), 'the company website could not be confirmed'); assert.equal(domainUnresolvedText(`${T}own_site_refused_reading`), 'the company\'s own website did not allow automated reading')
})

test('#1122 the real HD Roofing & Repairs case: the lead\'s source page is on the company\'s own domain and blocked us - no web search is spent on it and the reason says the company\'s own site refused reading', async () => {
  const r = await run({ company: 'HD Roofing & Repairs', where: ['Austin, Texas'], evidenceUrl: 'https://hdroofingandrepairs.com/careers', evidence: 'never read', reviewReason: 'blocked_by_site', findSites: async () => ['hdroofingandrepairs.com'], sites: {} })
  NOTHING(r)
  assert.deepEqual(r.searched, [], 'the site is already known and already refused us: a search could only return it')
  assert.deepEqual(why(r), ['own_site_refused_reading'])
  assert.ok(!r.fetched.some(f => f.startsWith('hdroofingandrepairs.com')), 'the refusing host is not fetched again by any path')
  assert.ok(r.audit.some(a => a.status === 'skipped_site_refused_us'))
  // a blocked page on SOMEONE ELSE's host (a social post) is different: the search still runs
  const fb = await run({ company: 'TDot Dental', evidenceUrl: 'https://www.facebook.com/tdotdental/posts/1', evidence: 'never read', reviewReason: 'blocked_by_site', findSites: async () => [], sites: {} })
  assert.deepEqual(fb.searched, ['TDot Dental']); assert.deepEqual(why(fb), ['not_confirmed'])
})

test('#1122 a lead the crawl never picks (its hold is the event itself, like the real TADCO lead: someone else\'s customer) says the website check did not run; a picked lead keeps its own reason; a rejected lead gets nothing', async () => {
  const r = await run({ company: 'TDot Dental', evidenceUrl: BOARD, evidence: plain('TDot Dental'), sites: {}, more: [{ id: 'L2', company: 'TADCO Roofing', reviewReason: 'counterparty_signal' }, { id: 'L3', company: 'Closed Co', reviewReason: 'job_closed' }, { id: 'L4', company: 'Gone Co', reviewReason: 'counterparty_signal' }] })
  assert.deepEqual(why(r.lead('L1')), ['not_confirmed']); assert.deepEqual(why(r.lead('L2')), ['not_checked']); assert.deepEqual(why(r.lead('L3')), ['not_checked'])
  assert.equal(domainUnresolvedText(r.lead('L2').unresolved[0].label), 'the website check does not run for a lead held for this reason')
  // a re-run writes no second row; a single-lead crawl (the "find contact" button) never labels the scan's other leads
  await r.crawl(); assert.equal(r.lead('L2').unresolved.length, 1)
  r.db.prepare("UPDATE leads SET quarantined_at = 1 WHERE id = 'L4'").run(); r.db.prepare("DELETE FROM lead_enrichments WHERE lead_id = 'L4'").run(); await r.crawl()
  assert.deepEqual(why(r.lead('L4')), [], 'a rejected lead gets no row')
  r.db.prepare("DELETE FROM lead_enrichments WHERE kind = 'domain_unresolved'").run()
  await r.crawl({ leads: [{ id: 'L1', company: 'TDot Dental', source_url: BOARD }] })
  assert.deepEqual(why(r.lead('L2')), [], 'a one-lead crawl says nothing about the others')
})

test('#1122 the reason is a note beside a lead with NO website: none beside a bound domain; a later run that confirms a site removes it; a blocked source page is never re-fetched', async () => {
  const first = await run({ company: 'Restor Dental', evidenceUrl: BOARD, evidence: plain('Restor Dental'), sites: { 'restordental.ca': { '/': TORONTO_HOME('Restor Dental'), '/contact': CONTACT('info@restordental.ca') } } })
  assert.equal(first.domain, 'restordental.ca')
  await crawlJob(first.db, 'A', first.job, { get: async url => new URL(url).hostname === 'tempstars.example' ? { status: 200, body: html('x'), finalUrl: url } : null, gapMs: 0, env: {}, now: Date.parse('2026-11-15T12:00:00Z'), redirectOf: async () => null })
  assert.equal(first.lead('L1').domain, 'restordental.ca'); assert.deepEqual(first.lead('L1').unresolved, [], 'one failed re-read is not "no website"')
  const fb = 'https://www.facebook.com/tdotdental/posts/1'
  const later = await run({ company: 'TDot Dental', evidenceUrl: fb, evidence: 'never read', reviewReason: 'blocked_by_site', sites: {} })
  assert.ok(!later.fetched.some(f => f.startsWith('facebook.com'))); assert.equal(later.unresolved.length, 1)
  const sites: Record<string, Record<string, string>> = { 'tdotdental.ca': { '/': TORONTO_HOME('TDot Dental'), '/contact': CONTACT('info@tdotdental.ca') } }
  const get: Get = async url => { const u = new URL(url); const s = sites[u.hostname.replace(/^www\./, '')]; if (!s) return null; if (u.pathname === '/robots.txt') return { status: 200, body: '', finalUrl: url }; const b = s[u.pathname]; return b !== undefined ? { status: 200, body: b, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(later.db, 'A', later.job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-15T12:00:00Z'), redirectOf: async () => null })
  assert.equal(later.lead('L1').domain, 'tdotdental.ca'); assert.deepEqual(later.lead('L1').unresolved, [], 'the stale reason is removed once a site is confirmed')
})

test('#1122 a post-processing deadline during the web search keeps nothing: no domain, no reason row (a partial read never looks complete)', async () => {
  const ctl = new AbortController()
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: ['Toronto, Ontario'] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)').run('L1', job, 'TDot Dental', null, 's', BOARD, 'TDot Dental is hiring in Toronto', 90, 85)
  const get: Get = async url => { const u = new URL(url); if (u.hostname === 'tempstars.example') return { status: 200, body: html('x'), finalUrl: url }; if (u.hostname.replace(/^www\./, '') !== 'tdot-dental.example') return null; return u.pathname === '/robots.txt' ? { status: 200, body: '', finalUrl: url } : u.pathname === '/' ? { status: 200, body: TORONTO_HOME('TDot Dental'), finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, signal: ctl.signal, redirectOf: async () => null, findSites: async () => { ctl.abort(); return ['tdot-dental.example'] } })
  assert.equal((db.prepare("SELECT company_domain d FROM leads WHERE id = 'L1'").get() as { d: string | null }).d, null)
  assert.equal((db.prepare('SELECT count(*) n FROM lead_enrichments').get() as { n: number }).n, 0)
})

test('#1122 council: an IP-literal or single-label host is never a company site - not from structured data, not as a forwarding target, not fetched (the private-address guard only runs for names)', async () => {
  for (const h of ['10.0.0.5', '192.168.1.1', '127.0.0.1', 'localhost', '::1', '[::1]', '1.2.3', 'x.', 'exa mple.com']) assert.equal(sc.siteHostOk(h), false, h)
  for (const h of ['acme.ca', 'a.b.co.uk', 'xn--bcher-kva.de']) assert.equal(sc.siteHostOk(h), true, h)
  assert.deepEqual(sc.jsonLdCompanySites('Acme Dental', ld({ '@type': 'Organization', name: 'Acme Dental', url: 'https://10.0.0.5/', sameAs: ['https://localhost/', 'https://[::1]/'] }), 'x.example'), [])
  // the crawl's own fetch refuses an IP literal before any socket is opened (a lookup spy would never be called for one anyway)
  let lookups = 0
  const spy = ((...a: unknown[]) => { lookups++; (a[a.length - 1] as (e: Error) => void)(new Error('no')) }) as never
  assert.deepEqual(sc.findCompanySitesWithBasis('Acme Dental', html('<a href="https://10.0.0.5/">Acme Dental</a> <a href="https://localhost/">Acme Dental</a>'), 'https://jobs.example.net/x'), [], 'a link to an IP or a single label is never offered as the company site')
  assert.equal(await sc.rawRedirectTarget('192.168.1.1', 500, spy), null); assert.equal(await sc.rawRedirectTarget('https://user:pw@acme.example/', 500, spy), null)
  assert.equal(lookups, 0, 'nothing was resolved or connected')
  // a name-built guess that forwards to a private address: the target is never tried
  const r = await run({ company: 'Queen Street Dental Centre', evidenceUrl: 'https://ca.linkedin.example/jobs/view/1', evidence: plain('Queen Street Dental Centre'), redirects: { 'queenstreetdentalcentre.com': '192.168.1.1', 'queenstreetdentalcentre.ca': 'localhost' }, sites: { '192.168.1.1': { '/': TORONTO_HOME('Queen Street Dental Centre') }, localhost: { '/': TORONTO_HOME('Queen Street Dental Centre') } } })
  NOTHING(r); assert.ok(!r.fetched.some(f => f.startsWith('192.168.') || f.startsWith('localhost')), JSON.stringify(r.fetched)); assert.ok(!r.audit.some(a => a.status.startsWith('redirects_to')))
})

test('#1122 council: a page with a character whose lower-case form is longer ("İ") before its JSON-LD still yields the site; an unknown or inherited reason code reads as the general sentence; New South Wales is not Wales', () => {
  const page = `İ${ld({ '@type': 'Organization', name: 'Acme Dental', url: 'https://acmedental.ca' })}`
  assert.deepEqual(sc.findCompanySitesWithBasis('Acme Dental', page, 'https://jobs.example.net/x'), [{ site: 'acmedental.ca', basis: 'evidence_link_domain_label', structured: true }])
  for (const c of ['constructor', 'toString', '__proto__', 'nope']) assert.equal(domainUnresolvedText(T + c), 'the company website could not be confirmed', c)
  assert.deepEqual(sc.countryTlds(['New South Wales']), ['com.au']); assert.deepEqual(sc.countryTlds(['Wales, UK']), ['co.uk', 'uk']); assert.deepEqual(sc.countryTlds(['Ontario, Calif.']), [])
  for (const t of ['Plumber', 'Hotel', 'Bakery', 'Attorney']) assert.deepEqual(sc.jsonLdCompanySites('Acme Works', ld({ '@type': t, name: 'Acme Works', url: 'https://acmeworks.example/' })), ['acmeworks.example'], t)
})

test('#1122 council (reasons true in every path): a JavaScript-only own site is not a refusal; a lead beyond the scan\'s checked leads is not "held"; robots rules that could not be fetched are not a refusal', async () => {
  const js = await run({ company: 'HD Roofing & Repairs', where: ['Austin, Texas'], evidenceUrl: 'https://hdroofingandrepairs.com/careers', evidence: 'never read', reviewReason: 'needs_javascript', findSites: async () => [], sites: {} })
  assert.deepEqual(why(js), ['own_site_needs_javascript']); assert.deepEqual(js.searched, [])
  assert.equal(domainUnresolvedText(js.unresolved[0].label), 'the company\'s own website can only be read with JavaScript, which this check does not run')
  // nine checkable leads: the crawl reads the scan's top eight; the ninth is told that, never that it is held
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `M${i}`, company: `Filler Clinic ${String.fromCharCode(65 + i)}${String.fromCharCode(75 + i)}` }))
  const capped = await run({ company: 'Zed Dental Studio', evidenceUrl: BOARD, evidence: plain('x'), sites: {}, more: many })
  const codes = ['L1', ...many.map(m => m.id)].map(id => why(capped.lead(id))[0])
  assert.equal(codes.filter(c => c === 'probe_limit_reached').length, 1, JSON.stringify(codes)); assert.ok(!codes.includes('not_checked'))
  assert.equal(domainUnresolvedText(`${T}probe_limit_reached`), 'this scan checks the websites of its top leads only and did not reach this company')
  // a linked site whose robots.txt answers 500: not read, and not called a refusal
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: ['Toronto, Ontario'] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)').run('L1', job, 'Restor Dental', null, 's', BOARD, 'Restor Dental is hiring', 90, 85)
  const get: Get = async url => { const u = new URL(url); if (u.hostname === 'tempstars.example') return { status: 200, body: html('<a href="https://restordental.example/">Restor Dental</a>'), finalUrl: url }; return u.pathname === '/robots.txt' ? { status: 500, body: '', finalUrl: url } : { status: 200, body: TORONTO_HOME('Restor Dental'), finalUrl: url } }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, redirectOf: async () => null })
  assert.deepEqual((db.prepare("SELECT label FROM lead_enrichments WHERE kind = 'domain_unresolved'").all() as { label: string }[]).map(x => x.label), [`${T}linked_site_not_confirmed`], 'never "does not allow automated reading"')
  // a namesake's .com was READ and refused (another place) and the .ai forbids reading: the lead is not told a likely site refused reading
  const mixed = await run({ company: 'Restor Dental', evidenceUrl: BOARD, evidence: plain('Restor Dental'), robots: { 'restordental.ai': 'User-agent: *\nDisallow: /' }, sites: { 'restordental.com': { '/': ELSEWHERE_HOME('Restor Dental') }, 'restordental.ai': { '/': TORONTO_HOME('Restor Dental') } } })
  assert.deepEqual(why(mixed), ['not_confirmed'])
})

test('#1122 council (redirect guards): only a name-built guess is followed; a target that is the lead\'s own blocked host or one already tried is not tried again', async () => {
  // a site the page itself links that is unreachable: never chased through a redirect
  const linked = await run({ company: 'Restor Dental', evidenceUrl: BOARD, evidence: html('<a href="https://restor-dental-site.example/">Restor Dental</a>'), redirects: { 'restor-dental-site.example': 'elsewhere.example' }, sites: { 'elsewhere.example': { '/': TORONTO_HOME('Restor Dental') } } })
  NOTHING(linked); assert.deepEqual(linked.asked, [], 'no redirect is looked up for a linked site'); assert.deepEqual(why(linked), ['linked_site_not_confirmed'])
  // the guess forwards to the very host that blocked the lead's source page: not fetched by that path either
  const blocked = await run({ company: 'TDot Dental', evidenceUrl: 'https://blog.tdot-dental.example/post', evidence: 'never read', reviewReason: 'blocked_by_site', redirects: { 'tdotdental.com': 'tdot-dental.example' }, sites: { 'tdot-dental.example': { '/': TORONTO_HOME('TDot Dental') }, 'blog.tdot-dental.example': { '/': TORONTO_HOME('TDot Dental') } } })
  NOTHING(blocked); assert.ok(!blocked.fetched.some(f => f.includes('tdot-dental.example')), JSON.stringify(blocked.fetched)); assert.ok(blocked.asked.includes('tdotdental.com'), 'the forward was looked up, and its target refused because it is the host that blocked us')
  // two guesses forwarding to the same target: it is read once
  const same = await run({ company: 'TDot Dental', evidenceUrl: BOARD, evidence: plain('TDot Dental'), redirects: { 'tdotdental.com': 'tdot-dental.example', 'tdotdental.ca': 'tdot-dental.example' }, sites: { 'tdot-dental.example': { '/': ELSEWHERE_HOME('TDot Dental') } } })
  NOTHING(same); assert.equal(same.fetched.filter(f => f === 'tdot-dental.example/').length, 1); assert.equal(same.audit.filter(a => a.status === 'redirects_to tdot-dental.example').length, 1)
})
