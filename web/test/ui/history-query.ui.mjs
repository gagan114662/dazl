// Rendered check, fully stubbed (no server, db, network or key). Run: cd web && NODE_PATH=<dir with esbuild and playwright> node test/ui/history-query.ui.mjs
// Live acceptance finding: opening the NYC scan from history left the LAST (London) query in the top input while showing the
// NYC profile and results. The input must show the query of the scan being viewed. SKIP (exit 0) without esbuild/playwright.
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
const NYC = 'Find independent NYC dental practices that opened in the past 90 days'
const LONDON = 'Find London seed-funded companies hiring sales'
const ICP = { summary: 'NYC dental practices', who: ['Practice manager'], industries: [], sizes: [], where: ['New York'], signals: [], exclude: [], window_days: 90 }
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const calls = []
const browser = await chromium.launch(); const page = await browser.newPage()
await page.route('**/*', async route => {
  const u = new URL(route.request().url()); const m = route.request().method()
  if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>' })
  if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
  if (!u.pathname.startsWith('/api/')) return route.fulfill({ status: 204, body: '' })
  calls.push(`${m} ${u.pathname}`)
  if (u.pathname === '/api/scan/status') return json(route, { status: 'done', lead_count: 0, query: NYC, icp: ICP, icp_source: 'user', attempts: 1, max_attempts: 3 })
  if (u.pathname === '/api/leads') return json(route, { leads: [], hidden_count: 0 })
  if (u.pathname === '/api/scan/latest') return json(route, { query: LONDON, icp: { ...ICP, summary: 'London seed companies', where: ['London'] }, icp_source: 'user' })
  if (u.pathname === '/api/scan/jobs') return json(route, { jobs: [] })
  return json(route, {}, 404)
})
await page.goto(`http://dazl.test/app/leads?job_id=${'c'.repeat(24)}`)
await page.getByText(/Profile used: NYC dental practices/).waitFor({ timeout: 10000 })
await page.waitForTimeout(500)
const value = await page.locator('textarea').first().inputValue()
assert.equal(value, NYC, `the top input must show the viewed scan's query, saw ${JSON.stringify(value)}`)
assert.deepEqual(calls.filter(c => !c.startsWith('GET')), [], 'viewing a past scan starts nothing')
await browser.close()
console.log('OK: viewing a past scan shows that scan\'s query in the input (all calls stubbed, nothing started)')
