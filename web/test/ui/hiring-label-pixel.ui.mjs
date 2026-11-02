// PR548 pixel proof: the aggregate hiring label renders the honest sample/cap disclosure
// ("3 of 4 dated shown; 42 listed titles, sample capped at 50") instead of "(+M more)".
// Same isolated pattern as test/ui/window-edit.ui.mjs: real LeadsClient bundled with esbuild,
// every /api/* call stubbed, headless Chromium screenshot. No server, no DB, no network, no scan.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
let esbuild, chromium
try { esbuild = require('esbuild'); ({ chromium } = require('playwright')) } catch (e) { console.log(`SKIP: ${e.message.split('\n')[0]}`); process.exit(2) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
process.chdir(root)
const rootWeb = root
const bundle = await esbuild.build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import LeadsClient from '@/app/app/leads/leads-client'; createRoot(document.getElementById('root')).render(<LeadsClient />)`, resolveDir: rootWeb, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'error',
  alias: { '@': rootWeb },
  plugins: [{ name: 'node-shims', setup(b) { b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: 'crypto-shim', namespace: 'shim' })); b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: 'export const createHash = () => ({ update() { return this }, digest() { return \"shim\" } }); export const randomBytes = (n) => ({ toString: () => \"x\".repeat(n * 2) })', loader: 'js' })) } }], define: { 'process.env.NODE_ENV': '"development"' }, external: [],
})
// Real app styles: compile globals.css with the repo's own Tailwind v4 (candidates scanned from app/), inline <style>.
import fs from 'node:fs'
const tw = require('tailwindcss')
const twc = await tw.compile(fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8'), { base: root, onDependency: () => {}, loadStylesheet: async (id, base) => {
  const p = id === 'tailwindcss' ? require.resolve('tailwindcss/index.css') : require.resolve(id, { paths: [base] })
  return { content: fs.readFileSync(p, 'utf8'), path: p, base: path.dirname(p) }
} })
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : [])
const toks = new Set()
for (const f of walk(path.join(root, 'app'))) { const src = fs.readFileSync(f, 'utf8'); for (const m of src.matchAll(/className="([^"]+)"|className=\{?['`]([^'`]+)['`]/g)) for (const tok of (m[1] || m[2] || '').split(/\s+/)) if (tok && !tok.includes('${')) toks.add(tok) }
const CSS = twc.build([...toks])
const js = bundle.outputFiles[0].text
const JOB = 'a'.repeat(24)
const LABEL = 'Account Executive; Sales Manager; SDR (3 of 4+ dated shown; 63 listed titles, sample capped at 50)' // a REAL truncation: 63 listed, 50 sampled; 4+ dated (detail cap 4 hit) - never a masked total
const lead = { id: 'l1', name: '', company: 'Brightloop', contact: null, signal: 'Brightloop raised a seed round', source_url: 'https://news.example/1', score: 80, evidence_excerpt: 'Brightloop raised a seed round', event_date: '2026-10-12', date_status: 'unverified', confidence: 80, review_reason: null, company_domain: 'brightloop.io', human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 3, action: 3, why: 'Hiring sales: Account Executive posted 2026-10-16 on its Greenhouse job board (brightloop.io). Seed-funded London SaaS.', signals: null, icp_match: null, events: [],
  enrichments: [
    { connector: 'signals:greenhouse-gtm', kind: 'hiring', value: '4+ sales/GTM roles posted, newest 2026-10-16', label: LABEL, confidence: 70, source_url: 'https://boards.greenhouse.io/brightloop', source_date: '2026-10-16' },
    { connector: 'signals:greenhouse-gtm', kind: 'hiring-role', value: 'Account Executive - posted 2026-10-16', label: 'London, UK', confidence: 70, source_url: 'https://boards.greenhouse.io/brightloop/jobs/1', source_date: '2026-10-16' },
  ] }
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })

await page.route('**/*', async route => {
  const u = new URL(route.request().url())
  if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${CSS}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>` })
  if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
  if (!u.pathname.startsWith('/api/')) return route.fulfill({ status: 204, body: '' })
  if (u.pathname === '/api/scan/status') return json(route, { status: 'done', lead_count: 1, icp: { summary: 'B2B SaaS', who: ['Founder'], industries: [], sizes: [], where: ['London'], signals: ['hiring sales staff'], exclude: [] }, icp_source: 'user', attempts: 1, max_attempts: 3 })
  if (u.pathname === '/api/leads') return json(route, { job_id: JOB, status: 'done', hidden_count: 0, leads: [lead] })
  if (u.pathname === '/api/scan/jobs') return json(route, { jobs: [] })
  return json(route, {}, 404)
})
await page.goto(`http://dazl.test/app/leads?job_id=${JOB}`)

await page.getByText('Details', { exact: true }).first().click() // enrichment rows render inside the card's Details disclosure
const el = page.getByText(/3 of 4\+ dated shown; 63 listed titles, sample capped at 50/)
await el.waitFor({ timeout: 15000 })
assert.ok(!(await page.getByText(/\(\+\d+ more\)/).count()), 'no bare (+M more) label remains')
await page.getByText(/4\+ sales\/GTM roles posted/).waitFor()
await page.screenshot({ path: '/downloads/pr548-label-pixel-full.png', fullPage: true })
await el.first().screenshot({ path: '/downloads/pr548-label-pixel-row.png' })
await browser.close()
console.log('OK: aggregate label renders the dated-shown/listed-total/cap disclosure; no (+M more); screenshots saved')
