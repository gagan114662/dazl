// #917 rendered check: a profile the scan would have to cut (here a 7th exclusion) is refused with plain wording and the draft stays open.
// NOT part of `npm test` (needs a browser). Run:  cd web && node test/ui/lossy-profile.ui.mjs   (SHOTS=<dir> saves 390 and 1280 px screenshots)
// Like window-edit.ui.mjs it bundles the real LeadsClient, renders it in headless Chromium and ANSWERS EVERY /api/* CALL FROM A STUB (no server,
// no database, no network, no key, no provider call). It proves, on the rendered page: after Run with a 7-exclusion draft the message reads
// "exclude: 7 entries, the limit is 6. Remove 1.", the raw code profile_lossy never shows, the editor with the draft is still open, nothing
// is started (no POST /api/scan), and a draft at the limit gets past the refusal to the price estimate.
// Exit 1 on a failed expectation; "SKIP" (exit 0) when esbuild/playwright/chromium are not installed.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
let esbuild, chromium
try { esbuild = require('esbuild'); ({ chromium } = require('playwright')) } catch (e) { console.log(`SKIP: ${e.message.split('\n')[0]} (set NODE_PATH to a folder with esbuild and playwright)`); process.exit(0) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const bundle = await esbuild.build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import LeadsClient from '@/app/app/leads/leads-client'; createRoot(document.getElementById('root')).render(<LeadsClient />)`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'error',
  alias: { '@': root },
  // node:crypto is only used by the draft-review binding hash, which this check never exercises: a browser shim keeps the bundle self-contained.
  plugins: [{ name: 'node-shims', setup(b) { b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: 'crypto-shim', namespace: 'shim' })); b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: 'export const createHash = () => ({ update() { return this }, digest() { return "shim" } }); export const randomBytes = () => { throw new Error("crypto-shim: randomBytes must never execute in a browser fixture - bundling only") }', loader: 'js' })) } }], define: { 'process.env.NODE_ENV': '"development"' }, external: [],
})
const js = bundle.outputFiles[0].text

const JOB = 'a'.repeat(24)
const day = n => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const EXCL7 = ['chains', 'software vendors', 'franchises', 'government', 'nonprofits', 'agencies', 'healthcare']
const mkIcp = exclude => ({ summary: 'Dental practices', who: ['Practice owner'], industries: ['dental'], sizes: [], where: ['Ohio'], signals: ['new location'], exclude, window_days: 90 })
const lead = (id, company, event_date) => ({ id, name: '', company, contact: null, signal: `${company} opened a clinic`, source_url: `https://news.example/${id}`, score: 70, evidence_excerpt: `${company} opened a clinic`, event_date, date_status: 'unverified', fit: null })
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {})  // PW_CHROME: an already-installed chrome-headless-shell, when Playwright's pinned build is absent

async function open(size, exclude, estimate) {
  const page = await browser.newPage({ viewport: size })
  const calls = []
  await page.route('**/*', async route => {
    const u = new URL(route.request().url()); const m = route.request().method()
    if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>` })
    if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
    if (!u.pathname.startsWith('/api/')) return route.fulfill({ status: 204, body: '' })
    calls.push(`${m} ${u.pathname}`)
    if (u.pathname === '/api/scan/estimate' && m === 'POST') return estimate(route)
    if (u.pathname === '/api/scan/status') return json(route, { status: 'done', lead_count: 2, query: 'Dental practices in Ohio that opened a new location. We sell dental appointment software.', icp: mkIcp(exclude), icp_source: 'user', attempts: 1, max_attempts: 3 })
    if (u.pathname === '/api/leads') return json(route, { job_id: JOB, status: 'done', hidden_count: 0, leads: [lead('l1', 'Old Dental', day(-200)), lead('l2', 'Older Dental', day(-300))] })
    if (u.pathname === '/api/scan/jobs') return json(route, { jobs: [] })
    return json(route, {}, 404)
  })
  await page.goto(`http://dazl.test/app/leads?job_id=${JOB}`)
  await page.getByRole('button', { name: 'Edit window to 180 days' }).click()
  await page.getByText(/Nothing runs until you press run/).waitFor({ timeout: 10000 })
  await page.getByLabel('What you sell for this play').fill('Dental appointment software')
  return { page, calls }
}

for (const [label, size] of [['1280', { width: 1280, height: 900 }], ['390', { width: 390, height: 844 }]]) {
  // 7 exclusions: refused with the plain wording; the draft stays open; nothing started
  const lossy = route => json(route, { error: 'profile_lossy', message: 'Part of this profile would be cut or ignored, so nothing was started.', loss: [{ field: 'exclude', kind: 'too_many_items', limit: 6, actual: 7 }] }, 400)
  const a = await open(size, EXCL7, lossy)
  await a.page.getByRole('button', { name: 'Run scan with this profile' }).first().click()
  const msg = a.page.getByText(/exclude: 7 entries, the limit is 6\. Remove 1\./)
  await msg.waitFor({ timeout: 10000 })
  assert.ok(await msg.isVisible(), `${label}: the refusal is visible`)
  assert.equal(await a.page.getByText('profile_lossy').count(), 0, `${label}: the raw code never shows`)
  assert.ok(await a.page.getByRole('button', { name: 'Run scan with this profile' }).first().isVisible(), `${label}: the draft editor is still open`)
  assert.equal(a.calls.filter(c => c === 'POST /api/scan').length, 0, `${label}: no scan was started`)
  assert.equal(a.calls.filter(c => c === 'POST /api/scan/estimate').length, 1, `${label}: one estimate request, then the refusal`)
  await msg.scrollIntoViewIfNeeded()
  if (process.env.SHOTS) await a.page.screenshot({ path: path.join(process.env.SHOTS, `lossy-profile-${label}.png`), fullPage: false })
  await a.page.close()
  // a draft at the limit (6 exclusions) passes the refusal and reaches the price estimate
  const ok = route => json(route, { estimate: { rows: [], total: { min: 0.1, max: 0.2 }, unpriced: [], assumptions: [], payer: 'you', cap: null, verdict: { ok: true, reason: null, message: 'Within your limit.', change: [], warning: null }, ack: 'abc' } })
  const b = await open(size, EXCL7.slice(0, 6), ok)
  await b.page.getByRole('button', { name: 'Run scan with this profile' }).first().click()
  await b.page.waitForTimeout(800)
  assert.equal(await b.page.getByText(/entries, the limit is/).count(), 0, `${label}: no refusal at the limit`)
  assert.equal(b.calls.filter(c => c === 'POST /api/scan').length, 0, `${label}: still nothing started before the estimate is confirmed`)
  await b.page.close()
}
await browser.close()
console.log('OK: a 7-exclusion draft is refused in plain words with the draft kept open and nothing started; 6 exclusions reach the estimate (390 and 1280 px, all calls stubbed)')
