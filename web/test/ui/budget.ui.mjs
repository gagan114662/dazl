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

// A price estimate in the shape /api/scan/estimate answers with (synthetic numbers).
const row = (id, label, provider, unit_usd, note, usd, capped = false) => ({ id, label, provider, kind: capped ? 'model' : 'search', unit: 'u', unit_usd, units: { min: 1, max: 1 }, usd, capped, note })
const EST = (o = {}) => ({ estimate: { rows: [row('extraction', 'Candidate extraction', 'AI model', '$3.00 in / $15.00 out per 1M tokens (claude-sonnet-4-5)', '1-3 call(s)', { min: 0.05, max: 0.4 }, true), row('tinyfish_search', 'Web search', 'TinyFish', 'free allowance', 'At most 13 searches', { min: 0, max: 0 }), row('fallback_research', 'Web-search research fallback', 'AI model web search', 'not priced', 'Only if nothing is found', null)],
  total: { min: 0.05, max: 0.4 }, unpriced: ['Web-search research fallback'], assumptions: ['Model: claude-sonnet-4-5.', 'This is an estimate, not a quote or a bill.'], payer: 'you',
  cap: { max_usd: 0.5, reserved_usd: 0, remaining_usd: 0.5, binding: 'daily', month_cap_usd: null, month_reserved_usd: 0, unknown: false, capped_total: { min: 0.05, max: 0.4 } }, verdict: { ok: true, reason: null, message: 'Within your limit: even the worst case ($0.40) fits the $0.50 left.', change: [], warning: null }, ack: 'ack1', ...o } })
async function open(scanReply, estimateReply = route => json(route, EST())) {
  const calls = []; const posts = []; const estimates = []
  const page = await browser.newPage()
  await page.route('**/*', async route => {
    const u = new URL(route.request().url()); const m = route.request().method()
    if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>' })
    if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
    if (!u.pathname.startsWith('/api/')) return route.fulfill({ status: 204, body: '' })
    calls.push(`${m} ${u.pathname}`)
    if (u.pathname === '/api/scan/estimate' && m === 'POST') { estimates.push(JSON.parse(route.request().postData())); return estimateReply(route) }
    if (u.pathname === '/api/scan' && m === 'POST') { posts.push(JSON.parse(route.request().postData())); return scanReply(route) }
    if (u.pathname === '/api/scan/latest') return json(route, { query: 'Toronto dental practices hiring front desk staff', icp: ICP, icp_source: 'user' })
    if (u.pathname === '/api/scan/jobs') return json(route, { jobs: [] })
    return json(route, {}, 404)
  })
  await page.goto('http://dazl.test/app/leads')
  await page.getByText(/Profile used:/).click() // the restored profile is inside a closed <details>
  await page.getByText('Edit and run again').click()
  await page.getByTestId('budget-panel').waitFor()
  await page.locator('#play-offer').fill('Appointment booking software') // a run now needs the offer text
  return { page, calls, posts, estimates }
}

