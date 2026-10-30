// Rendered check, fully stubbed (no server, db, network or Gmail). Run: cd web && node test/ui/bounce-coverage.ui.mjs
// #415: Settings > Replies says whether bounces are checked (including delivery-failure notices outside the original
// thread); without reply reading it says delivery is unknown, never that it is fine. SHOTS=<dir> also saves desktop and
// mobile screenshots. SKIP (exit 0) without esbuild/playwright.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
let esbuild, chromium
try { esbuild = require('esbuild'); ({ chromium } = require('playwright')) } catch (e) { console.log(`SKIP: ${e.message.split('\n')[0]}`); process.exit(0) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = await esbuild.build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import RepliesPanel from '@/app/app/settings/replies-panel'; createRoot(document.getElementById('root')).render(<main style={{maxWidth: 720, margin: '24px auto', padding: '0 16px'}}><RepliesPanel /></main>)`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'error', alias: { '@': root }, define: { 'process.env.NODE_ENV': '"development"' },
})
const js = bundle.outputFiles[0].text
// The app's built stylesheet when there is a build (screenshots look like the app); the assertions do not need it.
const css = await import('node:fs').then(fs => { try { const d = path.join(root, '.next/static/chunks'); return fs.readdirSync(d).filter(f => f.endsWith('.css')).map(f => fs.readFileSync(path.join(d, f), 'utf8')).join('\n') } catch { return '' } })
const base = { available: true, gmail_connected: true, consent: { version: 'v', text: ['Synthetic consent line.'], accepted: true }, read_granted: true, followups_enabled: false, autopilot_on: true, inbound: [] }
const browser = await chromium.launch()

async function open(info, viewport) {
  const page = await browser.newPage({ viewport })
  await page.route('**/*', async route => {
    const u = new URL(route.request().url())
    if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${css}</style></head><body style="background:#fafafa"><div id="root"></div><script src="/bundle.js"></script></body></html>` })
    if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
    if (u.pathname === '/api/outreach/replies') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(info) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto('http://dazl.test/app/settings')
  await page.getByText('Replies and follow-ups').waitFor()
  return page
}

const sendOnly = { ...base, read_granted: false }
const CASES = [
  ['checked', base, /Bounces are checked, including delivery-failure notices that arrive outside the original thread/],
  ['unknown', sendOnly, /Bounces aren't being checked, so whether your emails were delivered is unknown/],
]
for (const [state, info, re] of CASES) {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 640 }], ['mobile', { width: 390, height: 760 }]]) {
    const page = await open({ ...info, bounce_coverage: state }, viewport)
    assert.match(await page.getByTestId('bounce-coverage').innerText(), re, `${state} ${name}`)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${state} ${name}: no horizontal scroll`)
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `415-${state}-${name}.png`), fullPage: true })
    await page.close()
  }
}
// An older server without the field: no line.
{
  const page = await open(base, { width: 1280, height: 640 })
  assert.equal(await page.getByTestId('bounce-coverage').count(), 0)
  await page.close()
}
await browser.close()
console.log('bounce-coverage.ui: ok')
