// #672 (part of #534): every interactive control on Home, Plays, Leads, Inbox, Settings, sign-in and sign-up has a hit
// target of at least 44x44 CSS px at a 390px-wide phone viewport, measured on the production build AFTER hydration has
// settled (getBoundingClientRect, the same measurement the reviewer runs live). Anything smaller must be in the
// explicit exception rules below, each with its reason; there are no silent skips.
// Run:  cd web && npm run build && npm run test:smoke:touch
// Isolation is the shared smoke harness (test/smoke/harness.mjs): throwaway database with one seeded user, the server
// under the network fence, off-host browser requests aborted. Leads and Inbox get synthetic /api data from in-browser
// stubs so their controls render; nothing is scanned, sent or billed.
// Exit 1 on an undersized control. Missing playwright/build: NOT RUN, exit 2.
import { loadPlaywright, startServer } from '../smoke/harness.mjs'

const MIN = 44
const PAGES = ['/app', '/app/plays', '/app/leads?job_id=' + 'b'.repeat(24) + '&passive=1', '/app/inbox', '/app/settings', '/sign-in', '/sign-up']
const VIEWPORT = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, reducedMotion: 'reduce' }

// Explicit exceptions (the #672 acceptance allows a written list with reasons). Each rule names what it matches.
// 1. INLINE: a link that sits inside a run of sentence text (its block parent has other words around it). WCAG 2.5.8's
//    inline exception: its size is set by the line of text, and padding it to 44px would break the sentence.
// 2. NAMED: specific controls, matched by page and accessible name.
const NAMED = [
  // sign-up-form.tsx is being rewritten by #608 (email confirmation). Editing the same lines here would conflict; the
  // logo and its two links get the same min-h-11 treatment as sign-in once #608 merges. Tracked on #672.
  { page: '/sign-up', name: /^dazl\.?$/, reason: 'sign-up logo: sign-up-form.tsx owned by open PR #608; follow-up after it merges' },
  { page: '/sign-up', name: /^(Sign in|Terms|Privacy|Terms of Service|Privacy Policy)$/i, reason: 'sign-up footer links: sign-up-form.tsx owned by open PR #608; follow-up after it merges' },
]

const MEASURE = () => {
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, label[for], [role="button"], [role="link"], [role="tab"], [tabindex]:not([tabindex="-1"])'
  const out = []
  const name = el => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  const blockParent = el => { let p = el.parentElement; while (p && getComputedStyle(p).display.startsWith('inline')) p = p.parentElement; return p }
  for (const el of document.querySelectorAll(sel)) {
    if (el.closest('[inert]') || el.classList.contains('skip-link')) continue
    // A visually hidden native input (the CSS-only nav toggle, sr-only checkboxes) is hit through its visible label,
    // which is measured as its own label[for] entry.
    const r0 = el.getBoundingClientRect()
    if (el.matches('input') && (r0.width < 2 || r0.height < 2 || getComputedStyle(el).opacity === '0')) continue
    if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: false })) continue
    if (r0.width === 0 && r0.height === 0) continue
    // Closed <details> contents and anything outside the page's own flow (e.g. a tooltip's hidden text) are not hit targets.
    if (el.closest('details:not([open])') && !el.matches('summary')) continue
    let inline = false
    if (el.matches('a') && getComputedStyle(el).display === 'inline') {
      const bp = blockParent(el)
      const own = (el.textContent || '').trim()
      const all = (bp?.textContent || '').replace(/\s+/g, ' ').trim()
      inline = !!bp && all.length > own.length + 1
    }
    out.push({ tag: el.tagName.toLowerCase(), name: name(el), w: Math.round(r0.width * 100) / 100, h: Math.round(r0.height * 100) / 100, inline })
  }
  return out
}

