import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { detectTech } from '../lib/connectors/techstack.ts'
import { crawlSite, crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'

test('detectTech names only products the page itself loads or declares', () => {
  const shop = detectTech('<html><script src="https://cdn.shopify.com/s/x.js"></script><script src="https://js.stripe.com/v3/"></script></html>')
  assert.deepEqual(shop.map(t => t.name).sort(), ['Shopify', 'Stripe'])
  assert.ok(shop.every(t => t.where.length > 0))
  const wp = detectTech('<link href="https://a.com/wp-content/themes/x/style.css"><meta name="generator" content="WordPress 6.5">')
  assert.deepEqual(wp.map(t => t.name), ['WordPress'])
  const next = detectTech('<script id="__NEXT_DATA__" type="application/json">{}</script><script src="/_next/static/chunks/main.js"></script>')
  assert.deepEqual(next.map(t => t.name), ['Next.js'])
  const hs = detectTech('<script src="https://js.hs-scripts.net/12345.js"></script>')
  assert.deepEqual(hs.map(t => t.name), ['HubSpot'])
  // plain marketing HTML with lookalike words detects nothing
  assert.deepEqual(detectTech('<html><body>We love shops and stripes. Built with pride.</body></html>'), [])
  assert.deepEqual(detectTech(''), [])
})

const html = (s: string) => `<!doctype html><html><body>${s}</body></html>`

test('crawlSite reports the homepage stack alongside contacts', async () => {
  const pages: Record<string, { body: string }> = {
    '/robots.txt': { body: '' },
    '/': { body: html('Acme home <script src="https://widget.intercom.io/widget/abc"></script><a href="/contact">c</a>') },
    '/contact': { body: html('hello@acme.com') },
  }
  const get: Get = async url => { const u = new URL(url); const p = pages[u.pathname]; return p ? { status: 200, body: p.body, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  const r = await crawlSite('acme.com', get, 0)
  assert.equal(r.reason, 'ok')
  assert.deepEqual(r.tech?.map(t => t.name), ['Intercom'])
})

test('crawlJob stores tech hits as enrichments with the homepage as source', async () => {
  const db = new Database(':memory:'); migrateConnectors(db)
  db.exec("CREATE TABLE leads (id TEXT, scan_job_id TEXT, company TEXT, source_url TEXT, review_reason TEXT, confidence INTEGER, score INTEGER, company_domain TEXT)")
  db.prepare("INSERT INTO leads VALUES ('l1','j1','Stabyl','https://news.example/a',NULL,90,80,NULL)").run()
  const pages: Record<string, { body: string }> = {
    '/a': { body: html('<a href="https://stabyl.com">s</a>') },
    '/robots.txt': { body: '' },
    '/': { body: html('Stabyl home <script src="https://cdn.shopify.com/s/x.js"></script><script src="https://cdn.segment.com/analytics.js/v1/x"></script>') },
  }
  const get: Get = async url => { const u = new URL(url); const p = pages[u.pathname]; return p ? { status: 200, body: p.body, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 't1', 'j1', { get, gapMs: 0, env: {}, now: Date.parse('2026-10-20T12:00:00Z') })
  const rows = db.prepare("SELECT kind, value, label, source_url, source_date FROM lead_enrichments WHERE kind = 'tech' ORDER BY value").all() as { kind: string; value: string; label: string; source_url: string; source_date: string }[]
  assert.deepEqual(rows.map(r => r.value), ['Segment', 'Shopify'])
  assert.ok(rows.every(r => r.source_url === 'https://stabyl.com/' && r.source_date === '2026-10-20' && r.label.includes('seen on the company website')))
})
