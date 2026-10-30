// Rendered check, fully stubbed (no server, db, network or key). Run: cd web && NODE_PATH=<dir with esbuild and playwright> node test/ui/budget.ui.mjs
// The optional spend limit on the profile editor: off by default and then the request carries NO budget; when on, the cost
// disclosure (partial scope + what is not covered) is on the page BEFORE Run, an invalid limit disables Run, and Run sends
// exactly the API budget object. SKIP (exit 0) without esbuild/playwright.
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
const browser = await chromium.launch()

async function open(scanReply) {
  const calls = []; const posts = []
  const page = await browser.newPage()
  await page.route('**/*', async route => {
    const u = new URL(route.request().url()); const m = route.request().method()
    if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>' })
    if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
    if (!u.pathname.startsWith('/api/')) return route.fulfill({ status: 204, body: '' })
    calls.push(`${m} ${u.pathname}`)
    if (u.pathname === '/api/scan' && m === 'POST') { posts.push(JSON.parse(route.request().postData())); return scanReply(route) }
    if (u.pathname === '/api/scan/latest') return json(route, { query: 'Toronto dental practices hiring front desk staff', icp: ICP, icp_source: 'user' })
    if (u.pathname === '/api/scan/jobs') return json(route, { jobs: [] })
    return json(route, {}, 404)
  })
  await page.goto('http://dazl.test/app/leads')
  await page.getByText(/Profile used:/).click() // the restored profile is inside a closed <details>
  await page.getByText('Edit and run again').click()
  await page.getByTestId('budget-panel').waitFor()
  // what the play sells (needed before a scan can start); synthetic
  const offer = page.getByTestId('review-offer-input').first(); if (await offer.count()) await offer.fill('Online booking for dental practices')
  return { page, calls, posts }
}

// 1. default: off, nothing about a budget is sent
{
  const { page, posts } = await open(route => json(route, { job_id: 'e'.repeat(24) }, 202))
  assert.equal(await page.getByTestId('budget-disclosure').count(), 0, 'no disclosure while the limit is off')
  await page.getByRole('button', { name: 'Run scan with this profile' }).last().click()
  await page.waitForTimeout(400)
  assert.equal(posts.length, 1); assert.equal('budget' in posts[0], false, 'budget is not sent when the limit is off')
  await page.close()
}
// 2. on: disclosure BEFORE Run, validation, exact object
{
  const { page, posts } = await open(route => json(route, { job_id: 'f'.repeat(24) }, 202))
  await page.getByLabel('Limit what this run may spend (optional)').check()
  const run = page.getByRole('button', { name: 'Run scan with this profile' })
  // enabled with nothing set: error + Run disabled on both buttons
  await page.getByTestId('budget-error').waitFor()
  assert.match(await page.getByTestId('budget-error').innerText(), /Set a dollar limit or tick at least one option/)
  for (const b of await run.all()) assert.equal(await b.isDisabled(), true)
  await page.getByTestId('budget-max-usd').fill('abc')
  assert.match(await page.getByTestId('budget-error').innerText(), /plain positive number/)
  await page.getByTestId('budget-max-usd').fill('0.50')
  await page.getByLabel('Skip the verification judge').check()
  const disc = page.getByTestId('budget-disclosure'); await disc.waitFor()
  const text = await disc.innerText()
  assert.match(text, /PARTIAL budget, not a whole-scan dollar ceiling/); assert.match(text, /Not a bill and not a vendor-enforced ceiling/)
  assert.match(text, /Not covered by this limit/); assert.match(text, /Profile generation/); assert.match(text, /TinyFish search and fetch/); assert.match(text, /Autopilot and every outreach action/)
  assert.match(text, /worst case at the highest listed price/); assert.match(text, /an unlisted model is not covered/); assert.match(text, /bounded by COUNT, not dollars/); assert.match(text, /does NOT start autopilot/); assert.match(text, /NOT BOUNDED AT ALL: retries below dazl/)
  assert.match(text, /fallback research: refused/); assert.match(text, /judge: off/)
  assert.equal(posts.length, 0, 'the disclosure was on the page before anything was sent')
  for (const b of await run.all()) assert.equal(await b.isDisabled(), false)
  await run.last().click(); await page.waitForTimeout(400)
  assert.equal(posts.length, 1); assert.deepEqual(posts[0].budget, { max_usd: 0.5, judge: false })
  assert.equal(posts[0].query, 'Toronto dental practices hiring front desk staff')
  await page.close()
}
// 3. a server-side rejection is shown, not swallowed
{
  const { page } = await open(route => json(route, { error: 'invalid_budget', detail: 'budget.max_usd must be a number above 0 and at most 1000' }, 400))
  await page.getByLabel('Limit what this run may spend (optional)').check()
  await page.getByTestId('budget-max-usd').fill('5')
  await page.getByRole('button', { name: 'Run scan with this profile' }).last().click()
  await page.getByText(/The spend limit was not accepted: budget\.max_usd must be a number/).waitFor({ timeout: 5000 })
  await page.close()
}
await browser.close()
console.log('OK: spend limit off by default and not sent; disclosure (partial + not covered) shown before Run; invalid limit disables Run; Run sends the exact API budget; server rejection shown (all calls stubbed)')
