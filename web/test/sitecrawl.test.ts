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

test('crawlJob stores each contact with its source page and date, once per site', async () => {
  const db = new Database(':memory:'); migrateConnectors(db)
  db.exec("CREATE TABLE leads (id TEXT, scan_job_id TEXT, company TEXT, source_url TEXT, review_reason TEXT, confidence INTEGER, score INTEGER, company_domain TEXT)")
  db.prepare("INSERT INTO leads VALUES ('l1','j1','Stabyl','https://news.example/a',NULL,90,80,NULL),('l2','j1','Stabyl','https://news.example/b',NULL,90,70,NULL),('l3','j1','NoSite Ltd','https://news.example/c',NULL,90,60,NULL)").run()
  const pages: Record<string, { body: string }> = {
    '/a': { body: html('<a href="https://stabyl.com">s</a>') }, '/b': { body: html('<a href="https://stabyl.com">s</a>') }, '/c': { body: html('nothing') },
    '/robots.txt': { body: '' }, '/': { body: html('Stabyl home <a href="/contact-us">c</a>') }, '/contact-us': { body: html('Email: hello@stabyl.com') },
  }
  const get: Get = async url => { const u = new URL(url); const p = pages[u.pathname]; return p ? { status: 200, body: p.body, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 't1', 'j1', { get, gapMs: 0, env: {}, now: Date.parse('2026-10-20T12:00:00Z') })
  const rows = db.prepare('SELECT lead_id, kind, value, source_url, source_date, connector FROM lead_enrichments').all()
  assert.deepEqual(rows, [{ lead_id: 'l1', kind: 'email', value: 'hello@stabyl.com', source_url: 'https://stabyl.com/contact-us', source_date: '2026-10-20', connector: 'sitecrawl' }])
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
  assert.equal((db.prepare("SELECT value FROM lead_enrichments WHERE lead_id = 'l1'").get() as { value: string }).value, 'hello@acmerobotics.com')
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
