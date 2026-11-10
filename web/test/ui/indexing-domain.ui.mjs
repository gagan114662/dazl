// #904 rendered check of the Weekly indexing checks panel: a result shows the domain it was checked against; a domain edit made while a check
// ran shows the plain 409 text (results discarded, searches still counted) and the panel keeps the confirmed state. NOT part of `npm test`.
// Run:  cd web && NODE_PATH=<dir with esbuild and playwright> node test/ui/indexing-domain.ui.mjs   (SHOTS=<dir> saves 390 and 1280 px screenshots;
// PW_CHROME=<chrome-headless-shell> when Playwright's pinned build is absent). Bundles the real IndexingPanel and ANSWERS EVERY /api/* CALL FROM A STUB
// (no server, no database, no network, no provider call). Unstyled harness (no app CSS): it shows wording and behaviour, not styling.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
let esbuild, chromium
try { esbuild = require('esbuild'); ({ chromium } = require('playwright')) } catch (e) { console.log(`SKIP: ${e.message.split('\n')[0]} (set NODE_PATH to a folder with esbuild and playwright)`); process.exit(0) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const bundle = await esbuild.build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import IndexingPanel from '@/app/app/seo/indexing-panel'; createRoot(document.getElementById('root')).render(<IndexingPanel />)`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'error',
  alias: { '@': root },
  // node:crypto is only used by the draft-review binding hash, which this check never exercises: a browser shim keeps the bundle self-contained.
  plugins: [{ name: 'node-shims', setup(b) { b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: 'crypto-shim', namespace: 'shim' })); b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: 'export const createHash = () => ({ update() { return this }, digest() { return "shim" } }); export const randomBytes = () => { throw new Error("crypto-shim: randomBytes must never execute in a browser fixture - bundling only") }', loader: 'js' })) } }], define: { 'process.env.NODE_ENV': '"development"' }, external: [],
})
const js = bundle.outputFiles[0].text

const NOW = Math.floor(Date.now() / 1000)
const STATE = { config: { domain: 'bravo.example', next_run_at: NOW + 3 * 86400 }, keywords: ['crm for small teams', 'sales tool'], allowance: { used: 3, limit: 10 },
  results: [{ keyword: 'crm for small teams', indexed: true, top_url: 'https://bravo.example/crm', domain: 'bravo.example', checked_at: NOW - 3600 }] }
const STALE = 'Your domain changed while the check was running, so those results were discarded. The searches already sent still count toward this week. Run the check again for the new domain.'
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {})
for (const [label, size] of [['1280', { width: 1280, height: 900 }], ['390', { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport: size }); const calls = []
  await page.route('**/*', async route => {
    const u = new URL(route.request().url()); const m = route.request().method()
    if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>` })
    if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
    if (!u.pathname.startsWith('/api/')) return route.fulfill({ status: 204, body: '' })
    calls.push(`${m} ${u.pathname}`)
    if (u.pathname === '/api/seo/indexing' && m === 'GET') return json(route, STATE)
    if (u.pathname === '/api/seo/indexing' && m === 'POST') return json(route, { error: STALE }, 409)
    return json(route, {}, 404)
  })
  await page.goto('http://dazl.test/app/seo')
  await page.getByText('crm for small teams').waitFor({ timeout: 10000 })
  // one keyword listed with the date it was checked, one not checked yet; the checked domain is in the tooltip (title) and nothing says "not found" for the unchecked one
  const row = page.locator('li', { hasText: 'crm for small teams' })
  assert.match(await row.innerText(), /listed/)
  assert.match(await row.locator('span[title]').getAttribute('title'), /checked bravo\.example on /)
  assert.doesNotMatch(await page.locator('li', { hasText: 'sales tool' }).innerText(), /listed|not found/)
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `indexing-panel-${label}.png`), fullPage: false })
  // a check that finds the domain changed meanwhile: the 409 text reaches the user
  await page.getByRole('button', { name: 'Check now' }).click()
  const err = page.getByTestId('indexing-error')
  await err.waitFor({ timeout: 10000 })
  assert.equal((await err.innerText()).trim(), STALE)
  assert.ok(await err.isVisible())
  assert.match(await page.locator('li', { hasText: 'crm for small teams' }).innerText(), /listed/, 'the confirmed list is still shown after the refusal')
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `indexing-panel-409-${label}.png`), fullPage: false })
  await page.close()
}
await browser.close()
console.log('OK: a result names the domain it was checked against; a stale-domain refusal shows its plain 409 text and the confirmed list stays (390 and 1280 px, all calls stubbed)')