// 1. default: off, nothing about a budget is sent
{
  const { page, posts } = await open(route => json(route, { job_id: 'e'.repeat(24) }, 202))
  assert.equal(await page.getByTestId('budget-disclosure').count(), 0, 'no disclosure while the limit is off')
  await page.getByRole('button', { name: 'Run scan with this profile' }).last().click()
  await page.getByTestId('estimate-confirm').waitFor()
  assert.equal(posts.length, 0, 'nothing is started before the estimate is confirmed')
  await page.getByTestId('estimate-confirm-run').click()
  await page.waitForTimeout(400)
  assert.equal(posts.length, 1); assert.equal('budget' in posts[0], false, 'budget is not sent when the limit is off'); assert.equal(posts[0].estimate_ack, 'ack1', 'the run carries the estimate that was confirmed')
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
  await run.last().click(); await page.getByTestId('estimate-confirm').waitFor()
  assert.equal(posts.length, 0); await page.getByTestId('estimate-confirm-run').click(); await page.waitForTimeout(400)
  assert.equal(posts.length, 1); assert.deepEqual(posts[0].budget, { max_usd: 0.5, judge: false })
  assert.equal(posts[0].query, 'Toronto dental practices hiring front desk staff')
  await page.close()
}
// 3. a server-side rejection is shown, not swallowed
{
  const { page } = await open(route => json(route, {}, 500), route => json(route, { error: 'invalid_budget', detail: 'budget.max_usd must be a number above 0 and at most 1000' }, 400))
  await page.getByLabel('Limit what this run may spend (optional)').check()
  await page.getByTestId('budget-max-usd').fill('5')
  await page.getByRole('button', { name: 'Run scan with this profile' }).last().click()
  await page.getByText(/The spend limit was not accepted: budget\.max_usd must be a number/).waitFor({ timeout: 5000 })
  await page.close()
}
// 4. the menu and the total are on the page before anything runs, at desktop and 390px; Cancel starts nothing
for (const [w, h, tag] of [[1280, 900, 'desktop'], [390, 844, 'mobile']]) {
  const { page, posts } = await open(route => json(route, { job_id: 'a'.repeat(24) }, 202))
  await page.setViewportSize({ width: w, height: h })
  await page.getByRole('button', { name: 'Run scan with this profile' }).last().click()
  const panel = page.getByTestId('estimate-confirm'); await panel.waitFor()
  const t = await panel.innerText()
  for (const x of ['Candidate extraction', 'TinyFish', '$3.00 in / $15.00 out per 1M tokens', 'free allowance', 'not priced', 'priced rows only', '$0.05 - $0.40', 'Within your limit']) assert.ok(t.includes(x), `${tag}: ${x}`)
  assert.equal(await page.getByTestId('estimate-row').count(), 3)
  assert.equal(await page.getByTestId('estimate-total').innerText(), '$0.05 - $0.40')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${tag}: no horizontal page scroll`)
  assert.equal(await panel.getAttribute('data-verdict'), 'ok')
  await page.getByTestId('estimate-cancel').click(); await page.waitForTimeout(200)
  assert.equal(await page.getByTestId('estimate-confirm').count(), 0); assert.equal(posts.length, 0, `${tag}: cancel starts nothing`)
  await page.close()
}
// 5. over the remaining limit: blocked, no Run button, what to change is shown; a server 402 does the same
for (const [w, h, tag] of [[1280, 900, 'desktop'], [390, 844, 'mobile']]) {
  const blocked = EST({ verdict: { ok: false, reason: 'over_budget', message: 'Blocked: the model requests alone are expected to cost at least $0.05 but only $0.02 of your $0.02 limit is left.', change: ['Raise the dollar limit to at least $0.05 (about $0.40 covers the worst case).', 'Skip the verification judge (saves about $0.01-$0.03).'], warning: null }, cap: { max_usd: 0.02, reserved_usd: 0, remaining_usd: 0.02, binding: 'daily', month_cap_usd: null, month_reserved_usd: 0, unknown: false, capped_total: { min: 0.05, max: 0.4 } } })
  const { page, posts } = await open(route => json(route, {}, 500), route => json(route, blocked))
  await page.setViewportSize({ width: w, height: h })
  await page.getByLabel('Limit what this run may spend (optional)').check(); await page.getByTestId('budget-max-usd').fill('0.02')
  await page.getByRole('button', { name: 'Run scan with this profile' }).last().click()
  const panel = page.getByTestId('estimate-confirm'); await panel.waitFor()
  assert.equal(await panel.getAttribute('data-verdict'), 'blocked'); assert.equal(await page.getByTestId('estimate-confirm-run').count(), 0, `${tag}: no Run button while blocked`)
  assert.match(await page.getByTestId('estimate-verdict').innerText(), /^Blocked:/); assert.match(await page.getByTestId('estimate-change').innerText(), /Raise the dollar limit to at least \$0\.05/)
  assert.match(await page.getByTestId('estimate-cap').innerText(), /Daily limit: \$0\.02.*\$0\.02 left \(daily limit binds\)/)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${tag}: no horizontal page scroll`)
  assert.equal(posts.length, 0); await page.close()
}
// 6. the limit changed after the estimate was confirmed: the server answers 409 estimate_changed and the NEW estimate is shown for a fresh confirmation
{
  let n = 0
  const { page, posts } = await open(route => ++n === 1 ? json(route, { error: 'estimate_changed', estimate: EST({ ack: 'ack2', total: { min: 0.1, max: 0.6 } }).estimate }, 409) : json(route, { job_id: 'b'.repeat(24) }, 202))
  await page.getByRole('button', { name: 'Run scan with this profile' }).last().click(); await page.getByTestId('estimate-confirm-run').click()
  await page.waitForFunction(() => document.querySelector('[data-testid=estimate-total]')?.textContent === '$0.10 - $0.60')
  assert.equal(posts.length, 1, 'the changed estimate was not run'); await page.getByTestId('estimate-confirm-run').click(); await page.waitForTimeout(300)
  assert.equal(posts.length, 2); assert.equal(posts[1].estimate_ack, 'ack2'); await page.close()
}
await browser.close()
console.log('OK (price estimate: menu + total before any run at desktop and 390px, cancel starts nothing, blocked state with what to change, changed estimate re-confirmed): spend limit off by default and not sent; disclosure (partial + not covered) shown before Run; invalid limit disables Run; Run sends the exact API budget; server rejection shown (all calls stubbed)')
