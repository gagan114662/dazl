// #1463 on the production build, in Chromium. NOT part of `npm test`; runs in the browser lane via `npm run test:smoke:chunks`.
// A reload sat ~86 s on "Opening your workspace…" while the server answered other tabs at once and logged no event-loop stall
// (run e1334435): the browser was waiting, not the server. The inline stall script (lib/stall-recovery.ts) only runs when the
// fallback arrives in server-parsed HTML; a client-side wait (a soft navigation whose RSC response never arrives) had no watch at
// all. A small proxy in front of the server holds every RSC request for Leads open forever (headers and body never sent), the way a
// held stream or a stuck connection looks to the browser. Expected, with the same rule as the inline script:
//   A. clicking Leads with its RSC held: within the stall window the tab loads Leads as a normal page (one recovery), never stuck;
//   B. a second stall in the same tab within the reload window: a visible Reload button instead, no reload loop, nothing written.
import assert from 'node:assert/strict'
import http from 'node:http'
import { loadPlaywright, startServer } from './harness.mjs'
const { chromium } = loadPlaywright()

const srv = await startServer()
const up = new URL(srv.base)
const held = []
const proxy = http.createServer((req, res) => {
  const isRsc = req.headers.rsc === '1' || /[?&]_rsc=/.test(req.url ?? '')
  if (isRsc && (req.url ?? '').startsWith('/app/leads')) { held.push(req.url); return } // never answered
  const p = http.request({ host: up.hostname, port: up.port, path: req.url, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res) })
  p.on('error', () => { try { res.writeHead(502); res.end() } catch { /* closed */ } })
  req.pipe(p)
})
await new Promise(r => proxy.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${proxy.address().port}`
let browser
try {
  browser = await chromium.launch()
  const ctx = await browser.newContext()
  await ctx.addCookies([{ name: 'dazl_session', value: srv.token, url: base }])
  await ctx.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
  const page = await ctx.newPage()
  const docs = [], writes = [], reports = []
  page.on('request', r => {
    if (r.resourceType() === 'document') docs.push(new URL(r.url()).pathname)
    if (!['GET', 'HEAD'].includes(r.method())) writes.push(`${r.method()} ${new URL(r.url()).pathname}`)
    // this check fails now and then with one POST /api/client-errors (three PRs on 2026-11-24): keep what the page reported
    // (kind, error class, path and frames only: lib/client-error-report.ts) so the failure names the error
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/client-errors') reports.push(String(r.postData() ?? '').slice(0, 1500))
  })
  page.on('pageerror', e => {
    reports.push(`pageerror: ${String(e?.stack ?? e).slice(0, 1500)}`)
  })
  page.on('console', m => { if (m.type() === 'error') reports.push(`console.error: ${m.text().slice(0, 500)}`) })
  const leadsLink = () => page.locator('aside').getByRole('link', { name: 'Leads', exact: true })

  // C (Qodo #1546): a plain same-origin anchor the router does not take over - a file download that leaves the URL unchanged -
  // is never treated as a stalled navigation: no recovery, no notice, the recovery budget untouched.
  await ctx.route('**/stall-test-download.csv', route => route.fulfill({ status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="x.csv"' }, body: 'a,b\n' }))
  await page.goto(base + '/app/settings', { waitUntil: 'domcontentloaded' })
  await leadsLink().waitFor()
  // The Plan panel appears only after its client effect loads usage. Wait before changing React-owned DOM.
  await page.locator('main').getByTestId('plan-panel').waitFor()
  await page.evaluate(() => { const a = document.createElement('a'); a.href = '/stall-test-download.csv'; a.textContent = 'Download CSV'; a.id = 'plain-download'; document.querySelector('main')?.prepend(a) })
  docs.length = 0
  await Promise.all([page.waitForEvent('download'), page.click('#plain-download')])
  await page.waitForTimeout(15000)
  const budget = await page.evaluate(() => sessionStorage.getItem('dazl-stall-reload'))
  const falseNotice = await page.locator('[role="alert"]').filter({ hasText: 'This is taking too long' }).count()
  console.log(`C: documents after the download click=[${docs.join(', ')}], notice=${falseNotice}, budget used=${budget !== null}`)
  assert.equal(falseNotice, 0, 'C: no stall notice for a download')
  assert.equal(budget, null, 'C: a download never spends the recovery')
  assert.ok(!docs.includes('/app/settings'), 'C: no reload')

  // A
  await page.goto(base + '/app/settings', { waitUntil: 'domcontentloaded' })
  await leadsLink().waitFor()
  await page.waitForTimeout(1500)
  docs.length = 0
  await leadsLink().click()
  await page.waitForTimeout(17000)
  const urlA = new URL(page.url()).pathname
  console.log(`A: held RSC requests=${held.length}, documents after the click=[${docs.join(', ')}], url=${urlA}`)
  assert.ok(held.length > 0, 'precondition: the Leads RSC request was held')
  assert.equal(urlA, '/app/leads', 'A: the stalled navigation recovered to Leads within the stall window')
  assert.deepEqual(docs, ['/app/leads'], 'A: exactly one recovery load')
  // Qodo #1546: the recovered page actually rendered, the workspace fallback is gone
  await page.getByText('Who do you want to reach?').first().waitFor({ timeout: 10000 })
  assert.equal(await page.locator('#workspace-opening').count(), 0, 'A: no workspace fallback left on screen')

  // B
  await page.goto(base + '/app/settings', { waitUntil: 'domcontentloaded' })
  await leadsLink().waitFor()
  await page.waitForTimeout(1500)
  docs.length = 0
  await leadsLink().click()
  await page.waitForTimeout(17000)
  const notice = page.locator('[role="alert"]').filter({ hasText: 'This is taking too long' })
  const shown = await notice.isVisible()
  const button = shown && await notice.getByRole('button', { name: 'Reload' }).isVisible()
  console.log(`B: documents after the click=[${docs.join(', ')}], notice=${shown}, button=${button}`)
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/stall-watch-B.png` })
  assert.deepEqual(docs, [], 'B: no second automatic reload within the window')
  assert.equal(button, true, 'B: a visible Reload button')
  assert.deepEqual(writes, [], `nothing written; the page reported: ${reports.join(' | ') || 'nothing captured'}`)
  console.log('\nA held soft navigation recovers once, then shows a Reload button.')
} finally {
  await browser?.close(); proxy.close(); srv.stop()
}
