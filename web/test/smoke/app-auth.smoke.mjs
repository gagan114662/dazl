// Production smoke check of the /app sign-in gate (proxy.ts; the /app pages themselves are static), on every /app page of a production
// build. NOT part of `npm test` (needs a build and a browser). Run:  cd web && npm run build && npm run test:smoke:auth
// Isolation as harness.mjs: throwaway database, server under the test network fence, off-host browser requests aborted.
// - Signed out (no cookie), and a cookie that is no longer a session (signed out elsewhere, expired, malformed): a 307
//   to /sign-in before any page HTML is sent, never a 200 with the app shell and a late in-page redirect.
// - Signed in, in a browser: the page loads in one navigation (no detour through /sign-in, no loop), renders its <h1>,
//   and none of its own /api calls is refused as signed out (the tenant's data loads).
import { appRoutes, loadPlaywright, newContext, startServer } from './harness.mjs'
const { chromium } = loadPlaywright()

const routes = appRoutes()
const REDIRECTS = { '/app/replies': '/app/social' } // renamed pages, as in app-pages.smoke.mjs
const srv = await startServer()
const { base, token } = srv
const failures = []
let browser
try {
  const stale = { 'no cookie': null, 'signed-out token': 'f'.repeat(64), 'malformed token': 'abc' }
  for (const route of routes) {
    for (const [name, cookie] of Object.entries(stale)) {
      const r = await fetch(base + route, { redirect: 'manual', headers: cookie ? { cookie: `dazl_session=${cookie}` } : {} })
      const body = await r.text()
      const to = r.headers.get('location') ? new URL(r.headers.get('location'), base).pathname : null
      if (r.status !== 307 || to !== '/sign-in') failures.push(`${route} (${name}): HTTP ${r.status} to ${to}, expected 307 to /sign-in`)
      if (body.includes('Sign out')) failures.push(`${route} (${name}): the app shell was sent`)
    }
  }
  console.log(`signed out: ${routes.length} pages x ${Object.keys(stale).length} cookies checked`)

  browser = await chromium.launch()
  const ctx = await newContext(browser, srv)
  for (const route of routes) {
    const page = await ctx.newPage(); const errs = []; const navs = []
    page.on('framenavigated', f => { if (f === page.mainFrame()) navs.push(new URL(f.url()).pathname) })
    page.on('response', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/') && r.status() === 401) errs.push(`${u.pathname} refused as signed out`) })
    const res = await page.goto(base + route, { waitUntil: 'networkidle' })
    await page.waitForTimeout(500)
    const expected = REDIRECTS[route] ?? route
    if (!res || res.status() >= 400) errs.push(`HTTP ${res?.status()}`)
    if (navs.includes('/sign-in')) errs.push(`went through /sign-in: ${navs.join(' > ')}`)
    if (new URL(page.url()).pathname !== expected) errs.push(`landed on ${new URL(page.url()).pathname}`)
    if (!(await page.locator('main h1').first().textContent({ timeout: 5000 }).catch(() => null))) errs.push('no <h1> rendered')
    console.log(`${errs.length ? 'FAIL' : 'ok  '} signed in ${route}`)
    for (const e of errs) { console.log(`     ${e}`); failures.push(`${route} (signed in): ${e}`) }
    await page.close()
  }
} finally {
  await browser?.close()
  srv.stop()
}
if (failures.length) { for (const f of failures) console.log(f); console.log(`\n${failures.length} problem(s)`); process.exit(1) }
console.log(`\nAll ${routes.length} /app pages: signed out and stale sessions redirected before render; signed in loads with no detour.`)
