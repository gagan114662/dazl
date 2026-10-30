// Rendered check, fully stubbed (no server, db, network or key). Run: cd web && NODE_PATH=<dir with esbuild and playwright> node test/ui/trial-refusal.ui.mjs
// #410: starting a scan on Leads when the free trial refuses shows why, from the server's reason: only the account's own
// attempts read as used; a network throttle or an unavailable trial says so with the step that works now, never "used
// up", and no raw error code reaches the page. SHOTS=<dir> also saves desktop and mobile screenshots. SKIP (exit 0)
// without esbuild/playwright.
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
const css = await import('node:fs').then(fs => { try { const d = path.join(root, '.next/static/chunks'); return fs.readdirSync(d).filter(f => f.endsWith('.css')).map(f => fs.readFileSync(path.join(d, f), 'utf8')).join('\\n') } catch { return '' } })
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const ICP = { summary: 'Toronto dental practices', who: ['Practice owner'], industries: [], sizes: [], where: ['Toronto'], signals: [], exclude: [] }
const browser = await chromium.launch()
// The price estimate a keyless account sees before a run (synthetic, the shape /api/scan/estimate answers with): the run
// is paid by the free trial; confirming it sends POST /api/scan, which is where the trial refuses.
const EST = { estimate: { rows: [], total: { min: 0.05, max: 0.4 }, unpriced: [], assumptions: ['This is an estimate, not a quote or a bill.'], payer: 'trial',
  cap: { max_usd: null, reserved_usd: 0, remaining_usd: null, binding: null, month_cap_usd: null, month_reserved_usd: 0, unknown: false, capped_total: { min: 0.05, max: 0.4 } },
  verdict: { ok: true, reason: null, message: 'Runs on the free trial.', change: [], warning: null }, ack: 'ack-trial' } }

async function open(scanReply, viewport = { width: 1280, height: 900 }) {
  const calls = []; const posts = []
  const page = await browser.newPage({ viewport })
  await page.route('**/*', async route => {
    const u = new URL(route.request().url()); const m = route.request().method()
    if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>` })
    if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
    if (!u.pathname.startsWith('/api/')) return route.fulfill({ status: 204, body: '' })
    calls.push(`${m} ${u.pathname}`)
    if (u.pathname === '/api/scan/estimate' && m === 'POST') return json(route, EST)
    if (u.pathname === '/api/scan' && m === 'POST') { posts.push(JSON.parse(route.request().postData())); return scanReply(route) }
    if (u.pathname === '/api/scan/latest') return json(route, { query: 'Toronto dental practices hiring front desk staff', icp: ICP, icp_source: 'user' })
    if (u.pathname === '/api/scan/jobs') return json(route, { jobs: [] })
    return json(route, {}, 404)
  })
  await page.goto('http://dazl.test/app/leads')
  await page.getByText(/Profile used:/).click() // the restored profile is inside a closed <details>
  await page.getByText('Edit and run again').click()
  await page.getByTestId('budget-panel').waitFor()
  await page.locator('#play-offer').fill('Online booking for dental practices') // a run needs the offer text; synthetic
  return { page, calls, posts }
}

const CASES = [
  ['throttle', { error: 'trial_exhausted', reason: 'ip_throttle', used: 0 }, /Too many free trial scans from your network today\. Try again tomorrow, or add your AI key in Settings to scan now\./],
  ['unavailable', { error: 'trial_unavailable', reason: 'not_configured' }, /Free trial scans can't run right now\. Add your AI key in Settings to scan\./],
  ['booked', { error: 'trial_unavailable', reason: 'global_daily_cap' }, /fully booked/],
  ['exhausted', { error: 'trial_exhausted', reason: 'account_cap', used: 3 }, /You have used all your free trial scan attempts/],
]
for (const [name, reply, re] of CASES) {
  for (const [vp, viewport] of name === 'throttle' || name === 'unavailable' ? [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]] : [['desktop', { width: 1280, height: 900 }]]) {
    const { page, posts } = await open(route => json(route, reply, 402), viewport)
    await page.getByRole('button', { name: 'Run scan with this profile' }).last().click()
    await page.getByTestId('estimate-confirm-run').click() // the estimate is confirmed; the start is refused
    const err = page.getByText(re); await err.waitFor({ timeout: 5000 })
    assert.equal(posts.length, 1)
    const text = await page.locator('body').innerText()
    if (name !== 'exhausted') assert.doesNotMatch(text, /used up|used all/, `${name}: nothing claims the account used its trial`)
    assert.doesNotMatch(text, /trial_exhausted|trial_unavailable|ip_throttle|not_configured|global_daily_cap/, `${name}: no raw code on the page`)
    assert.equal(await page.getByTestId('estimate-confirm').count(), 0, `${name}: the trial estimate closes; nothing offers to run it again`)
    await err.scrollIntoViewIfNeeded()
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `410-start-${name}-${vp}.png`), fullPage: false })
    await page.close()
  }
}
await browser.close()
console.log('trial-refusal.ui: ok')
