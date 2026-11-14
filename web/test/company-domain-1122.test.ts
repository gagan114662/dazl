import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import * as sc from '../lib/connectors/sitecrawl.ts'   // helpers by namespace: on main they do not exist, and each test then fails on its own behaviour, not at import

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
  assert.deepEqual(sc.jsonLdCompanySites('Restor Dental', page, 'tempstars.example'), ['restordental.example'])
  assert.deepEqual(sc.jsonLdCompanySites('Restor Dental', boardPage({ name: 'Another Clinic', url: 'https://another.example/' })), [])
  assert.deepEqual(sc.jsonLdCompanySites('Restor Dental', '<script type="application/ld+json">{not json</script>'), [], 'unreadable structured data is ignored')
})

test('#1122 a Canadian request probes the .ca site built from the name: confirmed by name AND place, recorded as a guess', async () => {
  assert.deepEqual(sc.countryTlds(['Toronto, Ontario']), ['ca']); assert.deepEqual(sc.countryTlds(['Austin, Texas']), []); assert.deepEqual(sc.countryTlds(['Victoria']), [], 'a bare city never picks a country')
  assert.deepEqual(sc.probeDomains('Restor Dental', ['Toronto, Ontario']).slice(0, 2), ['restordental.com', 'restordental.ca'])
  assert.deepEqual(sc.probeDomains('Restor Dental'), ['restordental.com', 'restordental.ai', 'restordental.io', 'restordental.co'], 'no geography: the probes are the ones main already made')
  const r = await run({ company: 'Restor Dental', evidenceUrl: BOARD, evidence: html('<p>Restor Dental is hiring in Toronto.</p>'), sites: { 'restordental.ca': { '/': TORONTO_HOME('Restor Dental'), '/contact': CONTACT('info@restordental.ca') } } })
  assert.equal(r.domain, 'restordental.ca')
  assert.deepEqual(r.basis, ['restordental.ca|name_probe'])
})

test('#1122 a company whose site cannot be built from its name: ONE web search, listing and social hosts dropped, the hit confirmed by name and place, kept as a guess', async () => {
  const urls = ['https://www.facebook.com/tdotdental', 'https://www.yelp.ca/biz/tdot-dental-toronto', 'https://www.ratemds.com/clinic/tdot', 'https://tempstars.example/jobs/1', 'https://www.torontolocalnews.example/2026/tdot-dental-opens', 'https://www.tdot-dental.example/about', 'https://ca.indeed.com/cmp/Tdot-Dental']
  const r = await run({ company: 'TDot Dental', evidenceUrl: BOARD, evidence: html('<p>TDot Dental is hiring in Toronto.</p>'), siteSearch: async () => ({ ok: true, urls }),
    sites: { 'tdot-dental.example': { '/': TORONTO_HOME('TDot Dental'), '/contact': CONTACT('info@tdot-dental.example') },
      'torontolocalnews.example': { '/': html(`<h1>Toronto Local News</h1><p>TDot Dental opens a second clinic at 1 Yonge Street, Toronto, ON M5E 1E5.</p>${PROSE}<a href="/contact">Contact</a>`), '/contact': CONTACT('info@torontolocalnews.example') } } })
  assert.deepEqual(r.queries, ['"TDot Dental" Toronto, Ontario official website'], 'one search, the company by name and the request\'s place')
  assert.equal(r.domain, 'tdot-dental.example', 'the hit whose own name is the company (hyphenated: no name guess builds it)')
  assert.deepEqual(r.basis, ['tdot-dental.example|name_probe'], 'a searched site is a guess, never "linked from the source"')
  assert.deepEqual(r.emails, ['info@tdot-dental.example'])
  assert.deepEqual(r.unresolved, [])
  assert.ok(!r.fetched.some(f => /facebook|yelp|ratemds|indeed|torontolocalnews/.test(f)), 'a network, a listing host or a site not named like the company is never fetched as the company site')
  assert.deepEqual(sc.searchCandidateSites('TDot Dental', urls, 'tempstars.example'), ['tdot-dental.example'])
  assert.deepEqual(sc.searchCandidateSites('Tadco Roofing & Waterproofing', ['https://other.example/', 'https://tadcoroofing.example/x', 'https://dental.example/', 'https://health.gov/x', 'ftp://x.example/', 'not a url']), ['tadcoroofing.example'], 'the name\'s own beginning counts; a generic word inside it, another site, a government host and a non-web address never')
  assert.equal(sc.siteSearchQuery('A "B" Co', []), '"A  B  Co" official website')
})

