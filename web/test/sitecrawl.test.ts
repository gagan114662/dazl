import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { crawl4aiGet, crawlJob, crawlSite, contactPaths, extractContacts, findCompanySite, parseRobots, type Get } from '../lib/connectors/sitecrawl.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'

const html = (b: string) => `<html><body>${b}</body></html>`
function site(pages: Record<string, { status?: number; body: string }>): { get: Get; hits: string[] } {
  const hits: string[] = []
  return { hits, get: async url => { const u = new URL(url); hits.push(u.pathname); const p = pages[u.pathname]; return p ? { status: p.status ?? 200, body: p.body, finalUrl: url } : { status: 404, body: '', finalUrl: url } } }
}

test('robots.txt: disallow, allow override, own token group, crawl-delay capped', () => {
  const r = parseRobots('User-agent: *\nDisallow: /private\nCrawl-delay: 30\nUser-agent: dazl\nDisallow: /contact\nAllow: /contact/public', 'a.com')
  assert.equal(r.allows('/contact'), false)
  assert.equal(r.allows('/contact/public'), true)
  assert.equal(r.allows('/about'), true)
  assert.equal(r.delayMs, 10000)
  assert.equal(parseRobots('User-agent: *\nDisallow: /', 'a.com').allows('/'), false)
})

test('company site must be linked from the evidence page and match the company name', () => {
  const ev = html('<a href="https://www.linkedin.com/company/stabyl">li</a><a href="https://stabyl.com/">site</a><a href="https://other.com">x</a>')
  assert.equal(findCompanySite('Stabyl Inc.', ev, 'https://news.example/a'), 'stabyl.com')
  assert.equal(findCompanySite('Nobody Corp', ev, 'https://news.example/a'), null)
  assert.equal(findCompanySite('ab', ev, 'https://news.example/a'), null) // too short to match safely
})

test('only role mailboxes on the company own domain are kept; no guessing', () => {
  const p = html('<a href="mailto:info@acme.com">mail</a> sales@acme.com jane.doe@acme.com support@other.org a@acme.com <a href="tel:+14165550123">call</a>')
  const f = extractContacts(p, 'https://acme.com/contact', 'acme.com')
  assert.deepEqual(f.filter(x => x.kind === 'email').map(x => x.value).sort(), ['info@acme.com', 'sales@acme.com'])
  assert.equal(f.find(x => x.kind === 'phone')?.value, '+14165550123')
  assert.ok(f.every(x => x.url === 'https://acme.com/contact'))
})

test('contact paths come from same-site links only', () => {
  const home = new URL('https://acme.com/')
  const p = contactPaths(html('<a href="/kontakt">k</a><a href="https://evil.com/contact">e</a><a href="/blog/x">b</a><a href="/about?x=1">q</a>'), home)
  assert.ok(p.includes('/kontakt') && p.includes('/contact'))
  assert.ok(!p.some(x => x.includes('evil')))
})

test('crawl obeys robots: disallowed contact page is never requested; unreachable robots means no crawl', async () => {
  const s = site({ '/robots.txt': { body: 'User-agent: *\nDisallow: /contact' }, '/': { body: html('<a href="/about">a</a>') }, '/about': { body: html('hello@acme.com') }, '/contact': { body: html('secret@acme.com') } })
  const r = await crawlSite('acme.com', s.get, 0)
  assert.deepEqual(r.found.map(f => f.value), ['hello@acme.com'])
  assert.ok(!s.hits.includes('/contact'))
  const down = await crawlSite('acme.com', async () => null, 0)
  assert.equal(down.reason, 'robots_unreachable')
  const blocked = await crawlSite('acme.com', site({ '/robots.txt': { body: 'User-agent: *\nDisallow: /' } }).get, 0)
  assert.equal(blocked.reason, 'robots_disallow')
  assert.equal((await crawlSite('acme.com', site({ '/robots.txt': { status: 503, body: '' } }).get, 0)).reason, 'robots_error')
})

