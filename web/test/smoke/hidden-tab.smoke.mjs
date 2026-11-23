// #1463 on the production build, in Chromium. NOT part of `npm test`; runs in the browser lane via `npm run test:smoke:chunks`.
// A tab that is not visible (a background tab, a minimized or covered window, a tab an automation drives without showing it) gets
// no animation frames. React's streamed-page script reveals the first Suspense boundary inside requestAnimationFrame
// (react-dom-server: `$RC` ... `requestAnimationFrame($RV.bind(null,$RB))`), and retries hydration of it the same way. So in a
// hidden tab the complete /app page arrives, sits unrevealed behind "Opening your workspace…", nothing hydrates and no data
// request is ever made, however healthy the server is. The stall watch then spends its one reload and shows "This is taking too
// long" - and a reload in a hidden tab ends the same way, every time.
// Expected: a hidden tab opens the workspace like a visible one: fallback gone, page hydrated, no reload, no stall notice.
//
// Headless Chromium (and Playwright's focus emulation) has no hidden state, so the page is put in one the way the browser does it:
// visibilityState 'hidden' and requestAnimationFrame callbacks never run. Checked by hand against a real background tab in a
// headed Chromium over raw CDP: the same stuck state for 45 s (2 documents, 0 data requests, the notice up), and the page opened
// the moment the tab was brought to the front.
import assert from 'node:assert/strict'
import { loadPlaywright, startServer, newContext } from './harness.mjs'
const { chromium } = loadPlaywright()

const srv = await startServer()
let browser
try {
  browser = await chromium.launch()
  const ctx = await newContext(browser, srv)
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    let n = 0
    window.requestAnimationFrame = () => ++n // a hidden tab is never given a frame
    window.cancelAnimationFrame = () => {}
  })
  const docs = [], rsc = []
  page.on('request', r => {
    if (r.resourceType() === 'document') docs.push(new URL(r.url()).pathname)
    else if (r.url().includes('_rsc=') || new URL(r.url()).pathname.startsWith('/api/')) rsc.push(new URL(r.url()).pathname)
  })
  const t0 = Date.now()
  await page.goto(srv.base + '/app/settings', { waitUntil: 'domcontentloaded' })
  const state = () => page.evaluate(() => ({
    visibility: document.visibilityState,
    fallback: !!document.getElementById('workspace-opening'),
    // the streamed page, delivered but not yet moved into place
    arrivedUnrevealed: !!document.querySelector('div[hidden][id^="S:"]'),
    notice: document.body.innerText.includes('This is taking too long'),
    // React marks a hydrated element with a __reactFiber/__reactProps key
    hydrated: [...document.querySelectorAll('main *')].some(el => Object.keys(el).some(k => k.startsWith('__reactProps'))),
    budget: sessionStorage.getItem('dazl-stall-reload'),
  }))
  await page.waitForTimeout(4000)
  const early = await state()
  console.log(`hidden tab, 4s after load: ${JSON.stringify(early)}`)
  assert.equal(early.visibility, 'hidden', 'precondition: the tab is hidden')
  // past one stall window and, if the watch reloaded, past the second
  await page.waitForTimeout(28000)
  const late = await state()
  console.log(`after ${Math.round((Date.now() - t0) / 1000)}s: ${JSON.stringify(late)}, documents=[${docs.join(', ')}], data requests=${rsc.length}`)
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/hidden-tab.png` }).catch(() => {})
  assert.equal(late.fallback, false, 'the workspace opened in the hidden tab: no "Opening your workspace…" left')
  assert.equal(late.hydrated, true, 'the page hydrated in the hidden tab')
  assert.deepEqual(docs, ['/app/settings'], 'no reload was spent on a page that had arrived')
  assert.equal(late.notice, false, 'no "This is taking too long" notice')
  assert.equal(late.budget, null, 'the recovery budget is untouched')
  console.log('\nA hidden tab opens the workspace: revealed, hydrated, no reload, no stall notice.')
} finally {
  await browser?.close(); srv.stop()
}