test('#1122 a searched site that names the company but stands in ANOTHER place is refused: no domain, no contact, and the lead says why', async () => {
  const elsewhere = html(`<h1>TDot Dental</h1><p>Visit us at 8500 Whittier Blvd, Pico Rivera, CA 90660.</p>${PROSE}<a href="/contact">Contact</a>`)
  const r = await run({ company: 'TDot Dental', evidenceUrl: BOARD, evidence: html('<p>TDot Dental is hiring in Toronto.</p>'), siteSearch: async () => ({ ok: true, urls: ['https://tdotdental-clinic.example/'] }),
    sites: { 'tdotdental-clinic.example': { '/': elsewhere, '/contact': CONTACT('info@tdotdental-clinic.example') } } })
  assert.equal(r.domain, null); assert.deepEqual(r.basis, []); assert.deepEqual(r.emails, [])
  assert.deepEqual(r.unresolved, [{ value: 'No company website confirmed', label: 'domain-unresolved-v1:search_result_not_confirmed', source_url: BOARD }])
})

test('#1122 council R1 (blocker): a search hit on a site NOT named like the company is never a candidate, even when its homepage names the company and the city (a news site, a directory): no domain, no contact', async () => {
  const news = html(`<h1>Toronto Local News</h1><p>TDot Dental opens a second clinic at 1 Yonge Street, Toronto, ON M5E 1E5.</p>${PROSE}<a href="/contact">Contact</a>`)
  const r = await run({ company: 'TDot Dental', evidenceUrl: BOARD, evidence: html('<p>TDot Dental is hiring in Toronto.</p>'), siteSearch: async () => ({ ok: true, urls: ['https://torontolocalnews.example/2026/tdot-dental-opens', 'https://bestdentists.example/toronto'] }),
    sites: { 'torontolocalnews.example': { '/': news, '/contact': CONTACT('info@torontolocalnews.example') }, 'bestdentists.example': { '/': html(`<h1>The best dentists in Toronto, ON: TDot Dental</h1>${PROSE}`) } } })
  assert.equal(r.domain, null); assert.deepEqual(r.basis, []); assert.deepEqual(r.emails, [])
  assert.ok(!r.fetched.some(f => /torontolocalnews|bestdentists/.test(f)), 'neither is even read')
  assert.equal(r.unresolved[0].label, 'domain-unresolved-v1:search_found_no_candidate')
})

