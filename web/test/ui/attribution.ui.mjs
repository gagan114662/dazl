// Rendered check, fully stubbed (no server, db, network or key). Run: cd web && NODE_PATH=<dir with esbuild and playwright> node test/ui/attribution.ui.mjs
// GDELT's terms require a citation AND a link wherever its results are shown. Real LeadsClient, both lanes: a listed lead
// and a "Needs your review" lead (stale/undated/blocked rows are still displayed data) each show it; a lead GDELT did not
// surface shows nothing. SKIP (exit 0) without esbuild/playwright.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
let esbuild, chromium
try { esbuild = require('esbuild'); ({ chromium } = require('playwright')) } catch (e) { console.log(`SKIP: ${e.message.split('\n')[0]}`); process.exit(0) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = await esbuild.build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import LeadsClient from '@/app/app/leads/leads-client'; createRoot(document.getElementById('root')).render(<LeadsClient />)`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'error', alias: { '@': root }, define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'node-shims', setup(b) { b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: 'crypto-shim', namespace: 'shim' })); b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: 'export const createHash = () => ({ update() { return this }, digest() { return "shim" } })', loader: 'js' })) } }],
})
const js = bundle.outputFiles[0].text
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const ICP = { summary: 'Toronto dental practices', who: ['Practice owner'], industries: [], sizes: [], where: ['Toronto'], signals: [], exclude: [] }
const VIA = { discovered_via: 'Found through the GDELT Project', discovered_via_link: 'https://www.gdeltproject.org/' }
const lead = (id, company, extra) => ({ id, name: '', company, contact: null, signal: `${company} opened a clinic`, source_url: `https://news.example/${id}`, score: 70, evidence_excerpt: `${company} opened a clinic`, event_date: '2026-10-10', date_status: 'unverified', confidence: 90, review_reason: null, company_domain: null, human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 0, action: 0, why: null, signals: null, icp_match: null, enrichments: [], events: [], ...extra })
const leads = [
  lead('listed1', 'Listed Dental', VIA),
  lead('review1', 'Review Dental', { ...VIA, review_reason: 'outside_window', confidence: null, event_date: '2026-01-02' }),
  lead('review2', 'Plain Review Dental', { review_reason: 'quote_unconfirmed', confidence: null }),
]
const browser = await chromium.launch(); const page = await browser.newPage()
await page.route('**/*', async route => {
  const u = new URL(route.request().url())
  if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>' })
  if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
  if (!u.pathname.startsWith('/api/')) return route.fulfill({ status: 204, body: '' })
  if (u.pathname === '/api/scan/status') return json(route, { status: 'done', lead_count: 3, query: 'Toronto dental', icp: ICP, icp_source: 'user', attempts: 1, max_attempts: 3 })
  if (u.pathname === '/api/leads') return json(route, { leads, hidden_count: 0 })
  if (u.pathname === '/api/scan/jobs') return json(route, { jobs: [] })
  return json(route, {}, 404)
})
await page.goto(`http://dazl.test/app/leads?job_id=${'d'.repeat(24)}`)
await page.getByText('Needs your review').waitFor({ timeout: 10000 })
await page.getByText('Listed Dental').first().waitFor()
const all = page.getByTestId('discovered-via')
assert.equal(await all.count(), 2, 'exactly the two GDELT-surfaced leads carry the citation (listed + review lane)')
for (const company of ['Listed Dental', 'Review Dental']) {
  const row = page.locator('div', { hasText: company }).filter({ has: page.getByTestId('discovered-via') }).last()
  assert.match(await row.getByTestId('discovered-via').innerText(), /Found through the GDELT Project \(gdeltproject\.org\)/, company)
  assert.equal(await row.getByTestId('discovered-via').locator('a').getAttribute('href'), 'https://www.gdeltproject.org/', company)
}
const plain = page.locator('div.p-4', { hasText: 'Plain Review Dental' })
assert.equal(await plain.getByTestId('discovered-via').count(), 0, 'a lead GDELT did not surface shows no citation')
// the review-lane citation is inside the "Needs your review" section, not the listed section
const reviewSection = page.locator('div.card.divide-y', { hasText: 'Review Dental' })
assert.ok(await reviewSection.getByTestId('discovered-via').count() >= 1)
await browser.close()
console.log('OK: GDELT citation + link shown in both lanes; none on a lead GDELT did not surface (all calls stubbed)')
