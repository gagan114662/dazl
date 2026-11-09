// #878 pixel proof: each request-condition row on a lead card says the evidence date THAT condition was checked on, or that it has
// none ("checked <day>"), instead of "seen <day>" for every clause. Same isolated pattern as test/ui/hiring-label-pixel.ui.mjs: the
// real LeadsClient bundled with esbuild, every /api/* call stubbed, headless Chromium at 1280 and 390 px. No server, DB, network or scan.
// Run: node test/ui/targeting-clause-date.ui.mjs   (SHOTS=<dir> to keep screenshots; default: no files written)
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
let esbuild, chromium
try { esbuild = require('esbuild'); ({ chromium } = require('playwright')) } catch (e) { console.log(`SKIP: ${e.message.split('\n')[0]}`); process.exit(2) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
process.chdir(root)
const bundle = await esbuild.build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import LeadsClient from '@/app/app/leads/leads-client'; createRoot(document.getElementById('root')).render(<LeadsClient />)`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'error',
  alias: { '@': root },
  plugins: [{ name: 'node-shims', setup(b) { b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: 'crypto-shim', namespace: 'shim' })); b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: 'export const createHash = () => ({ update() { return this }, digest() { return "shim" } }); export const randomBytes = (n) => ({ toString: () => "x".repeat(n * 2) })', loader: 'js' })) } }], define: { 'process.env.NODE_ENV': '"development"' }, external: [],
})
// Real app styles: compile globals.css with the repo's own Tailwind v4 (candidates scanned from app/), inline <style>.
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
const JOB = 'b'.repeat(24)
// The three row shapes recordActionability can leave: a clause proven on a dated source, a clause with no evidence date of its own, and
// a row written before #878 (no date suffix): the card must not call the check day an evidence date for the last two.
const T = 'scan:targeting'
const lead = { id: 'l1', name: '', company: 'Brightloop', contact: null, signal: 'Brightloop raised a seed round', source_url: 'https://news.example/1', score: 80, evidence_excerpt: 'Brightloop raised a 3m seed round and hired its first VP of Sales.', event_date: '2026-10-20', date_status: 'verified', confidence: 80, review_reason: null, company_domain: 'brightloop.example', human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 3, action: 3, why: 'Seed round dated 2026-10-20.', signals: null, icp_match: null, events: [],
  enrichments: [
    { connector: T, kind: 'targeting_clause', value: 'C1 raised seed funding within 90 days, specifically within 30 days: pass, evidence dated 2026-10-20', label: 'the verified source quote shows a completed seed raise by this company, dated 2026-10-20 (within 30 days)', confidence: null, source_url: 'https://news.example/1', source_date: '2026-10-20' },
    { connector: T, kind: 'targeting_clause', value: 'C2 hired a VP within 20 days: unknown, no evidence date', label: 'no verified source shows this company made a VP hire', confidence: null, source_url: 'https://invalid.example/', source_date: '2026-11-09' },
    { connector: T, kind: 'targeting_clause', value: 'C3 hiring SDRs: unknown', label: 'no dated posting or verified quote shows this company hiring SDRs', confidence: null, source_url: 'https://invalid.example/', source_date: '2026-11-08' },
  ] }
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const SHOTS = process.env.SHOTS
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
const browser = await chromium.launch()
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } })
    await page.route('**/*', async route => {
      const u = new URL(route.request().url())
      if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>` })
      if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
      if (!u.pathname.startsWith('/api/')) return route.fulfill({ status: 204, body: '' })
      if (u.pathname === '/api/scan/status') return json(route, { status: 'done', lead_count: 1, icp: { summary: 'B2B SaaS', who: ['Founder'], industries: [], sizes: [], where: ['London'], signals: ['raised seed funding'], exclude: [] }, icp_source: 'user', attempts: 1, max_attempts: 3 })
      if (u.pathname === '/api/leads') return json(route, { job_id: JOB, status: 'done', hidden_count: 0, leads: [lead] })
      if (u.pathname === '/api/scan/jobs') return json(route, { jobs: [] })
      return json(route, {}, 404)
    })
    await page.goto(`http://dazl.test/app/leads?job_id=${JOB}`)
    await page.getByText('Details', { exact: true }).first().click() // enrichment rows render inside the card's Details disclosure
    const row = (re) => page.locator('div.text-gray-400', { hasText: re }).last() // one enrichment row (the innermost matching row div)
    const dated = row(/C1 raised seed funding/), undated = row(/C2 hired a VP/), legacy = row(/C3 hiring SDRs/)
    await dated.waitFor({ timeout: 15000 })
    const [a, b, c] = [await dated.innerText(), await undated.innerText(), await legacy.innerText()]
    assert.match(a, /: pass, evidence dated 2026-10-20/, `${width}: the proven clause shows its own evidence date`); assert.match(a, /dated by its own source/)
    assert.match(b, /no evidence date/); assert.match(b, /checked 2026-11-09/, `${width}: an undated clause shows the check day as a check`)
    assert.match(c, /recorded 2026-11-08 \(an older check: evidence date not stated\)/, `${width}: a pre-#878 row is not read as an evidence date`)
    for (const t of [a, b, c]) assert.doesNotMatch(t, /\bseen 20\d\d-/, `${width}: no clause row says "seen <day>"`)
    if (SHOTS) {
      await dated.locator('xpath=..').screenshot({ path: path.join(SHOTS, `targeting-clause-date-${width}.png`) })
      await page.screenshot({ path: path.join(SHOTS, `targeting-clause-date-${width}-page.png`) })
    }
    await page.close()
  }
} finally { await browser.close() }
console.log('OK: each request-condition row shows its own evidence date, "checked <day>" when it has none, and an older row is not read as dated (1280 and 390 px)')
