// Rendered interaction check for #206 (Instinct: "isolated render/interaction harness, stub all calls"). NOT part of
// `npm test` (needs a browser). Run:  cd web && NODE_PATH=<dir with esbuild and playwright> node test/ui/window-edit.ui.mjs
// It bundles the real LeadsClient page, renders it in headless Chromium, and ANSWERS EVERY /api/* CALL FROM A STUB:
// no server, no database, no network, no key. It proves, on the rendered page:
//   1. the window notice shows and offers "Edit window to N days";
//   2. clicking it opens the profile editor with N days and the note, and starts NOTHING (zero non-GET requests);
//   3. the editor shows the edited window as visible text;
//   4. only "Run scan with this profile" sends POST /api/scan, exactly once, carrying the edited window.
// Exit code 1 on any failed expectation; exit 0 with "SKIP" when esbuild/playwright/chromium are not installed.
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
  plugins: [{ name: 'node-shims', setup(b) { b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: 'crypto-shim', namespace: 'shim' })); b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: 'export const createHash = () => ({ update() { return this }, digest() { return "shim" } })', loader: 'js' })) } }], define: { 'process.env.NODE_ENV': '"development"' }, external: [],
})
const js = bundle.outputFiles[0].text

const JOB = 'a'.repeat(24)
const day = n => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const ICP = { summary: 'Dental practices', who: ['Practice owner'], industries: ['dental'], sizes: [], where: ['Ohio'], signals: ['new location'], exclude: [], window_days: 90 }
const lead = (id, company, event_date) => ({ id, name: '', company, contact: null, signal: `${company} opened a clinic`, source_url: `https://news.example/${id}`, score: 70, evidence_excerpt: `${company} opened a clinic`, event_date, date_status: 'unverified', confidence: null, review_reason: 'outside_window', company_domain: null, human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 0, action: 0, why: null, signals: null, icp_match: null, enrichments: [], events: [] })
const calls = []
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

const browser = await chromium.launch()
const page = await browser.newPage()
await page.route('**/*', async route => {
  const u = new URL(route.request().url()); const m = route.request().method()
  if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>` })
  if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
  if (!u.pathname.startsWith('/api/')) return route.fulfill({ status: 204, body: '' })
  calls.push(`${m} ${u.pathname}`)
  if (u.pathname === '/api/scan' && m === 'POST') return json(route, { job_id: 'b'.repeat(24) })
  if (u.pathname === '/api/scan/status') return json(route, { status: 'done', lead_count: 2, icp: ICP, icp_source: 'user', attempts: 1, max_attempts: 3 })
  if (u.pathname === '/api/leads') return json(route, { job_id: JOB, status: 'done', hidden_count: 0, leads: [lead('l1', 'Old Dental', day(-200)), lead('l2', 'Older Dental', day(-300))] })
  if (u.pathname === '/api/scan/jobs') return json(route, { jobs: [] })
  return json(route, {}, 404)
})
await page.goto(`http://dazl.test/app/leads?job_id=${JOB}`)

const note = page.getByText(/older than your 90-day window/)
await note.waitFor({ timeout: 10000 })
const btn = page.getByRole('button', { name: 'Edit window to 180 days' })
await btn.waitFor()
assert.equal(calls.filter(c => c.startsWith('POST')).length, 0, 'nothing is started by merely showing the notice')

await btn.click()
await page.waitForTimeout(500)
assert.deepEqual(calls.filter(c => !c.startsWith('GET')), [], 'clicking Edit window must start nothing')
await page.getByText(/Nothing runs until you press run/).waitFor()
const run = page.getByRole('button', { name: 'Run scan with this profile' }).first()
await run.waitFor()
const nonGet = calls.filter(c => !c.startsWith('GET'))
assert.deepEqual(nonGet, [], `window edit must start nothing; saw ${JSON.stringify(nonGet)}`)
// the editor shows the edited window (visible, not hidden state)
assert.match(await page.getByTestId('draft-window').innerText(), /last 180 days/)

const post = page.waitForRequest(r => r.url().endsWith('/api/scan') && r.method() === 'POST')
await run.click()
const req = await post
assert.equal(JSON.parse(req.postData()).icp.window_days, 180, 'Run uses the edited window')
await page.waitForTimeout(300)
assert.equal(calls.filter(c => c === 'POST /api/scan').length, 1, 'exactly one scan started, only after Run')
await browser.close()
console.log('OK: window edit starts nothing until Run; Run posts one scan with window_days 180 (all calls stubbed)')