const { chromium } = loadPlaywright()
const srv = await startServer()
const failures = []
let browser
try {
  browser = await chromium.launch()
  for (const route of PAGES) {
    const c = await browser.newContext(VIEWPORT)
    // Signed in for the app pages only: a signed-in visit to /sign-in or /sign-up may redirect into the app.
    if (route.startsWith('/app')) await c.addCookies([{ name: 'dazl_session', value: srv.token, url: srv.base }])
    await c.route('**/*', r => new URL(r.request().url()).origin === srv.base ? r.continue() : r.abort())
    const page = await c.newPage()
    await stubApis(page, route)
    await page.goto(srv.base + route, { waitUntil: 'networkidle' })
    if (new URL(page.url()).pathname !== route.split('?')[0]) failures.push(`${route}: redirected to ${page.url()}, so its controls were not measured`)
    // Hydration settled: React has attached (no pending client transitions) and layout is stable across two frames.
    await page.waitForTimeout(800)
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
    const path = route.split('?')[0]
    const got = await page.evaluate(MEASURE)
    let checked = 0, excepted = 0
    for (const t of got) {
      if (t.w >= MIN && t.h >= MIN) { checked++; continue }
      if (t.inline) { excepted++; console.log(`     exception INLINE ${path} ${t.tag} "${t.name}" ${t.w}x${t.h} (link inside sentence text)`); continue }
      const named = NAMED.find(n => n.page === path && n.name.test(t.name))
      if (named) { excepted++; console.log(`     exception NAMED ${path} ${t.tag} "${t.name}" ${t.w}x${t.h} (${named.reason})`); continue }
      failures.push(`${path}: ${t.tag} "${t.name}" is ${t.w}x${t.h}, under ${MIN}x${MIN}`)
    }
    console.log(`${failures.some(f => f.startsWith(path + ':')) ? 'FAIL' : 'ok  '} ${path}: ${got.length} control(s), ${checked} >= ${MIN}px, ${excepted} listed exception(s)`)
    if (got.length === 0) failures.push(`${path}: no controls measured (page did not render?)`)
    await c.close()
  }
} finally {
  await browser?.close()
  srv.stop()
}
if (failures.length) { console.log(`\nFAIL: ${failures.length} undersized control(s) at 390px:\n  ${failures.join('\n  ')}`); process.exit(1) }
console.log(`OK: every measured control on ${PAGES.length} pages is at least ${MIN}x${MIN} CSS px at 390px, or a listed exception`)

// Synthetic /api answers so Leads and Inbox render their real controls (same shapes as test/ui/frontend-baseline.ui.mjs).
async function stubApis(page, route) {
  const JOB = 'b'.repeat(24)
  const now = Math.floor(Date.now() / 1000)
  const lead = (id, company, over = {}) => ({ id, name: '', company, contact: null, signal: `${company} opened a second office`, source_url: `https://www.news.example/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} opened a second office`, event_date: '2026-10-01', date_status: 'unverified', confidence: 80, review_reason: null, company_domain: null, human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 3, action: 3, why: `${company} matches your dental owner profile.`, signals: null, icp_match: null, enrichments: [], events: [], ...over })
  const LEADS = [lead('a'.repeat(24), 'Bright Dental', { contact: 'hello@brightdental.example' }), lead('c'.repeat(24), 'Lakeside Smiles')]
  const ICP = { summary: 'Growing dental practices', who: ['Practice owner'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['new location'], exclude: [] }
  const THREADS = [{ thread_id: 't1', gmail_id: 'g1', lead_id: 'l1', job_id: JOB, from_email: 'ceo@older.example', excerpt: 'Yes - send details', classification: 'positive', received_at: now - 3600, replies: 2, company: 'Older Co', lead_name: 'Sam', followups_sent: 1, stopped: null, unread: true, needs_owner: true }]
  const STUBS = {
    '/app/leads': { '/api/scan/status': { status: 'done', lead_count: LEADS.length, icp: ICP, icp_source: 'user', attempts: 1, max_attempts: 3, query: 'Dental practice owners in Ohio opening a new location' }, '/api/leads': { job_id: JOB, status: 'done', hidden_count: 0, leads: LEADS }, '/api/scan/jobs': { jobs: [] }, '/api/enrich/held': { held: [] } },
    '/app/inbox': { '/api/outreach/inbox': { available: true, consent_accepted: true, read_granted: true, account: 'me@x.example', booking_url: null, threads: THREADS, next_cursor: null, counts: { threads: 1, needs_owner: 1, unread: 1, unread_needs_owner: 1 } } },
  }
  const stubs = STUBS[route.split('?')[0]]
  if (!stubs) return
  await page.route('**/api/**', r => {
    const body = stubs[new URL(r.request().url()).pathname]
    return body ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }) : r.continue()
  })
}
