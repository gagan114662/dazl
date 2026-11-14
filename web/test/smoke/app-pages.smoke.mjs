// Production smoke check: loads every /app page from a production build in a real browser.
// NOT part of `npm test` (needs a build and a browser). Run:  cd web && npm run build && npm run test:smoke
// Isolation (see harness.mjs): throwaway database, server under the test network fence, off-host browser requests
// aborted. Nothing is scanned, sent or billed.
// Fails (exit 1) on any page error, console error, ChunkLoadError, 4xx/5xx static asset, redirect to sign-in or anywhere
// else (except the listed renamed-page redirects, which must land exactly on their new page) or missing <h1>.
// Missing playwright/chromium or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes that exit 0).
import { appRoutes, loadPlaywright, newContext, startServer } from './harness.mjs'
const { chromium } = loadPlaywright()

const routes = appRoutes()
// The only redirects allowed, each to exactly this destination: renamed pages whose old URL must keep working for
// bookmarks and old links. Any other route that lands elsewhere (sign-in included) still fails.
const REDIRECTS = { '/app/replies': '/app/social' }

const srv = await startServer()
const { base } = srv
const failures = []
let browser
try {
  browser = await chromium.launch()
  const ctx = await newContext(browser, srv)
  for (const route of routes) {
    const page = await ctx.newPage(); const errs = []
    page.on('pageerror', e => errs.push(`page error: ${e.name}: ${e.message.split('\n')[0]}`))
    page.on('console', m => { if (m.type() === 'error') errs.push(`console error: ${m.text().split('\n')[0]}`) })
    page.on('response', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/_next/') && r.status() >= 400) errs.push(`asset ${r.status()} ${u.pathname}`) })
    const res = await page.goto(base + route, { waitUntil: 'networkidle' })
    await page.waitForTimeout(500)
    if (!res || res.status() >= 400) errs.push(`HTTP ${res?.status()}`)
    const landed = new URL(page.url()).pathname, expected = REDIRECTS[route] ?? route
    if (landed !== expected) errs.push(`landed on ${landed}${REDIRECTS[route] ? ` (expected the redirect to ${expected})` : ''}`)
    const h1 = await page.locator('main h1').first().textContent({ timeout: 5000 }).catch(() => null)
    if (!h1) errs.push('no <h1> rendered')
    console.log(`${errs.length ? 'FAIL' : 'ok  '} ${route}${REDIRECTS[route] ? ` -> ${REDIRECTS[route]}` : ''}${h1 ? ` (${h1.trim()})` : ''}`)
    for (const e of errs) { console.log(`     ${e}`); failures.push(`${route}: ${e}`) }
    await page.close()
  }
  // #1088: this app has no server actions, so a Next-Action request is a probe: a plain 400 from proxy.ts on any path (Next would
  // otherwise answer 404/409 and print a "Failed to find Server Action" stack trace per request), and the page itself still loads.
  for (const p of ['/', '/sign-in', '/app/leads', '/api/health']) {
    const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'next-action': '7f0000000000000000000000000000000000000000', 'content-type': 'text/plain;charset=UTF-8' }, body: '[]', redirect: 'manual' })
    const ok = r.status === 400 && (await r.text()) === 'Bad Request\n'
    console.log(`${ok ? 'ok  ' : 'FAIL'} POST ${p} with Next-Action -> ${r.status}`)
    if (!ok) failures.push(`POST ${p} with Next-Action: HTTP ${r.status}, expected the proxy's 400`)
  }
  { const r = await fetch(`${base}/sign-in`, { redirect: 'manual' }); if (r.status !== 200) failures.push(`GET /sign-in after the probes: HTTP ${r.status}`) }
} finally {
  await browser?.close()
  srv.stop()
}
// Every allowed redirect must still exist as a page here, so a stale entry cannot hide a removed route.
for (const from of Object.keys(REDIRECTS)) if (!routes.includes(from)) failures.push(`${from}: allowed redirect listed but no such page`)
if (failures.length) { console.log(`\n${failures.length} problem(s) across ${routes.length} pages`); process.exit(1) }
console.log(`\nAll ${routes.length} /app pages loaded from the production build without errors.`)