test('#1122 each unresolved outcome has its own reason: no search source, only listing hits, a failed search, the scan\'s search allowance', async () => {
  const base = { company: 'TDot Dental', evidenceUrl: BOARD, evidence: html('<p>TDot Dental is hiring in Toronto.</p>'), sites: {} }
  const code = (r: { unresolved: { label: string }[] }) => (r.unresolved[0]?.label ?? '').replace('domain-unresolved-v1:', '')
  assert.equal(code(await run(base)), 'name_guess_not_confirmed', 'no search source configured: the name guesses are the last step, as on main, but now the lead says so')
  assert.equal(code(await run({ ...base, siteSearch: async () => ({ ok: true, urls: ['https://www.facebook.com/tdot', 'https://www.yelp.ca/biz/tdot'] }) })), 'search_found_no_candidate')
  const failed = await run({ ...base, siteSearch: async () => ({ ok: false, reason: 'cap' }) })
  assert.equal(code(failed), 'search_cap'); assert.equal(sc.domainUnresolvedWords(code(failed)), 'the web search for the company website could not run')
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
  assert.equal(r.unresolved[0].label, 'domain-unresolved-v1:linked_site_not_confirmed')
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

test('#1122 the runner\'s site search: never on a free-trial scan, never without a search source, never once the scan is not this attempt\'s; otherwise the search source\'s hit URLs, at most the scan\'s allowance', async () => {
  const { siteSearchFor } = await import('../lib/scan/runner.ts')
  const { MAX_SITE_SEARCHES_PER_SCAN } = await import('../lib/connectors/sitecrawl.ts')
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const id = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?").run(id)
  const job = { id, user_id: 'A', attempts: 1, funded_by: 'user' }
  const env = { TINYFISH_API_KEY: 'tf-test' }
  let calls = 0
  const fetchImpl = (async () => { calls++; return new Response(JSON.stringify({ results: [{ url: 'https://tdotdental.example/', title: 'TDot Dental', snippet: 's' }, { url: 'https://www.yelp.ca/biz/tdot', title: 'y', snippet: 's' }] }), { status: 200 }) }) as unknown as typeof fetch
  assert.equal(siteSearchFor(db, { ...job, funded_by: 'trial' }, { env, fetchImpl }), undefined, 'a free-trial scan spends only the searches it reserved before finish')
  assert.equal(siteSearchFor(db, job, { env: {}, fetchImpl }), undefined, 'no search source configured')
  const search = siteSearchFor(db, job, { env, fetchImpl })!
  assert.deepEqual(await search('"TDot Dental" Toronto official website'), { ok: true, urls: ['https://tdotdental.example/', 'https://www.yelp.ca/biz/tdot'] })
  for (let i = 1; i < MAX_SITE_SEARCHES_PER_SCAN; i++) assert.equal((await search(`q${i}`)).ok, true)
  assert.deepEqual(await search('one too many'), { ok: false, reason: 'cap' }, 'the scan\'s own allowance, on top of the tenant and global daily caps')
  assert.equal(calls, MAX_SITE_SEARCHES_PER_SCAN, 'a refused search is never sent')
  const stale = siteSearchFor(db, { ...job, attempts: 2 }, { env, fetchImpl })!
  assert.deepEqual(await stale('q'), { ok: false, reason: 'scan_not_active' }); assert.equal(calls, MAX_SITE_SEARCHES_PER_SCAN)
})

test('#1122 council R1: a posting or article node titled "<role> at <Company>" is not the company; its url (the posting, a mirror, a news story) is never taken as the company site', async () => {
  const posting = { '@type': 'JobPosting', name: 'Hygienist at Restor Dental Toronto', url: 'https://www.localnews-mirror.example/story', hiringOrganization: { '@type': 'Organization', name: 'Restor Dental', sameAs: 'https://jobs.lever.co/restor' } }
  assert.deepEqual(sc.jsonLdCompanySites('Restor Dental', boardPage(posting), 'tempstars.example'), [], 'the posting\'s own url is not the employer\'s site, and an applicant-tracking host is a listing, not a site')
  assert.deepEqual(sc.jsonLdCompanySites('Restor Dental', boardPage({ '@type': 'NewsArticle', name: 'Restor Dental opens', url: 'https://news.example/restor' })), [])
  assert.deepEqual(sc.jsonLdCompanySites('Restor Dental', boardPage({ '@type': ['LocalBusiness', 'Dentist'], name: 'Restor Dental', url: 'https://restordental.example/' })), ['restordental.example'])
  // through the crawl: nothing from that posting counts as "linked", so the name guess and the search still run
  const r = await run({ company: 'Restor Dental', evidenceUrl: BOARD, evidence: boardPage(posting), siteSearch: async () => ({ ok: true, urls: [] }), sites: { 'localnews-mirror.example': { '/': TORONTO_HOME('Restor Dental') } } })
  assert.equal(r.domain, null); assert.equal(r.queries.length, 1, 'not treated as a linked site: the search still ran')
  assert.ok(!r.fetched.some(f => f.startsWith('localnews-mirror.example')), 'the story host is never read as the company site')
})

test('#1122 council R4/R5: a hit already tried as a name guess is not read again; a deadline during the search keeps nothing; the card words carry no code', async () => {
  const elsewhere = html(`<h1>TDot Dental</h1><p>Visit us at 8500 Whittier Blvd, Pico Rivera, CA 90660.</p>${PROSE}`)
  const again = await run({ company: 'TDot Dental', evidenceUrl: BOARD, evidence: html('<p>TDot Dental is hiring in Toronto.</p>'), siteSearch: async () => ({ ok: true, urls: ['https://tdotdental.com/', 'https://www.tdotdental.ca/about'] }), sites: { 'tdotdental.com': { '/': elsewhere } } })
  assert.equal(again.fetched.filter(f => f === 'tdotdental.com/').length, 1, 'the refused guess is not fetched a second time as a search hit')
  assert.equal(again.unresolved[0].label, 'domain-unresolved-v1:search_found_no_candidate')
  // a post-processing deadline that fires while the search is in flight: the crawl stops, no domain, no reason row (a partial read never looks complete)
  const ctl = new AbortController()
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: ['Toronto, Ontario'] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)').run('L1', job, 'TDot Dental', null, 's', BOARD, 'TDot Dental is hiring in Toronto', 90, 85)
  const home = TORONTO_HOME('TDot Dental')
  const get: Get = async url => { const u = new URL(url); if (u.hostname === 'tempstars.example') return { status: 200, body: html('x'), finalUrl: url }; if (u.hostname.replace(/^www\./, '') !== 'tdot-smiles.example') return null; return u.pathname === '/robots.txt' ? { status: 200, body: '', finalUrl: url } : u.pathname === '/' ? { status: 200, body: home, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, signal: ctl.signal, siteSearch: async () => { ctl.abort(); return { ok: true, urls: ['https://tdot-smiles.example/'] } } })
  assert.equal((db.prepare("SELECT company_domain d FROM leads WHERE id = 'L1'").get() as { d: string | null }).d, null)
  assert.equal((db.prepare("SELECT count(*) n FROM lead_enrichments").get() as { n: number }).n, 0, 'nothing derived is written after the deadline')
  // the words the card shows
  const { domainUnresolvedText } = await import('../lib/connectors/domain-unresolved.ts')
  assert.equal(domainUnresolvedText('domain-unresolved-v1:name_guess_not_confirmed'), 'no website built from the company name was confirmed as this company in this place')
  assert.equal(domainUnresolvedText('domain-unresolved-v1:search_cap'), 'the web search for the company website could not run')
  assert.equal(domainUnresolvedText(null), 'the company website could not be confirmed')
  for (const c of ['no_site_linked', 'linked_site_not_confirmed', 'name_guess_not_confirmed', 'probe_limit_reached', 'search_limit_reached', 'search_found_no_candidate', 'search_result_not_confirmed', 'time_budget', 'site_not_readable', 'site_not_read']) assert.doesNotMatch(domainUnresolvedText('domain-unresolved-v1:' + c), /[_\[\]]|could not be confirmed$/, c)
})

test('#1122 council R3: a lead that already has a confirmed domain keeps it and gets no "no website" row when a later read of this scan fails', async () => {
  const first = await run({ company: 'Restor Dental', evidenceUrl: BOARD, evidence: html('<p>Restor Dental is hiring in Toronto.</p>'), sites: { 'restordental.ca': { '/': TORONTO_HOME('Restor Dental'), '/contact': CONTACT('info@restordental.ca') } } })
  assert.equal(first.domain, 'restordental.ca')
  await crawlJob(first.db, 'A', first.job, { get: async url => new URL(url).hostname === 'tempstars.example' ? { status: 200, body: html('x'), finalUrl: url } : null, gapMs: 0, env: {}, now: Date.parse('2026-11-15T12:00:00Z') })
  const after = first.lead('L1')
  assert.equal(after.domain, 'restordental.ca'); assert.deepEqual(after.unresolved, [])
})

test('#1122 council (edge inputs): country detection, the listing filter, the structured-data walk and the operator\'s own search limit', async () => {
  const tlds = (w: string) => sc.countryTlds([w])
  for (const w of ['Toronto, ON', 'Vancouver, BC', 'Québec', 'Calgary, Alberta', 'Canada']) assert.deepEqual(tlds(w), ['ca'], w)
  for (const w of ['New England', 'New Brunswick, New Jersey', 'Ontario, California', 'Ontario, CA', 'Austin, Texas', 'Indiana', 'Victoria', 'Georgia', 'come on, try it']) assert.deepEqual(tlds(w), [], w)
  assert.deepEqual(tlds('Northern Ireland'), ['co.uk', 'uk'], 'not the Republic\'s TLD'); assert.deepEqual(tlds('Dublin, Ireland'), ['ie']); assert.deepEqual(tlds('London, UK'), ['co.uk', 'uk'])
  // a listing word blocks the listing site itself, not a company that shares the word on another TLD; government hosts never
  assert.deepEqual(sc.searchCandidateSites('Monster Energy', ['https://www.monster.com/jobs', 'https://monster.energy/']), ['monster.energy'])
  assert.deepEqual(sc.searchCandidateSites('Canada Dental', ['https://www.canada.ca/en', 'https://canada.dental/', 'https://www.ontario.gov.on.ca/x', 'https://x.gc.ca/', 'https://health.gov/']), ['canada.dental'])
  assert.deepEqual(sc.searchCandidateSites('Abc', ['https://abc.example/']), [], 'a name under four letters is never searched for')
  // structured data: a shorter organisation name inside ours is someone else; a government or listing host is never taken; a huge array neither crashes nor hides the site
  const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`
  assert.deepEqual(sc.jsonLdCompanySites('Canada Goose', ld({ '@type': 'Organization', name: 'Canada', url: 'https://www.canada.ca/' })), [])
  assert.deepEqual(sc.jsonLdCompanySites('Ontario Hydro One', ld({ name: 'Ontario', url: 'https://www.ontario.ca/' })), [])
  assert.deepEqual(sc.jsonLdCompanySites('Acme Robotics', ld({ name: 'Acme Robotics', url: 'https://jobs.lever.co/acme', sameAs: [7, null, { x: 1 }, 'https://user:pw@acme-robotics.example:8443/about'] })), ['acme-robotics.example'])
  assert.deepEqual(sc.jsonLdCompanySites('Acme Robotics', ld({ name: 'Acme Robotics', list: Array(300_000).fill(0), url: 'https://acme-robotics.example/' })), ['acme-robotics.example'])
  assert.deepEqual(sc.jsonLdCompanySites('Acme Robotics', ld(Array(300_000).fill({ name: 'x' }))), [], 'bounded walk')
  // the operator's own lower per-scan search limit is never raised by this path
  const { siteSearchFor } = await import('../lib/scan/runner.ts')
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const id = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?").run(id)
  let calls = 0
  const fetchImpl = (async () => { calls++; return new Response(JSON.stringify({ results: [] }), { status: 200 }) }) as unknown as typeof fetch
  const one = siteSearchFor(db, { id, user_id: 'A', attempts: 1, funded_by: 'user' }, { env: { TINYFISH_API_KEY: 'tf-test', TINYFISH_SEARCHES_PER_SCAN: '1' }, fetchImpl })!
  assert.equal((await one('a')).ok, true); assert.deepEqual(await one('b'), { ok: false, reason: 'cap' }); assert.equal(calls, 1)
  // a scan whose state cannot be read spends nothing (strict liveness)
  const broken = { prepare: () => { throw new Error('db down') } } as unknown as Database.Database
  const s2 = siteSearchFor(broken, { id, user_id: 'A', attempts: 1, funded_by: 'user' }, { env: { TINYFISH_API_KEY: 'tf-test' }, fetchImpl })!
  assert.deepEqual(await s2('q'), { ok: false, reason: 'scan_not_active' }); assert.equal(calls, 1)
})

test('#1122 council R2: a listing host named in structured data is not "the linked site": it is dropped, and the name guess still binds the real one; a refused structured-data host does not stop the guess or the search', async () => {
  const zip = boardPage({ '@type': 'JobPosting', hiringOrganization: { '@type': 'Organization', name: 'Restor Dental', sameAs: 'https://www.ziprecruiter.com/co/Restor-Dental' } })
  const a = await run({ company: 'Restor Dental', evidenceUrl: BOARD, evidence: zip, sites: { 'restordental.ca': { '/': TORONTO_HOME('Restor Dental'), '/contact': CONTACT('info@restordental.ca') } } })
  assert.equal(a.domain, 'restordental.ca'); assert.deepEqual(a.basis, ['restordental.ca|name_probe'])
  const elsewhere = html(`<h1>Restor Dental</h1><p>Visit us at 8500 Whittier Blvd, Pico Rivera, CA 90660.</p>${PROSE}`)
  const other = boardPage({ '@type': 'JobPosting', hiringOrganization: { '@type': 'Organization', name: 'Restor Dental', sameAs: 'https://restor-group.example/' } })
  const b = await run({ company: 'Restor Dental', evidenceUrl: BOARD, evidence: other, siteSearch: async () => ({ ok: true, urls: [] }), sites: { 'restor-group.example': { '/': elsewhere }, 'restordental.ca': { '/': TORONTO_HOME('Restor Dental'), '/contact': CONTACT('info@restordental.ca') } } })
  assert.equal(b.domain, 'restordental.ca', 'the structured-data host was read and refused; the guess still ran and bound the right site')
})

test('#1122 council R7: once the scan\'s spend limit refuses a site search, no further search is attempted for the scan', async () => {
  const { siteSearchFor } = await import('../lib/scan/runner.ts')
  const { SpendRefused } = await import('../lib/llm/spend-guard.ts')
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const id = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?").run(id)
  let calls = 0
  // the scan's own budget refuses inside the search source (reserveScanSpend), before anything is sent
  const refusing = (async () => { calls++; throw new SpendRefused('over_cap') }) as never
  const search = siteSearchFor(db, { id, user_id: 'A', attempts: 1, funded_by: 'user' }, { env: { TINYFISH_API_KEY: 'tf-test' }, search: refusing })!
  const first = await search('a'), second = await search('b')
  assert.deepEqual(first, { ok: false, reason: 'spend_limit' }); assert.deepEqual(second, { ok: false, reason: 'spend_limit' })
  assert.equal(calls, 1, 'the second search is never attempted')
})
