// #673 follow-up: the "Skip to content" link moves keyboard FOCUS (not just the URL hash) to <main id="main"> on the
// public pages, after hydration settles. Signed-out browser, production build, throwaway database (test/smoke/harness.mjs),
// off-host requests aborted. Desktop 1280x900 and Playwright's iPhone 13 (390px) descriptor (emulation, not a device).
// Per page: load, wait for networkidle + settle, Tab once (must be the skip link), Enter, then document.activeElement
// must be #main. Not covered here: sign-up's post-submit "Check your email" state (needs a mail-enabled signup);
// its <main> is held to tabIndex={-1} by test/public-skip-link-focus-target.test.ts.
// Run: cd web && npm run build && node test/ui/public-skip-link-focus.ui.mjs   (NOT RUN, exit 2, without build/playwright)
import { loadPlaywright, startServer } from '../smoke/harness.mjs'
const { chromium, devices } = loadPlaywright()

const PAGES = ['/', '/sign-in', '/sign-up', '/reset', '/verify', '/privacy', '/terms']
const iphone = { ...devices['iPhone 13'], reducedMotion: 'reduce' }; delete iphone.defaultBrowserType
const VIEWPORTS = { desktop: { viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' }, 'iphone-13': iphone }

const failures = []
const fail = (where, msg) => { failures.push(`${where}: ${msg}`); console.log(`     FAIL ${msg}`) }

const srv = await startServer()
const { base } = srv
let browser
try {
  browser = await chromium.launch()
  for (const [vp, desc] of Object.entries(VIEWPORTS)) {
    const ctx = await browser.newContext(desc)
    await ctx.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
    for (const pathname of PAGES) {
      const key = `${vp} ${pathname}`
      console.log(`---- ${key}`)
      const page = await ctx.newPage()
      const res = await page.goto(base + pathname, { waitUntil: 'networkidle' })
      await page.waitForTimeout(500) // hydration settles
      if (!res || res.status() >= 400) { fail(key, `HTTP ${res?.status()}`); await page.close(); continue }
      if (!(await page.evaluate(() => !!document.getElementById('main')))) { fail(key, 'no #main on the page'); await page.close(); continue }
      await page.keyboard.press('Tab')
      if (!(await page.evaluate(() => document.activeElement?.classList.contains('skip-link')))) fail(key, 'first Tab stop is not the skip link')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(100)
      const active = await page.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName.toLowerCase()}${a.id ? '#' + a.id : ''}` : 'null' })
      if (active !== 'main#main') fail(key, `after Enter on the skip link focus is on ${active}, not main#main`)
      else console.log('     focus on main#main')
      await page.close()
    }
    await ctx.close()
  }
} finally {
  await browser?.close()
  try { srv.stop() } catch (e) { console.log(`(temp cleanup: ${e.code})`) }
}
if (failures.length) { console.log(`\n${failures.length} problem(s):\n- ${failures.join('\n- ')}`); process.exit(1) }
console.log(`\nPublic skip link moves focus to #main: ${PAGES.length} pages x ${Object.keys(VIEWPORTS).length} viewports.`)
