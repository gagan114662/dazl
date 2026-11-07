// #988 (part of #534): /app routes render time-dependent values stably. On the production build, Home, Inbox and Settings
// load at 1280 and 390 with ZERO page errors, console errors or React hydration errors (#418/#423), and the server's own
// log has no blocking-prerender-current-time / Date.now() prerender error. Failed-before: AuthGate and Settings read the
// session expiry clock before any request-time access, so Next logged `Route "/app/settings": ... unstable value Date.now()
// while prerendering` on every load.
// Run:  cd web && npm run build && npm run test:smoke:console
// Isolation is the shared smoke harness (throwaway database, network fence, off-host requests aborted). Exit 1 on any error.
// Missing playwright/build: NOT RUN, exit 2.
import { loadPlaywright, startServer } from '../smoke/harness.mjs'

const PAGES = ['/app', '/app/inbox', '/app/settings']
const VIEWPORTS = [{ width: 1280, height: 800 }, { width: 390, height: 844 }]
const { chromium } = loadPlaywright()
const srv = await startServer()
const failures = []
let browser
try {
  browser = await chromium.launch()
  for (const viewport of VIEWPORTS) for (const route of PAGES) {
    const c = await browser.newContext({ viewport })
    await c.addCookies([{ name: 'dazl_session', value: srv.token, url: srv.base }])
    await c.route('**/*', r => new URL(r.request().url()).origin === srv.base ? r.continue() : r.abort())
    const page = await c.newPage()
    const errs = []
    // Aborted off-host requests surface as "Failed to load resource": not an app error.
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(`console: ${m.text().slice(0, 300)}`) })
    page.on('pageerror', e => errs.push(`pageerror: ${String(e).slice(0, 300)}`))
    await page.goto(srv.base + route, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1000)
    if (new URL(page.url()).pathname !== route) errs.push(`redirected to ${page.url()}`)
    if (await page.locator('#main').count() === 0) errs.push('#main never rendered')
    for (const e of errs) failures.push(`${route} @${viewport.width}: ${e}`)
    console.log(`${errs.length ? 'FAIL' : 'ok  '} ${route} @${viewport.width}`)
    await c.close()
  }
  const log = srv.log()
  if (/blocking-prerender-current-time|unstable value `?Date\.now\(\)/.test(log)) failures.push(`server log has a Date.now() prerender error: ${(log.match(/Route "[^"]+"[^\n]*Date\.now[^\n]*/) ?? [''])[0].slice(0, 200)}`)
  if (/blocking-prerender-dynamic|uncached data during prerendering/.test(log)) failures.push('server log has a blocking-prerender-dynamic error')
} finally {
  await browser?.close()
  srv.stop()
}
if (failures.length) { console.error(`\n${failures.length} failure(s):\n${failures.map(f => ' - ' + f).join('\n')}`); process.exit(1) }
console.log('app console clean: 0 errors on every route and viewport')
