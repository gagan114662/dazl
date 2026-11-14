import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, countryTlds, jsonLdCompanySites, probeDomains, searchCandidateSites, siteSearchQuery, type Get } from '../lib/connectors/sitecrawl.ts'

// #1122: a lead found on a third-party page (job board, news site, social page) got no company website, so no person or email could be
// found for it. Shapes from the real local matrix scans of 2026-11-14 (toronto-dental): evidence on tempstars.com / movojobs.ca / facebook.com,
// probes only ever tried at .com/.ai/.io/.co. The crawl runs for real here (crawlJob); only the network is a table of pages.
const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>We have cared for families in our neighbourhood for many years and we welcome every new patient who walks through our doors.</p>'
const TORONTO_HOME = (name: string) => html(`<h1>${name}</h1><p>Visit us at 200 Bloor Street West, Toronto, ON M5S 1T8.</p>${PROSE}<a href="/contact">Contact</a>`)
const CONTACT = (email: string) => html(`Email: ${email}`)

type Search = (q: string) => Promise<{ ok: true; urls: string[] } | { ok: false; reason: string }>
async function run(o: { company: string; evidenceUrl: string; evidence: string; sites: Record<string, Record<string, string>>; where?: string[]; siteSearch?: Search; maxSiteSearches?: number; excerpt?: string; reviewReason?: string | null; more?: { id: string; company: string }[] }) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: o.where ?? ['Toronto, Ontario'] }), job)
  const ins = db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,review_reason) VALUES (?,?,?,?,?,?,?,?,?,?)')
  ins.run('L1', job, o.company, null, 'Hiring a dental receptionist in Toronto', o.evidenceUrl, o.excerpt ?? `${o.company} is hiring a dental receptionist in Toronto, Ontario`, o.reviewReason === undefined ? 90 : null, 85, o.reviewReason ?? null)
  for (const m of o.more ?? []) ins.run(m.id, job, m.company, null, 'Hiring in Toronto', o.evidenceUrl, `${m.company} is hiring in Toronto, Ontario`, 90, 80, null)
  const evHost = new URL(o.evidenceUrl).hostname
  const fetched: string[] = []
  const get: Get = async url => {
    const u = new URL(url); fetched.push(u.hostname.replace(/^www\./, '') + u.pathname)
    if (u.hostname === evHost) return { status: 200, body: o.evidence, finalUrl: url }
    const site = o.sites[u.hostname.replace(/^www\./, '')]
    if (!site) return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    const b = site[u.pathname]
    return b !== undefined ? { status: 200, body: b, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  const queries: string[] = []
  const siteSearch: Search | undefined = o.siteSearch ? (async q => { queries.push(q); return o.siteSearch!(q) }) : undefined
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-14T12:00:00Z'), ...(siteSearch ? { siteSearch } : {}), ...(o.maxSiteSearches !== undefined ? { maxSiteSearches: o.maxSiteSearches } : {}) })
  const lead = (id: string) => ({
    domain: (db.prepare('SELECT company_domain FROM leads WHERE id = ?').get(id) as { company_domain: string | null }).company_domain,
    basis: (db.prepare("SELECT value FROM lead_enrichments WHERE lead_id = ? AND kind = 'domain'").all(id) as { value: string }[]).map(r => r.value),
    emails: (db.prepare("SELECT value FROM lead_enrichments WHERE lead_id = ? AND kind = 'email'").all(id) as { value: string }[]).map(r => r.value),
    unresolved: (db.prepare("SELECT value, label, source_url FROM lead_enrichments WHERE lead_id = ? AND kind = 'domain_unresolved'").all(id) as { value: string; label: string; source_url: string }[]),
  })
  return { ...lead('L1'), lead, queries, fetched, audit: db.prepare("SELECT lookup, status FROM connector_audit WHERE connector = 'sitecrawl'").all() as { lookup: string; status: string }[], db, job, get }
}

const BOARD = 'https://tempstars.example/jobs/dental-receptionist-toronto-4411'
const boardPage = (ld: unknown) => html(`<h1>Dental receptionist</h1><p>Restor Dental is hiring in Toronto.</p><script type="application/ld+json">${JSON.stringify(ld)}</script>`)

test('#1122 a job board page that names the company site only in its JobPosting structured data: the site is read, confirmed and bound (linked from the cited page)', async () => {
  const ld = { '@type': 'JobPosting', title: 'Dental receptionist', hiringOrganization: { '@type': 'Organization', name: 'Restor Dental', sameAs: 'https://www.smilesbyrestor.ca/' } }
  const r = await run({ company: 'Restor Dental', evidenceUrl: BOARD, evidence: boardPage(ld), sites: { 'smilesbyrestor.ca': { '/': TORONTO_HOME('Restor Dental'), '/contact': CONTACT('hello@smilesbyrestor.ca') } } })
  assert.equal(r.domain, 'smilesbyrestor.ca')
  assert.deepEqual(r.basis, ['smilesbyrestor.ca|evidence_link_text'], 'recorded as linked from the cited page by name, never as verified ownership')
  assert.deepEqual(r.emails, ['hello@smilesbyrestor.ca'])
  assert.deepEqual(r.unresolved, [])
})

test('#1122 structured data: only a node NAMED as this company counts; the board\'s own organisation, a network profile and the page\'s own host never do', () => {
  const page = boardPage([{ '@type': 'Organization', name: 'TempStars', url: 'https://tempstars-corporate.example/' },
    { '@type': 'JobPosting', hiringOrganization: { name: 'Restor Dental Inc.', url: 'https://tempstars.example/employers/restor', sameAs: ['https://www.facebook.com/restordental', 'https://restordental.example/'] } }])
  assert.deepEqual(jsonLdCompanySites('Restor Dental', page, 'tempstars.example'), ['restordental.example'])
  assert.deepEqual(jsonLdCompanySites('Restor Dental', boardPage({ name: 'Another Clinic', url: 'https://another.example/' })), [])
  assert.deepEqual(jsonLdCompanySites('Restor Dental', '<script type="application/ld+json">{not json</script>'), [], 'unreadable structured data is ignored')
})

test('#1122 a Canadian request probes the .ca site built from the name: confirmed by name AND place, recorded as a guess', async () => {
  assert.deepEqual(countryTlds(['Toronto, Ontario']), ['ca']); assert.deepEqual(countryTlds(['Austin, Texas']), []); assert.deepEqual(countryTlds(['Victoria']), [], 'a bare city never picks a country')
  assert.deepEqual(probeDomains('Restor Dental', ['Toronto, Ontario']).slice(0, 2), ['restordental.com', 'restordental.ca'])
  assert.deepEqual(probeDomains('Restor Dental'), ['restordental.com', 'restordental.ai', 'restordental.io', 'restordental.co'], 'no geography: the probes are the ones main already made')
  const r = await run({ company: 'Restor Dental', evidenceUrl: BOARD, evidence: html('<p>Restor Dental is hiring in Toronto.</p>'), sites: { 'restordental.ca': { '/': TORONTO_HOME('Restor Dental'), '/contact': CONTACT('info@restordental.ca') } } })
  assert.equal(r.domain, 'restordental.ca')
  assert.deepEqual(r.basis, ['restordental.ca|name_probe'])
})

test('#1122 a company whose site cannot be built from its name: ONE web search, listing and social hosts dropped, the hit confirmed by name and place, kept as a guess', async () => {
  const urls = ['https://www.facebook.com/tdotdental', 'https://www.yelp.ca/biz/tdot-dental-toronto', 'https://www.ratemds.com/clinic/tdot', 'https://tempstars.example/jobs/1', 'https://www.torontosmilecentre.example/about', 'https://ca.indeed.com/cmp/Tdot-Dental']
  const r = await run({ company: 'TDot Dental', evidenceUrl: BOARD, evidence: html('<p>TDot Dental is hiring in Toronto.</p>'), siteSearch: async () => ({ ok: true, urls }),
    sites: { 'torontosmilecentre.example': { '/': TORONTO_HOME('TDot Dental'), '/contact': CONTACT('info@torontosmilecentre.example') } } })
  assert.deepEqual(r.queries, ['"TDot Dental" Toronto, Ontario official website'], 'one search, the company by name and the request\'s place')
  assert.equal(r.domain, 'torontosmilecentre.example')
  assert.deepEqual(r.basis, ['torontosmilecentre.example|name_probe'], 'a searched site is a guess, never "linked from the source"')
  assert.deepEqual(r.emails, ['info@torontosmilecentre.example'])
  assert.deepEqual(r.unresolved, [])
  assert.ok(!r.fetched.some(f => /facebook|yelp|ratemds|indeed/.test(f)), 'a network or listing host is never fetched as the company site')
  assert.deepEqual(searchCandidateSites('TDot Dental', urls, 'tempstars.example'), ['torontosmilecentre.example'])
  assert.deepEqual(searchCandidateSites('TDot Dental', ['https://other.example/', 'https://tdotdental.example/x', 'https://health.gov/x', 'https://uni.edu/x', 'ftp://x.example/', 'not a url']), ['tdotdental.example', 'other.example'], 'a host named like the company comes first; government, school and non-web addresses never')
  assert.equal(siteSearchQuery('A "B" Co', []), '"A  B  Co" official website')
})

test('#1122 a searched site that names the company but stands in ANOTHER place is refused: no domain, no contact, and the lead says why', async () => {
  const elsewhere = html(`<h1>TDot Dental</h1><p>Visit us at 8500 Whittier Blvd, Pico Rivera, CA 90660.</p>${PROSE}<a href="/contact">Contact</a>`)
  const r = await run({ company: 'TDot Dental', evidenceUrl: BOARD, evidence: html('<p>TDot Dental is hiring in Toronto.</p>'), siteSearch: async () => ({ ok: true, urls: ['https://tdot-smiles.example/'] }),
    sites: { 'tdot-smiles.example': { '/': elsewhere, '/contact': CONTACT('info@tdot-smiles.example') } } })
  assert.equal(r.domain, null); assert.deepEqual(r.basis, []); assert.deepEqual(r.emails, [])
  assert.deepEqual(r.unresolved, [{ value: 'No company website confirmed', label: 'no website from a web search was confirmed as this company in this place [search_result_not_confirmed]', source_url: BOARD }])
})

test('#1122 a searched site whose homepage does not name the company is never kept', async () => {
  const r = await run({ company: 'TDot Dental', evidenceUrl: BOARD, evidence: html('<p>TDot Dental is hiring in Toronto.</p>'), siteSearch: async () => ({ ok: true, urls: ['https://bestdentists.example/toronto'] }),
    sites: { 'bestdentists.example': { '/': html(`<h1>The best dentists in Toronto, ON</h1>${PROSE}`) } } })
  assert.equal(r.domain, null); assert.equal(r.unresolved[0].label, 'no website from a web search was confirmed as this company in this place [search_result_not_confirmed]')
})

test('#1122 each unresolved outcome has its own reason: no search source, only listing hits, a failed search, the scan\'s search allowance', async () => {
  const base = { company: 'TDot Dental', evidenceUrl: BOARD, evidence: html('<p>TDot Dental is hiring in Toronto.</p>'), sites: {} }
  const code = (r: { unresolved: { label: string }[] }) => /\[([a-z_]+)\]$/.exec(r.unresolved[0]?.label ?? '')?.[1]
  assert.equal(code(await run(base)), 'name_guess_not_confirmed', 'no search source configured: the name guesses are the last step, as on main, but now the lead says so')
  assert.equal(code(await run({ ...base, siteSearch: async () => ({ ok: true, urls: ['https://www.facebook.com/tdot', 'https://www.yelp.ca/biz/tdot'] }) })), 'search_found_no_candidate')
  const failed = await run({ ...base, siteSearch: async () => ({ ok: false, reason: 'cap' }) })
  assert.equal(code(failed), 'search_cap'); assert.match(failed.unresolved[0].label, /^the web search for the company website could not run/)
  assert.ok(failed.audit.some(a => a.status === 'site_search_cap'))
  assert.equal(code(await run({ ...base, siteSearch: async () => { throw new Error('boom') } })), 'search_failed', 'a search that throws is a named reason, never a crash')
  const two = await run({ ...base, maxSiteSearches: 1, more: [{ id: 'L2', company: 'Bloor Smiles' }], siteSearch: async () => ({ ok: true, urls: [] }) })
  assert.equal(two.queries.length, 1, 'the allowance is per scan')
  assert.deepEqual([code(two.lead('L1')), code(two.lead('L2'))].sort(), ['search_found_no_candidate', 'search_limit_reached'])
})

test('#1122 a site the cited page itself links and that is refused ends it there: no name guess, no search overrides the refusal', async () => {
  const elsewhere = html(`<h1>Restor Dental</h1><p>Visit us at 8500 Whittier Blvd, Pico Rivera, CA 90660.</p>${PROSE}`)
  let searched = 0
  const r = await run({ company: 'Restor Dental', evidenceUrl: BOARD, evidence: html('<p><a href="https://restor-dental-ca.example/">Restor Dental</a> is hiring at 200 Bloor Street West, Toronto.</p>'), excerpt: 'Restor Dental is hiring at 200 Bloor Street West, Toronto',
    siteSearch: async () => { searched++; return { ok: true, urls: ['https://restordental.ca/'] } },
    sites: { 'restor-dental-ca.example': { '/': elsewhere }, 'restordental.ca': { '/': TORONTO_HOME('Restor Dental') } } })
  assert.equal(searched, 0); assert.equal(r.domain, null)
  assert.equal(r.unresolved[0].label, 'the website linked from the source page could not be confirmed as this company [linked_site_not_confirmed]')
})

test('#1122 a held lead whose page blocked us is searched too, the blocked host is never re-fetched, and a later run that resolves the site removes the reason', async () => {
  const fb = 'https://www.facebook.com/tdotdental/posts/1'
  const first = await run({ company: 'TDot Dental', evidenceUrl: fb, evidence: 'never read', reviewReason: 'blocked_by_site', sites: {}, siteSearch: async () => ({ ok: true, urls: [fb] }) })
  assert.ok(!first.fetched.some(f => f.startsWith('facebook.com')), 'the blocked page is not fetched again')
  assert.equal(first.domain, null); assert.equal(first.unresolved.length, 1)
  const sites = { 'tdotdental.ca': { '/': TORONTO_HOME('TDot Dental'), '/contact': CONTACT('hi@tdotdental.ca') } }
  const get: Get = async url => { const u = new URL(url); const s = sites[u.hostname.replace(/^www\./, '') as 'tdotdental.ca']; if (!s) return null; if (u.pathname === '/robots.txt') return { status: 200, body: '', finalUrl: url }; const b = (s as Record<string, string>)[u.pathname]; return b !== undefined ? { status: 200, body: b, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(first.db, 'A', first.job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-15T12:00:00Z') })
  const after = first.lead('L1')
  assert.equal(after.domain, 'tdotdental.ca'); assert.deepEqual(after.unresolved, [], 'the stale reason is removed once a site is confirmed')
})
