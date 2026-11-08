import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { crawlJob, crawlSite, type Get } from '../lib/connectors/sitecrawl.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'

// #871: the multi-page crawl is bounded by BOTH a page budget (MAX_PAGES) and an intrinsic wall-clock
// budget, and every page the crawl fetches is stored with its URL and fetch time.

const html = (s: string) => `<html><body>${s}</body></html>`

// More own-site links than MAX_PAGES (5), so neither bound is reached for lack of candidates.
const LINKED = ['/about', '/contact-us', '/team', '/careers', '/locations', '/pricing', '/faq', '/blog']
const homeBody = html(`Stabyl home ${LINKED.map(p => `<a href="${p}">x</a>`).join(' ')}`)

function sitePages(): Record<string, { body: string }> {
  const pages: Record<string, { body: string }> = { '/robots.txt': { body: '' }, '/': { body: homeBody } }
  for (const p of LINKED) pages[p] = { body: html('x') }
  return pages
}

test('crawlSite stops at the intrinsic time budget and names it', async () => {
  const pages = sitePages()
  const get: Get = async url => {
    const u = new URL(url)
    if (u.pathname !== '/robots.txt' && u.pathname !== '/') await new Promise(r => setTimeout(r, 120)) // a slow host on sub-pages
    const p = pages[u.pathname]
    return p ? { status: 200, body: p.body, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  // 300ms fits robots + home + about two 120ms sub-page reads, never all of them; MAX_PAGES (5 sub-pages) cannot fire first.
  const r = await crawlSite('stabyl-time.example', get, 0, undefined, false, undefined, undefined, undefined, 300)
  assert.equal(r.stoppedBy, 'time', 'the crawl names the time budget as its stop')
  assert.ok(r.pages < 6, `the time budget stopped the crawl before the page budget (${r.pages} pages)`)
})

test('crawlSite still stops at the page budget when time is not the binding constraint', async () => {
  const pages = sitePages()
  const get: Get = async url => {
    const u = new URL(url); const p = pages[u.pathname]
    return p ? { status: 200, body: p.body, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  const r = await crawlSite('stabyl-pages.example', get, 0, undefined, false, undefined, undefined, undefined, 60_000)
  assert.equal(r.stoppedBy, 'pages')
  assert.equal(r.pages, 5)
})

test('crawlJob stores every fetched page with its URL and fetch time, once', async () => {
  const db = new Database(':memory:'); migrateConnectors(db)
  db.exec('CREATE TABLE leads (id TEXT, scan_job_id TEXT, company TEXT, source_url TEXT, review_reason TEXT, confidence INTEGER, score INTEGER, company_domain TEXT)')
  db.prepare("INSERT INTO leads VALUES ('l1','j1','Stabyl','https://news.example/a',NULL,90,80,NULL)").run()
  const pages: Record<string, { body: string }> = {
    '/a': { body: html('<a href="https://stabyl.com">s</a>') },
    '/robots.txt': { body: '' }, '/': { body: html('Stabyl home <a href="/contact-us">c</a>') }, '/contact-us': { body: html('Email: hello@stabyl.com') },
  }
  const get: Get = async url => {
    const u = new URL(url); const p = pages[u.pathname]
    return p ? { status: 200, body: p.body, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  const now = Date.parse('2026-11-08T12:00:00Z')
  await crawlJob(db, 't1', 'j1', { get, gapMs: 0, env: {}, now })
  const at = Math.floor(now / 1000)
  assert.deepEqual(db.prepare('SELECT site, url, status, fetched_at FROM crawl_pages ORDER BY rowid').all(), [
    { site: 'stabyl.com', url: 'https://stabyl.com/', status: 200, fetched_at: at },
    { site: 'stabyl.com', url: 'https://stabyl.com/contact-us', status: 200, fetched_at: at },
  ], 'home and the contact page are recorded with exact URL and fetch time; the evidence fetch is not a crawl page')
  await crawlJob(db, 't1', 'j1', { get, gapMs: 0, env: {}, now })
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM crawl_pages').get() as { c: number }).c, 2, 'a re-run never duplicates the per-page record')
})
