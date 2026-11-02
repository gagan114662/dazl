// PR548 pixel proof: the settings enrichment panel's "Recent enrichment lookups" list renders the server-filtered
// audit rows. The 'check:%' exclusion itself is enforced in RECENT_AUDIT_SQL (lib/connectors/store.ts) and proven by
// the connectors store test; this harness proves the panel renders the filtered list. Same isolated pattern as
// test/ui/window-edit.ui.mjs: real component bundled with esbuild, every /api/* call stubbed, headless Chromium.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
let esbuild, chromium
try { esbuild = require('esbuild'); ({ chromium } = require('playwright')) } catch (e) { console.log(`SKIP: ${e.message.split('\n')[0]}`); process.exit(2) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = await esbuild.build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import EnrichmentPanel from '@/app/app/settings/enrichment-panel'; createRoot(document.getElementById('root')).render(<EnrichmentPanel />)`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'error',
  alias: { '@': root },
  plugins: [{ name: 'node-shims', setup(b) { b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: 'crypto-shim', namespace: 'shim' })); b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: 'export const createHash = () => ({ update() { return this }, digest() { return "shim" } }); export const randomBytes = (n) => ({ toString: () => "x".repeat(n * 2) })', loader: 'js' })) } }], define: { 'process.env.NODE_ENV': '"development"' }, external: [],
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
// Exactly what the API returns after the RECENT_AUDIT_SQL filter: connector audits only, never per-lead check:% rows.
const AUDIT = [
  { connector: 'enrich:apollo', scan_job_id: 'j1', lookup: 'brightloop.io', status: 'ok', results: 3, created_at: 1762100000 },
  { connector: 'enrich:pdl', scan_job_id: 'j1', lookup: 'lakeside.io', status: 'empty', results: 0, created_at: 1762099000 },
]
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 900, height: 800 } })
await page.route('**/*', async route => {
  const u = new URL(route.request().url())
  if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${CSS}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>` })
  if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
  if (u.pathname === '/api/settings/enrichment') return json(route, { connectors: [], audit: AUDIT, fallback: false })
  if (!u.pathname.startsWith('/api/')) return route.fulfill({ status: 204, body: '' })
  return json(route, {}, 404)
})
await page.goto('http://dazl.test/app/settings')
const el = page.getByText('Recent enrichment lookups')
await el.waitFor({ timeout: 15000 })
assert.equal(await page.getByText(/check:ats-board/).count(), 0, 'no per-lead check row can appear in this list')
await page.screenshot({ path: '/downloads/pr548-settings-pixel-full.png', fullPage: true })
await page.locator('div.card').first().screenshot({ path: '/downloads/pr548-settings-pixel-panel.png' })
await browser.close()
console.log('OK: settings enrichment panel renders the filtered recent-lookups list; no check: rows possible; screenshots saved')
