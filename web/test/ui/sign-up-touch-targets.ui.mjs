// #672 sign-up follow-up (stacked on #608): every interactive control on /sign-up has a hit target of at least 44x44 CSS px
// at a 390px phone viewport, measured on the production build after hydration settles. This replaces the temporary
// /sign-up NAMED exceptions in test/ui/touch-targets.ui.mjs (#957), which existed only because sign-up-form.tsx was
// owned by #608. Once this lands, those two NAMED rules must be deleted from #957's test.
// Only one exception class exists here, written out: INLINE, a link inside a run of sentence text (WCAG 2.5.8's inline
// exception), e.g. the "Terms of Service" / "Privacy Policy" links in the consent sentence. Nothing else is skipped.
// Signed out, throwaway database (test/smoke/harness.mjs), off-host requests aborted. Nothing is sent or billed.
// Run: cd web && npm run build && node test/ui/sign-up-touch-targets.ui.mjs   (NOT RUN, exit 2, without build/playwright)
import { loadPlaywright, startServer } from '../smoke/harness.mjs'

const MIN = 44
const ROUTE = '/sign-up'
const VIEWPORT = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, reducedMotion: 'reduce' }

const MEASURE = () => {
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, label[for], [role="button"], [role="link"], [role="tab"], [tabindex]:not([tabindex="-1"])'
  const out = []
  const name = el => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  const blockParent = el => { let p = el.parentElement; while (p && getComputedStyle(p).display.startsWith('inline')) p = p.parentElement; return p }
  for (const el of document.querySelectorAll(sel)) {
    if (el.closest('[inert]') || el.classList.contains('skip-link')) continue
    const r = el.getBoundingClientRect()
    if (el.matches('input') && (r.width < 2 || r.height < 2 || getComputedStyle(el).opacity === '0')) continue
    if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: false })) continue
    if (r.width === 0 && r.height === 0) continue
    let inline = false
    if (el.matches('a') && getComputedStyle(el).display === 'inline') {
      const bp = blockParent(el)
      const own = (el.textContent || '').trim()
      const all = (bp?.textContent || '').replace(/\s+/g, ' ').trim()
      inline = !!bp && all.length > own.length + 1
    }
    out.push({ tag: el.tagName.toLowerCase(), name: name(el), w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100, inline })
  }
  return out
}

const { chromium } = loadPlaywright()
const srv = await startServer()
const failures = []
let browser
try {
  browser = await chromium.launch()
  const c = await browser.newContext(VIEWPORT)
  await c.route('**/*', r => new URL(r.request().url()).origin === srv.base ? r.continue() : r.abort())
  const page = await c.newPage()
  await page.goto(srv.base + ROUTE, { waitUntil: 'networkidle' })
  if (new URL(page.url()).pathname !== ROUTE) failures.push(`${ROUTE}: redirected to ${page.url()}, controls not measured`)
  await page.waitForTimeout(800)
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  const got = await page.evaluate(MEASURE)
  let ok = 0, inline = 0
  for (const t of got) {
    if (t.w >= MIN && t.h >= MIN) { ok++; continue }
    if (t.inline) { inline++; console.log(`     exception INLINE ${ROUTE} ${t.tag} "${t.name}" ${t.w}x${t.h} (link inside sentence text)`); continue }
    failures.push(`${ROUTE}: ${t.tag} "${t.name}" is ${t.w}x${t.h}, under ${MIN}x${MIN}`)
  }
  // The logo and "Sign in" link must be measured, not silently absent.
  for (const must of [/^dazl\.?$/, /^Sign in$/]) if (!got.some(t => must.test(t.name))) failures.push(`${ROUTE}: expected control ${must} was not found`)
  console.log(`${failures.length ? 'FAIL' : 'ok  '} ${ROUTE}: ${got.length} control(s), ${ok} >= ${MIN}px, ${inline} inline exception(s)`)
  if (got.length === 0) failures.push(`${ROUTE}: no controls measured (page did not render?)`)
  await c.close()
} finally {
  await browser?.close()
  srv.stop()
}
if (failures.length) { console.log(`\nFAIL: ${failures.length} problem(s):\n  ${failures.join('\n  ')}`); process.exit(1) }
console.log(`OK: every control on ${ROUTE} is at least ${MIN}x${MIN} CSS px at 390px, or an inline sentence link`)