test('crawlJob stores each contact with its source page and date; the site is read once and every lead on it gets its own rows', async () => {
  const db = new Database(':memory:'); migrateConnectors(db)
  db.exec("CREATE TABLE leads (id TEXT, scan_job_id TEXT, company TEXT, source_url TEXT, review_reason TEXT, confidence INTEGER, score INTEGER, company_domain TEXT)")
  db.prepare("INSERT INTO leads VALUES ('l1','j1','Stabyl','https://news.example/a',NULL,90,80,NULL),('l2','j1','Stabyl','https://news.example/b',NULL,90,70,NULL),('l3','j1','NoSite Ltd','https://news.example/c',NULL,90,60,NULL)").run()
  const pages: Record<string, { body: string }> = {
    '/a': { body: html('<a href="https://stabyl.com">s</a>') }, '/b': { body: html('<a href="https://stabyl.com">s</a>') }, '/c': { body: html('nothing') },
    '/robots.txt': { body: '' }, '/': { body: html('Stabyl home <a href="/contact-us">c</a>') }, '/contact-us': { body: html('Email: hello@stabyl.com') },
  }
  const reads: string[] = []
  const get: Get = async url => { const u = new URL(url); reads.push(u.hostname + u.pathname); const p = pages[u.pathname]; return p ? { status: 200, body: p.body, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 't1', 'j1', { get, gapMs: 0, env: {}, now: Date.parse('2026-10-20T12:00:00Z') })
  const rows = db.prepare("SELECT lead_id, kind, value, source_url, source_date, connector FROM lead_enrichments WHERE kind <> 'domain' ORDER BY lead_id").all()
  const em = (id: string) => ({ lead_id: id, kind: 'email', value: 'hello@stabyl.com', source_url: 'https://stabyl.com/contact-us', source_date: '2026-10-20', connector: 'sitecrawl' })
  assert.deepEqual(rows, [em('l1'), em('l2')], 'a second lead naming the same company on the same domain gets its own rows')
  assert.equal(reads.filter(r => r === 'stabyl.com/contact-us').length, 1, 'but the contact page is read once')
  const a = db.prepare("SELECT lookup, status, results FROM connector_audit ORDER BY rowid").all()
  // l3's evidence links nothing, so its name-derived probes were tried; the mock's shared home page
  // names a different company, so every probe is rejected by the homepage name check.
  assert.ok(a.some(x => (x as { status: string }).status === 'name_mismatch') && a.some(x => (x as { status: string; results: number }).status === 'ok'))
  assert.equal((db.prepare("SELECT company_domain FROM leads WHERE id = 'l1'").get() as { company_domain: string }).company_domain, 'stabyl.com')
  await crawlJob(db, 't1', 'j1', { get, gapMs: 0, env: { SITECRAWL_ENABLED: '0' } }) // switch off does nothing
})

test('crawl4ai sidecar: POST /crawl shape, robots check on, public hosts only, same-site only', async () => {
  let body: { urls?: string[]; crawler_config?: { params?: { check_robots_txt?: boolean } } } = {}
  const f = (async (_u: string, i: RequestInit) => { body = JSON.parse(String(i.body)); return new Response(JSON.stringify({ results: [{ url: 'https://acme.com/contact', html: '<p>x</p>', status_code: 200, success: true, redirected_url: 'https://acme.com/contact' }] })) }) as unknown as typeof fetch
  const get = crawl4aiGet('http://127.0.0.1:11235/', f, async () => true)
  const r = await get('https://acme.com/contact')
  assert.equal(r?.body, '<p>x</p>'); assert.deepEqual(body.urls, ['https://acme.com/contact']); assert.equal(body.crawler_config?.params?.check_robots_txt, true)
  assert.equal(await crawl4aiGet('http://127.0.0.1:11235', f, async () => false)('https://internal.test/'), null)
  const off = (async () => new Response(JSON.stringify({ results: [{ html: 'y', status_code: 200, redirected_url: 'https://evil.com/' }] }))) as unknown as typeof fetch
  assert.equal(await crawl4aiGet('http://x', off, async () => true)('https://acme.com/'), null)
})

test('social adapter: robots-disallowed profiles are never fetched; allowed ones are', async () => {
  const hits: string[] = []
  const get: Get = async url => {
    const u = new URL(url); hits.push(u.hostname + u.pathname)
    if (u.pathname === '/robots.txt') return { status: 200, body: u.hostname === 'x.com' ? 'User-agent: *\nDisallow: /' : 'User-agent: *\nAllow: /', finalUrl: url }
    if (u.hostname === 'acme.com' && u.pathname === '/') return { status: 200, body: html('Acme <a href="https://x.com/acme">x</a><a href="https://instagram.com/acme">i</a>'), finalUrl: url }
    if (u.hostname === 'instagram.com') return { status: 200, body: html('bio: hello@acme.com'), finalUrl: url }
    return { status: 404, body: '', finalUrl: url }
  }
  const r = await crawlSite('acme.com', get, 0, 'Acme', true)
  assert.ok(!hits.includes('x.com/acme'))
  assert.deepEqual(r.found.map(f => [f.value, f.url]), [['hello@acme.com', 'https://instagram.com/acme']])
  hits.length = 0
  assert.equal((await crawlSite('acme.com', get, 0, 'Acme', false)).found.length, 0)
  assert.ok(!hits.some(h => h.startsWith('instagram')))
})

test('homepage must name the company, else nothing is kept', async () => {
  const s = site({ '/robots.txt': { body: '' }, '/': { body: html('Totally different site info@acme.com') } })
  assert.equal((await crawlSite('acme.com', s.get, 0, 'Stabyl')).reason, 'name_mismatch')
})

test('probeDomains: name-derived domains, safe lengths only', async () => {
  const { probeDomains } = await import('../lib/connectors/sitecrawl.ts')
  assert.deepEqual(probeDomains('Acme Robotics'), ['acmerobotics.com', 'acmerobotics.ai', 'acmerobotics.io', 'acmerobotics.co'])
  assert.deepEqual(probeDomains('ab'), [])
})

test('probeDomains: names ending in "AI" also probe the .ai stem domain', async () => {
  const { probeDomains } = await import('../lib/connectors/sitecrawl.ts')
  assert.deepEqual(probeDomains('Wavee Ai'), ['wavee.ai', 'waveeai.com', 'waveeai.ai', 'waveeai.io', 'waveeai.co'])
  assert.deepEqual(probeDomains('Acme AI'), ['acme.ai', 'acmeai.com', 'acmeai.ai', 'acmeai.io', 'acmeai.co'])
  // single-word names and names only containing "ai" stay unchanged
  assert.deepEqual(probeDomains('Linear'), ['linear.com', 'linear.ai', 'linear.io', 'linear.co'])
})

test('crawlJob probes name-derived domains when evidence links nothing, verifies by homepage name', async () => {
  const db = new Database(':memory:'); migrateConnectors(db)
  db.exec("CREATE TABLE leads (id TEXT, scan_job_id TEXT, company TEXT, source_url TEXT, review_reason TEXT, confidence INTEGER, score INTEGER, company_domain TEXT)")
  db.prepare("INSERT INTO leads VALUES ('l1','j1','Acme Robotics','https://news.example/a',NULL,90,80,NULL),('l2','j1','Ghost Corp','https://news.example/b',NULL,90,70,NULL)").run()
  const get: Get = async url => {
    const u = new URL(url)
    if (u.hostname === 'news.example') return { status: 200, body: html('a roundup with no company links'), finalUrl: url }
    if (u.hostname === 'acmerobotics.com' && u.pathname === '/') return { status: 200, body: html('Acme Robotics home. Email: hello@acmerobotics.com'), finalUrl: url }
    if (u.hostname === 'ghost.com' && u.pathname === '/') return { status: 200, body: html('Totally Different Company landing page'), finalUrl: url }
    if (u.pathname === '/robots.txt') return { status: 200, body: '', finalUrl: url }
    return { status: 404, body: '', finalUrl: url }
  }
  await crawlJob(db, 't1', 'j1', { get, gapMs: 0, env: {}, now: Date.parse('2026-10-20T12:00:00Z') })
  assert.equal((db.prepare("SELECT company_domain FROM leads WHERE id = 'l1'").get() as { company_domain: string }).company_domain, 'acmerobotics.com')
  assert.equal((db.prepare("SELECT value FROM lead_enrichments WHERE lead_id = 'l1' AND kind = 'email'").get() as { value: string }).value, 'hello@acmerobotics.com')
  // Wrong-domain probe rejected by the homepage name check: no domain recorded, mismatch audited.
  assert.equal((db.prepare("SELECT company_domain FROM leads WHERE id = 'l2'").get() as { company_domain: string | null }).company_domain, null)
  const a = db.prepare("SELECT status FROM connector_audit").all() as { status: string }[]
  assert.ok(a.some(x => x.status === 'name_mismatch'))
})

test('extractContacts keeps role emails from JSON-LD blocks (stripped from visible text)', () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Organization","name":"Acme","contactPoint":{"@type":"ContactPoint","email":"sales@acme.com","contactType":"sales"}}
  </script></head><body><p>No visible address here.</p></body></html>`
  const found = extractContacts(html, 'https://acme.com/contact', 'acme.com')
  assert.deepEqual(found.map(f => f.value), ['sales@acme.com'])
})

test('extractContacts deobfuscates "at/dot" forms and applies the same role + same-site filter', () => {
  const html = `<p>Reach us at info [at] acme.com or sales(at)acme dot com. Personal: pat@acme.com. Other site: info@other.com</p>`
  const found = extractContacts(html, 'https://acme.com/contact', 'acme.com')
  const values = found.map(f => f.value).sort()
  assert.deepEqual(values, ['info@acme.com', 'sales@acme.com']) // pat@ is not a role mailbox; other.com is off-site
})

test('extractContacts keeps person emails out of JSON-LD too (role mailboxes only)', () => {
  const html = `<script type="application/ld+json">{"@type":"Person","email":"pat.smith@acme.com"}</script>`
  assert.deepEqual(extractContacts(html, 'https://acme.com/about', 'acme.com'), [])
})

test('deobfuscation resolves multi-part subdomains to the full domain', () => {
  const html = `<p>Write to info at mail.acme dot com for details.</p>`
  const found = extractContacts(html, 'https://acme.com/contact', 'acme.com')
  assert.deepEqual(found.map(f => f.value), ['info@mail.acme.com'])
})

test('domain provenance: each accepted domain records how it was chosen and the exact page behind it; legacy rows are unrecorded', async () => {
  const { domainBasisFor, publishedContact, domainBasisNote, domainBasisUnconfirmed } = await import('../lib/outreach/published-email.ts')
  const db = new Database(':memory:'); migrateConnectors(db)
  db.exec("CREATE TABLE leads (id TEXT, scan_job_id TEXT, company TEXT, source_url TEXT, review_reason TEXT, confidence INTEGER, score INTEGER, company_domain TEXT)")
  db.prepare("INSERT INTO leads VALUES ('own','j1','Acme Robotics','https://acmerobotics.com/careers/1',NULL,90,90,NULL),('lab','j1','Beta Works','https://news.example/b',NULL,90,80,NULL),('txt','j1','Gamma Labs','https://news.example/c',NULL,90,70,NULL),('prb','j1','Stable','https://news.example/d',NULL,90,60,NULL)").run()
  const get: Get = async url => {
    const u = new URL(url)
    if (u.pathname === '/robots.txt') return { status: 200, body: '', finalUrl: url }
    if (u.hostname === 'acmerobotics.com') return { status: 200, body: html(u.pathname === '/' ? 'Acme Robotics home hello@acmerobotics.com' : 'job'), finalUrl: url }
    if (u.hostname === 'news.example' && u.pathname === '/b') return { status: 200, body: html('<a href="https://betaworks.io">x</a>'), finalUrl: url }
    if (u.hostname === 'news.example' && u.pathname === '/c') return { status: 200, body: html('<a href="https://somewhere.test/x">Gamma Labs profile</a>'), finalUrl: url }
    if (u.hostname === 'news.example') return { status: 200, body: html('no links'), finalUrl: url }
    if (u.hostname === 'betaworks.io' && u.pathname === '/') return { status: 200, body: html('Beta Works home info@betaworks.io'), finalUrl: url }
    // a different company that happens to say "stable": the homepage name check alone accepts it, so the basis must say name_probe
    if (u.hostname === 'stable.com' && u.pathname === '/') return { status: 200, body: html('Our horses are stable and calm. sales@stable.com'), finalUrl: url }
    if (u.hostname === 'somewhere.test' && u.pathname === '/') return { status: 200, body: html('Gamma Labs is listed here. info@somewhere.test'), finalUrl: url }
    return { status: 404, body: '', finalUrl: url }
  }
  await crawlJob(db, 't1', 'j1', { get, gapMs: 0, env: {}, now: Date.parse('2026-10-20T12:00:00Z') })
  const d = db.prepare("SELECT lead_id, value, source_url, label FROM lead_enrichments WHERE kind = 'domain' ORDER BY lead_id").all() as { lead_id: string; value: string; source_url: string; label: string }[]
  assert.deepEqual(d.map(x => [x.lead_id, x.value, x.label, x.source_url]), [
    ['lab', 'betaworks.io|evidence_link_domain_label', 'domain-basis-v1:evidence_link_domain_label', 'https://news.example/b'],
    ['own', 'acmerobotics.com|evidence_own_domain', 'domain-basis-v1:evidence_own_domain', 'https://acmerobotics.com/careers/1'],
    ['prb', 'stable.com|name_probe', 'domain-basis-v1:name_probe', 'https://stable.com/'],
    ['txt', 'somewhere.test|evidence_link_text', 'domain-basis-v1:evidence_link_text', 'https://news.example/c'],
  ])
  // a domain-only crawl is not a found contact: audit results count only real rows (tech/contacts), never the domain row
  assert.equal((db.prepare("SELECT results FROM connector_audit WHERE lookup = 'stable.com'").get() as { results: number }).results, 1, 'one email, and the domain row is not counted')
  const enrOf = (id: string) => db.prepare('SELECT connector, kind, value, label, source_url FROM lead_enrichments WHERE lead_id = ?').all(id) as never[]
  const basis = (id: string) => publishedContact({ contact: null, enrichments: enrOf(id) } as never)!
  assert.equal(basis('own').domainBasis, 'own_domain')
  assert.equal(basis('lab').domainBasis, 'linked')
  assert.equal(basis('txt').domainBasis, 'link_text_only')
  assert.equal(basis('prb').domainBasis, 'name_probe')
  assert.equal(domainBasisUnconfirmed(basis('prb').domainBasis) && domainBasisUnconfirmed(basis('txt').domainBasis), true)
  assert.equal(domainBasisUnconfirmed(basis('own').domainBasis) || domainBasisUnconfirmed(basis('lab').domainBasis), false)
  assert.match(String(domainBasisNote(basis('prb'))), /guessed from the company name/)
  assert.match(String(domainBasisNote(basis('txt'))), /link text only/)
  assert.ok(!/guessed/.test(String(domainBasisNote(basis('txt')))), 'a link-text site is never described as guessed')
  assert.equal(domainBasisNote(basis('own')), null)
  // a row crawled before provenance was recorded: no domain row, so 'unrecorded' (not trusted, not refused)
  const legacy = publishedContact({ contact: null, enrichments: [{ connector: 'sitecrawl', kind: 'email', value: 'info@old.example', label: null, source_url: 'https://old.example/contact' }] } as never)!
  assert.equal(legacy.domainBasis, 'unrecorded')
  assert.match(String(domainBasisNote(legacy)), /not recorded/)
  assert.equal(domainBasisFor('info@x.example', []).kind, 'unrecorded')
  // a contact printed on the cited page itself is not a crawled address
  assert.equal(publishedContact({ contact: 'a@b.example', source_url: 'https://b.example/p' } as never)!.domainBasis, 'cited_page')
})

test('two leads on one domain: each gets its own identity check, domain row and contact rows from one read of the site', async () => {
  const db = new Database(':memory:'); migrateConnectors(db)
  db.exec("CREATE TABLE leads (id TEXT, scan_job_id TEXT, company TEXT, source_url TEXT, review_reason TEXT, confidence INTEGER, score INTEGER, company_domain TEXT)")
  // l1 and l2 both name Acme (suffix variants collapse in the name test); l3 links the same domain but the homepage never names Gloom Labs.
  db.prepare("INSERT INTO leads VALUES ('l1','j1','Acme Roofing LLC','https://board.test/1',NULL,90,90,NULL),('l2','j1','Acme Roofing','https://board.test/2',NULL,90,80,NULL),('l3','j1','Gloom Labs','https://board.test/3',NULL,90,70,NULL)").run()
  const hits: string[] = []
  const get: Get = async url => {
    const u = new URL(url); hits.push(u.hostname + u.pathname)
    if (u.pathname === '/robots.txt') return { status: 200, body: '', finalUrl: url }
    if (u.hostname === 'board.test') return { status: 200, body: html('<a href="https://acmeroofing.test/">site</a>'), finalUrl: url }
    if (u.hostname === 'acmeroofing.test' && u.pathname === '/') return { status: 200, body: html('Acme Roofing LLC home <a href="/contact">Contact</a>'), finalUrl: url }
    if (u.hostname === 'acmeroofing.test' && u.pathname === '/contact') return { status: 200, body: html('<a href="mailto:info@acmeroofing.test">mail</a>'), finalUrl: url }
    return { status: 404, body: '', finalUrl: url }
  }
  // l3's evidence page links acmeroofing.test via its own label, which is "Gloom Labs" - so use text that names it.
  const get2: Get = async url => (new URL(url).pathname === '/3' && new URL(url).hostname === 'board.test') ? { status: 200, body: html('<a href="https://acmeroofing.test/">Gloom Labs</a>'), finalUrl: url } : get(url)
  await crawlJob(db, 't1', 'j1', { get: get2, gapMs: 0, env: {}, now: Date.parse('2026-10-20T12:00:00Z') })
  const rows = (id: string, kind: string) => db.prepare('SELECT value FROM lead_enrichments WHERE lead_id = ? AND kind = ?').all(id, kind).map(r => (r as { value: string }).value)
  assert.deepEqual(rows('l1', 'email'), ['info@acmeroofing.test'])
  assert.deepEqual(rows('l2', 'email'), ['info@acmeroofing.test'], 'the second lead on the same domain is not skipped')
  assert.equal(rows('l2', 'domain').length, 1)
  assert.deepEqual(rows('l3', 'email'), [], 'the homepage never names Gloom Labs: no rows for it')
  assert.deepEqual(rows('l3', 'domain'), [])
  assert.equal(hits.filter(h => h === 'acmeroofing.test/').length, 1, 'one homepage read for the whole run')
  assert.equal(hits.filter(h => h === 'acmeroofing.test/contact').length, 1, 'one contact page read for the whole run')
  assert.equal(hits.filter(h => h === 'acmeroofing.test/robots.txt').length, 1)
})

test('a lead whose name the homepage does not show cannot reuse a crawl; a later lead whose name it does show reads the site once more', async () => {
  const db = new Database(':memory:'); migrateConnectors(db)
  db.exec("CREATE TABLE leads (id TEXT, scan_job_id TEXT, company TEXT, source_url TEXT, review_reason TEXT, confidence INTEGER, score INTEGER, company_domain TEXT)")
  db.prepare("INSERT INTO leads VALUES ('a','j1','Gloom Labs','https://board.test/1',NULL,90,90,NULL),('b','j1','Acme Roofing','https://board.test/2',NULL,90,80,NULL)").run()
  const hits: string[] = []
  const get: Get = async url => {
    const u = new URL(url); hits.push(u.hostname + u.pathname)
    if (u.pathname === '/robots.txt') return { status: 200, body: '', finalUrl: url }
    if (u.hostname === 'board.test') return { status: 200, body: html('<a href="https://acmeroofing.test/">Gloom Labs and Acme Roofing</a>'), finalUrl: url }
    if (u.hostname === 'acmeroofing.test' && u.pathname === '/') return { status: 200, body: html('Acme Roofing home <a href="/contact">Contact</a>'), finalUrl: url }
    if (u.hostname === 'acmeroofing.test' && u.pathname === '/contact') return { status: 200, body: html('<a href="mailto:info@acmeroofing.test">mail</a>'), finalUrl: url }
    return { status: 404, body: '', finalUrl: url }
  }
  await crawlJob(db, 't1', 'j1', { get, gapMs: 0, env: {}, now: Date.parse('2026-10-20T12:00:00Z') })
  const emails = (id: string) => db.prepare("SELECT value FROM lead_enrichments WHERE lead_id = ? AND kind = 'email'").all(id).length
  assert.deepEqual([emails('a'), emails('b')], [0, 1])
  assert.equal(hits.filter(h => h === 'acmeroofing.test/').length, 2, 'the first read stopped at the identity check, so exactly one more read for the lead whose name matches')
})
