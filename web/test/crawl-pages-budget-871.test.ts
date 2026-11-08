import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { crawlJob, crawlSite, type Get } from '../lib/connectors/sitecrawl.ts'
import { migrateConnectors, recordCrawlPage } from '../lib/connectors/store.ts'

// #871: the multi-page crawl is bounded by BOTH a page budget (MAX_PAGES) and an intrinsic wall-clock
// budget that covers robots, the homepage, every polite wait, every own-site page and the social branch;
// every page the crawl fetches is stored with its exact URL and that page's own fetch time.

const html = (s: string) => `<html><body>${s}</body></html>`
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

// More own-site links than MAX_PAGES (5), so neither bound is reached for lack of candidates.
const LINKED = ['/about', '/contact-us', '/team', '/careers', '/locations', '/pricing', '/faq', '/blog']
const homeBody = html(`Stabyl home ${LINKED.map(p => `<a href="${p}">x</a>`).join(' ')}`)

function sitePages(): Record<string, { body: string }> {
  const pages: Record<string, { body: string }> = { '/robots.txt': { body: '' }, '/': { body: homeBody } }
  for (const p of LINKED) pages[p] = { body: html('x') }
  return pages
}
const serve = (pages: Record<string, { body: string }>, slow: (path: string) => number = () => 0, calls?: string[]): Get => async url => {
  const u = new URL(url); calls?.push(url)
  const ms = slow(u.pathname); if (ms > 0) await wait(ms)
  const p = pages[u.pathname]
  return p ? { status: 200, body: p.body, finalUrl: url } : { status: 404, body: '', finalUrl: url }
}

test('crawlSite stops at the intrinsic time budget and names it', async () => {
  const r = await crawlSite('stabyl-time.example', serve(sitePages(), p => (p === '/robots.txt' || p === '/') ? 0 : 120), 0, undefined, false, undefined, undefined, undefined, 300)
  assert.equal(r.stoppedBy, 'time', 'the crawl names the time budget as its stop')
  assert.ok(r.pages < 6, `the time budget stopped the crawl before the page budget (${r.pages} pages)`)
})

test('crawlSite still stops at the page budget when time is not the binding constraint', async () => {
  const r = await crawlSite('stabyl-pages.example', serve(sitePages()), 0, undefined, false, undefined, undefined, undefined, 60_000)
  assert.equal(r.stoppedBy, 'pages')
  assert.equal(r.pages, 5)
})

test('the budget bounds robots and the homepage: a fetch never starts after it, an in-flight fetch is cut at it', async () => {
  const calls: string[] = []
  // robots alone takes 80ms against a 25ms budget: the homepage must never be fetched.
  const r = await crawlSite('stabyl-robots.example', serve(sitePages(), p => p === '/robots.txt' ? 80 : 0, calls), 0, undefined, false, undefined, undefined, undefined, 25)
  assert.deepEqual(calls.map(u => new URL(u).pathname), ['/robots.txt'], 'no fetch starts after the budget is spent')
  assert.equal(r.reason, 'time_budget')
  assert.equal(r.stoppedBy, 'time')
  assert.equal(r.pages, 0)
})

test('the budget bounds the polite per-host gap: a gap that would outlive it is not waited out', async () => {
  const calls: string[] = []
  // gap 80ms, budget 110ms: after robots+home the next page's gap would cross the deadline, so no subpage starts.
  const r = await crawlSite('stabyl-gap.example', serve(sitePages(), () => 0, calls), 80, undefined, false, undefined, undefined, undefined, 110)
  assert.deepEqual(calls.map(u => new URL(u).pathname), ['/robots.txt', '/'], 'no subpage fetch starts once the remaining budget is inside the gap')
  assert.equal(r.stoppedBy, 'time')
})

test('the budget bounds the social branch too', async () => {
  const calls: string[] = []
  const pages: Record<string, { body: string }> = { '/robots.txt': { body: '' }, '/': { body: '<body>Acme <a href="https://twitter.com/acme">social</a></body>' } }
  // homepage takes 60ms against a 20ms budget: cut at the budget, the social branch never runs.
  const r = await crawlSite('stabyl-social.example', serve(pages, p => p === '/' ? 60 : 0, calls), 0, undefined, true, undefined, undefined, undefined, 20)
  assert.equal(r.stoppedBy, 'time')
  assert.equal(r.reason, 'time_budget')
  assert.ok(!calls.some(u => u.includes('twitter.com')), 'no social request happens after the budget')
})

test('recordCrawlPage stores the exact URL or refuses it: no truncation, no aliasing', () => {
  const db = new Database(':memory:'); migrateConnectors(db)
  const prefix = 'https://example.test/' + 'a'.repeat(490)
  assert.equal(recordCrawlPage(db, 'A', 'j', 'example.test', prefix + 'one', 200, 1), false, 'over-bound URL refused, not sliced')
  assert.equal(recordCrawlPage(db, 'A', 'j', 'example.test', prefix + 'two', 200, 2), false, 'a second distinct over-bound URL refused too')
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM crawl_pages').get() as { c: number }).c, 0, 'distinct pages are never aliased into one row')
  const exact = 'https://example.test/' + 'a'.repeat(480) // 501 -> over; trim to exactly fit
  const fits = exact.slice(0, 499)
  assert.equal(recordCrawlPage(db, 'A', 'j', 'example.test', fits, 200, 3), true)
  assert.deepEqual(db.prepare('SELECT url, status, fetched_at FROM crawl_pages').all(), [{ url: fits, status: 200, fetched_at: 3 }], 'the stored URL is the exact fetched URL')
})

test('crawlJob stores every fetched page with its exact URL and that page’s own fetch time, once', async () => {
  const db = new Database(':memory:'); migrateConnectors(db)
  db.exec('CREATE TABLE leads (id TEXT, scan_job_id TEXT, company TEXT, source_url TEXT, review_reason TEXT, confidence INTEGER, score INTEGER, company_domain TEXT)')
  db.prepare("INSERT INTO leads VALUES ('l1','j1','Stabyl','https://news.example/a',NULL,90,80,NULL)").run()
  const pages: Record<string, { body: string }> = {
    '/a': { body: html('<a href="https://stabyl-pages-own.example">s</a>') },
    '/robots.txt': { body: '' }, '/': { body: html('Stabyl home <a href="/contact-us">c</a>') }, '/contact-us': { body: html('Email: hello@stabyl.com') },
  }
  // The contact page answers 1.6s after the homepage: the two pages must carry DIFFERENT fetch times.
  const get = serve(pages, p => p === '/contact-us' ? 1600 : 0)
  const before = Math.floor(Date.now() / 1000) - 1
  await crawlJob(db, 't1', 'j1', { get, gapMs: 0, env: {} })
  const rows = db.prepare('SELECT site, url, status, fetched_at FROM crawl_pages ORDER BY fetched_at, rowid').all() as { site: string; url: string; status: number; fetched_at: number }[]
  assert.deepEqual(rows.map(r => [r.site, r.url, r.status]), [
    ['stabyl-pages-own.example', 'https://stabyl-pages-own.example/', 200],
    ['stabyl-pages-own.example', 'https://stabyl-pages-own.example/contact-us', 200],
  ], 'home and the contact page are recorded with exact URLs; the evidence fetch is not a crawl page')
  assert.ok(rows[0].fetched_at >= before && rows[1].fetched_at > rows[0].fetched_at, `each page carries its own completion time (${rows[0].fetched_at} < ${rows[1].fetched_at})`)
  await crawlJob(db, 't1', 'j1', { get, gapMs: 0, env: {} })
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM crawl_pages').get() as { c: number }).c, 2, 'a re-run never duplicates the per-page record')
})

test('a time-stopped crawl writes its fetched pages but NO derived rows (partial read never looks complete)', async () => {
  const db = new Database(':memory:'); migrateConnectors(db)
  db.exec('CREATE TABLE leads (id TEXT, scan_job_id TEXT, company TEXT, source_url TEXT, review_reason TEXT, confidence INTEGER, score INTEGER, company_domain TEXT)')
  db.prepare("INSERT INTO leads VALUES ('l1','j1','Stabyl','https://news.example/a',NULL,90,80,NULL)").run()
  const pages: Record<string, { body: string }> = {
    '/a': { body: html('<a href="https://stabyl-partial.example">s</a>') },
    '/robots.txt': { body: '' }, '/': { body: html('Stabyl home <a href="/contact-us">c</a>') }, '/contact-us': { body: html('Email: hello@stabyl.com') },
  }
  // A contact page that never answers inside the crawl budget: the read is partial.
  const get: Get = async url => {
    const u = new URL(url)
    if (u.pathname === '/contact-us') await wait(1200)
    const p = pages[u.pathname]
    return p ? { status: 200, body: p.body, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  await crawlJob(db, 't1', 'j1', { get, gapMs: 0, env: { SITECRAWL_CRAWL_BUDGET_MS: '150' } })
  assert.ok((db.prepare('SELECT COUNT(*) AS c FROM crawl_pages').get() as { c: number }).c >= 1, 'the homepage fetch is a recorded fact')
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM lead_enrichments WHERE tenant_id = 't1'").get() as { c: number }).c, 0, 'no derived enrichment rows from a partial read')
  assert.equal((db.prepare("SELECT company_domain FROM leads WHERE id = 'l1'").get() as { company_domain: string | null }).company_domain, null, 'no domain confirmation from a partial read')
})
