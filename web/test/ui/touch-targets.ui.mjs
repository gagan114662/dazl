// #672 (part of #534): every interactive control on Home, Plays, Leads, Inbox, Settings, sign-in and sign-up has a hit
// target of at least 44x44 CSS px at a 390px-wide phone viewport, measured on the production build AFTER hydration has
// settled (getBoundingClientRect, the same measurement the reviewer runs live). Anything smaller must be in the
// explicit exception rules below, each with its reason; there are no silent skips.
// Run:  cd web && npm run build && npm run test:smoke:touch
// Isolation is the shared smoke harness (test/smoke/harness.mjs): throwaway database with one seeded user, the server
// under the network fence, off-host browser requests aborted. Leads and Inbox get synthetic /api data from in-browser
// stubs so their controls render; nothing is scanned, sent or billed.
// Exit 1 on an undersized control. Missing playwright/build: NOT RUN, exit 2.
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadPlaywright, startServer } from '../smoke/harness.mjs'

const MIN = 44
const PAGES = ['/app', '/app?known=1', '/app/plays', '/app/leads?job_id=' + 'b'.repeat(24) + '&passive=1', '/app/inbox', '/app/settings', '/sign-in', '/sign-up']
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

// Page-specific content that must be on screen before measuring: the shared header and sidebar alone would otherwise
// let an unrendered page (empty fixture, API path or schema drift) pass with only the shared controls (#672 review).
const MARKERS = {
  '/app': '[data-testid="onboarding-screen"], #main h1',
  '/app/plays': '[data-testid="saved-play"]',
  '/app/leads': '[data-testid="lead-card"]',
  '/app/inbox': '[data-testid="inbox-thread"]',
  '/app/settings': '#main h1',
  '/sign-in': 'main form',
  '/sign-up': 'main form',
}

const MEASURE = () => {
  // Labels are not measured on their own: a label is part of its control's hit area (tapping it activates the control).
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [tabindex]:not([tabindex="-1"])'
  const out = []
  const name = el => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  const blockParent = el => { let p = el.parentElement; while (p && getComputedStyle(p).display.startsWith('inline')) p = p.parentElement; return p }
  const visible = n => n.checkVisibility({ visibilityProperty: true, opacityProperty: false }) && (n.getBoundingClientRect().width > 1 || n.getBoundingClientRect().height > 1)
  const score = r => Math.min(r.width, r.height)
  let i = 0
  for (const el of document.querySelectorAll(sel)) {
    if (el.closest('[inert]') || el.classList.contains('skip-link')) continue
    // Closed <details> contents are not hit targets until opened.
    if (el.closest('details:not([open])') && !el.matches('summary')) continue
    let r0 = el.getBoundingClientRect(); let via = null
    const hiddenInput = el.matches('input') && (r0.width < 2 || r0.height < 2 || getComputedStyle(el).opacity === '0')
    // A form control's hit area includes its labels, explicit (for=) and implicit (wrapping), via el.labels: the best of
    // the control and its visible labels is what a finger can hit. A visually hidden input (the CSS-only nav toggle,
    // sr-only checkboxes) is hit only through its labels; without a visible one it is not a target.
    if (el.matches('input, select, textarea')) {
      const labels = [...(el.labels ?? [])].filter(visible)
      if (hiddenInput && labels.length === 0) continue
      for (const l of labels) { const lr = l.getBoundingClientRect(); if (hiddenInput && !via || score(lr) > score(r0)) { r0 = lr; via = l } }
    }
    if (!via && !visible(el)) continue
    if (r0.width === 0 && r0.height === 0) continue
    let inline = false
    if (el.matches('a') && getComputedStyle(el).display === 'inline') {
      const bp = blockParent(el)
      const own = (el.textContent || '').trim()
      const all = (bp?.textContent || '').replace(/\s+/g, ' ').trim()
      inline = !!bp && all.length > own.length + 1
    }
    const target = via ?? el
    target.dataset.tt = `t${i++}`
    out.push({ id: target.dataset.tt, tag: el.tagName.toLowerCase() + (via ? ' (via label)' : ''), name: name(el) || name(target), w: Math.round(r0.width * 100) / 100, h: Math.round(r0.height * 100) / 100, inline })
  }
  return out
}

// Occlusion (#672 review): another control's hit box must not cover part of this one. Each target is scrolled into
// view and sampled 2px inside its edges and at its centre; a point that hits a DIFFERENT interactive control fails.
const OCCLUDED = id => {
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, label, [role="button"], [role="link"], [role="tab"], [tabindex]:not([tabindex="-1"])'
  const el = document.querySelector(`[data-tt="${id}"]`)
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const r = el.getBoundingClientRect()
  const xs = [r.left + 2, r.left + r.width / 2, r.right - 2], ys = [r.top + 2, r.top + r.height / 2, r.bottom - 2]
  const own = n => el.contains(n) || n.contains(el) || (el.matches('label') && el.control && (el.control === n || el.control.contains(n))) || (n.matches?.('label') && n.control === el)
  for (const x of xs) for (const y of ys) {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue
    const hit = document.elementFromPoint(x, y)
    if (!hit) continue
    const ctl = hit.closest(sel)
    if (ctl && !own(ctl) && !own(hit)) return `${ctl.tagName.toLowerCase()} "${(ctl.getAttribute('aria-label') || ctl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)}" covers it at ${Math.round(x - r.left)},${Math.round(y - r.top)}`
  }
  return null
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
    try { await page.locator(MARKERS[path]).first().waitFor({ state: 'visible', timeout: 15000 }) } catch { failures.push(`${path}: page content (${MARKERS[path]}) never rendered, so its own controls were not measured`); await c.close(); continue }
    // #1771: <main> is hidden while the phone menu is open, so the page's own controls are measured FIRST with the menu closed,
    // then the nav rows with it open (the shared header is measured in both states).
    let checked = 0, excepted = 0
    const checkAll = async list => {
    for (const t of list) {
      const cover = await page.evaluate(OCCLUDED, t.id)
      if (cover) failures.push(`${path}: ${t.tag} "${t.name}" is partly covered: ${cover}`)
      if (t.w >= MIN && t.h >= MIN) { checked++; continue }
      if (t.inline) { excepted++; console.log(`     exception INLINE ${path} ${t.tag} "${t.name}" ${t.w}x${t.h} (link inside sentence text)`); continue }
      const named = NAMED.find(n => n.page === path && n.name.test(t.name))
      if (named) { excepted++; console.log(`     exception NAMED ${path} ${t.tag} "${t.name}" ${t.w}x${t.h} (${named.reason})`); continue }
      failures.push(`${path}: ${t.tag} "${t.name}" is ${t.w}x${t.h}, under ${MIN}x${MIN}`)
    }
    }
    const got = [...await page.evaluate(MEASURE)]
    await checkAll(got)
    // The app's nav lives behind the Menu label below md (hidden until the checkbox is on): open it the way a user does, so its
    // rows are measured too (the closed-menu run missed 36px rows, #672 live review). Plain /app is the first-run onboarding
    // screen, a fixed full-screen overlay that legitimately covers the shell, so it has no Menu to open; the returning-account
    // Home (/app?known=1, profile stubbed as a known business) is measured with the Menu open instead.
    if (route.startsWith('/app') && route !== '/app') {
      try {
        await page.locator('label[for="navtoggle"]').click({ timeout: 15000 })
        await page.locator('nav[aria-label="Main"] a').first().waitFor({ state: 'visible', timeout: 15000 })
      } catch (e) { failures.push(`${path}: the Menu could not be opened by a click on its visible label, so the nav rows were not measured (${String(e.message).split('\n')[0].slice(0, 160)})`) }
    }
    { const open = await page.evaluate(MEASURE); got.push(...open); await checkAll(open) }
    console.log(`${failures.some(f => f.startsWith(path + ':')) ? 'FAIL' : 'ok  '} ${path}: ${got.length} control(s), ${checked} >= ${MIN}px, ${excepted} listed exception(s)`)
    if (got.length === 0) failures.push(`${path}: no controls measured (page did not render?)`)
    await c.close()
  }
  // #1771: the open phone menu is the whole page body with ONE scroll. Measured signed in at 390px on a tall and a short phone:
  // while it is open <main> is hidden, the document does not scroll, exactly one element scrolls (the menu itself), Settings and
  // Sign out can be brought into view inside the viewport by scrolling it, and the Menu label still closes it.
  for (const height of [844, 500]) {
    const c = await browser.newContext({ ...VIEWPORT, viewport: { width: 390, height } })
    await c.addCookies([{ name: 'dazl_session', value: srv.token, url: srv.base }])
    await c.route('**/*', r => new URL(r.request().url()).origin === srv.base ? r.continue() : r.abort())
    const page = await c.newPage()
    await stubApis(page, '/app/settings')
    const tag = `menu@390x${height}`
    try {
      await page.goto(srv.base + '/app/settings', { waitUntil: 'networkidle' })
      await page.waitForTimeout(800)
      await page.locator(MARKERS['/app/settings']).first().waitFor({ state: 'visible', timeout: 15000 })
      await page.locator('label[for="navtoggle"]').click({ timeout: 15000 })
      await page.locator('nav[aria-label="Main"] a').first().waitFor({ state: 'visible', timeout: 15000 })
      // Pixels of the open menu for the reviewer (CI keeps web/preview/menu-1771/*.png when the workflow uploads it); never decides pass or fail.
      try { mkdirSync(new URL('../../preview/menu-1771/', import.meta.url), { recursive: true }); await page.screenshot({ path: fileURLToPath(new URL(`../../preview/menu-1771/menu-open-390x${height}.png`, import.meta.url)) }) } catch (e) { console.log(`     (no screenshot saved for ${tag}: ${String(e.message).split('\n')[0].slice(0, 120)})`) }
      const m = await page.evaluate(() => {
        const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0 }
        const scrollers = [...document.querySelectorAll('body *')].filter(el => vis(el) && /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1).map(el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''))
        const doc = document.scrollingElement
        const aside = document.querySelector('aside'), main = document.querySelector('#main')
        const ar = aside.getBoundingClientRect()
        const header = document.querySelector('header')
        return { scrollers, docOverflow: doc.scrollHeight - innerHeight, mainShown: vis(main), asideTop: Math.round(ar.top), asideBottom: Math.round(ar.bottom), headerBottom: Math.round(header.getBoundingClientRect().bottom), vh: innerHeight }
      })
      if (m.mainShown) failures.push(`${tag}: <main> is still shown behind the open menu`)
      if (m.docOverflow > 1) failures.push(`${tag}: the page itself scrolls (${m.docOverflow}px past the viewport) while the menu is open`)
      if (m.asideBottom > m.vh + 1) failures.push(`${tag}: the menu runs ${m.asideBottom - m.vh}px past the bottom of the screen`)
      if (m.asideTop < m.headerBottom - 1) failures.push(`${tag}: the menu covers the header (top ${m.asideTop} < header bottom ${m.headerBottom}), so the Menu label could not close it`)
      if (m.scrollers.length > 1) failures.push(`${tag}: more than one scroller while open: ${m.scrollers.join(', ')}`)
      for (const [name, loc] of [['Settings', page.locator('aside a', { hasText: /^Settings$/ }).first()], ['Sign out', page.locator('aside button', { hasText: /^Sign out$/ }).first()]]) {
        await loc.scrollIntoViewIfNeeded({ timeout: 5000 })
        const box = await loc.boundingBox()
        const inView = box && box.y >= 0 && box.y + box.height <= height + 1 && box.y >= m.headerBottom - 1
        if (!inView) failures.push(`${tag}: "${name}" cannot be brought into view by scrolling the menu (${JSON.stringify(box)})`)
        else {
          const top = await loc.evaluate(el => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit && (el === hit || el.contains(hit) || hit.contains(el)) })
          if (!top) failures.push(`${tag}: "${name}" is in view but covered by another element`)
        }
      }
      await page.locator('label[for="navtoggle"]').click({ timeout: 5000 })
      const closed = await page.evaluate(() => getComputedStyle(document.querySelector('aside')).display === 'none')
      const mainBack = await page.evaluate(() => getComputedStyle(document.querySelector('#main')).display !== 'none')
      if (!closed || !mainBack) failures.push(`${tag}: the Menu label did not close the menu and bring the page back`)
      // Review fix: "Skip to content" with the menu open must close it and land focus on the visible <main>.
      await page.locator('label[for="navtoggle"]').click({ timeout: 5000 })
      await page.locator('a.skip-link').focus()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(300)
      const skip = await page.evaluate(() => ({ checked: document.getElementById('navtoggle').checked, shown: getComputedStyle(document.querySelector('#main')).display !== 'none', focused: document.activeElement?.id === 'main' }))
      if (skip.checked || !skip.shown || !skip.focused) failures.push(`${tag}: "Skip to content" with the menu open did not reach <main> (menu still open: ${skip.checked}, main shown: ${skip.shown}, main focused: ${skip.focused})`)
      console.log(`${failures.some(f => f.startsWith(tag)) ? 'FAIL' : 'ok  '} ${tag}: scrollers=${m.scrollers.join('+') || 'none'}, aside ${m.asideTop}-${m.asideBottom} of ${m.vh}, doc overflow ${m.docOverflow}px`)
    } catch (e) { failures.push(`${tag}: could not be measured (${String(e.message).split('\n')[0].slice(0, 200)})`) }
    await c.close()
  }
} finally {
  await browser?.close()
  srv.stop()
}
if (failures.length) { console.log(`\nFAIL: ${failures.length} undersized control(s) at 390px:\n  ${failures.join('\n  ')}`); process.exit(1) }
console.log(`OK: every measured control on ${PAGES.length} pages is at least ${MIN}x${MIN} CSS px at 390px, or a listed exception; the open phone menu is one scroll (tall and short phone)`)

// Synthetic /api answers so Leads and Inbox render their real controls (same shapes as test/ui/frontend-baseline.ui.mjs).
async function stubApis(page, route) {
  const JOB = 'b'.repeat(24)
  const now = Math.floor(Date.now() / 1000)
  const lead = (id, company, over = {}) => ({ id, name: '', company, contact: null, signal: `${company} opened a second office`, source_url: `https://www.news.example/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} opened a second office`, event_date: '2026-10-01', date_status: 'unverified', confidence: 80, review_reason: null, company_domain: null, human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 3, action: 3, why: `${company} matches your dental owner profile.`, signals: null, icp_match: null, enrichments: [], events: [], ...over })
  const LEADS = [lead('a'.repeat(24), 'Bright Dental', { contact: 'hello@brightdental.example' }), lead('c'.repeat(24), 'Lakeside Smiles')]
  const ICP = { summary: 'Growing dental practices', who: ['Practice owner'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['new location'], exclude: [] }
  const THREADS = [{ thread_id: 't1', gmail_id: 'g1', lead_id: 'l1', job_id: JOB, from_email: 'ceo@older.example', excerpt: 'Yes - send details', classification: 'positive', received_at: now - 3600, replies: 2, company: 'Older Co', lead_name: 'Sam', followups_sent: 1, stopped: null, unread: true, needs_owner: true }]
  const T = Math.floor(Date.UTC(2026, 9, 26, 12) / 1000)
  const WATCHES = [{ id: 'e'.repeat(24), query: 'Dental practices in Leeds opening a second location', icp: { summary: 'Independent dental practices', who: ['Practice owner'], where: ['Leeds, UK'], signals: ['opening a second location'] }, active: true, next_run_at: T + 7 * 86400, last_run_at: T, paused_reason: null, last_job_id: JOB, last_status: 'done', new_leads: 3 }]
  const MONITORS = [{ id: 'f'.repeat(24), query: 'Accounting firms in Bristol hiring payroll staff', icp: JSON.stringify({ summary: 'Accounting firms', where: ['Bristol, UK'], signals: ['hiring payroll staff'] }), interval_hours: 24, enabled: 1, paused_reason: null, last_run_at: null, next_run_at: T + 86400, last_new_count: null, run_count: 0, last_job_id: null }]
  const STUBS = {
    // A returning account: the business is known, so Home shows the journey, not the first-run overlay.
    '/app': { '/api/settings/profile': { website: 'https://harborledger.example', sells: 'Payment tooling for clinics', business_name: 'Harbor Ledger', buyer: null }, '/api/scan/jobs': { jobs: [] } },
    // #1471: Plays reads GET /api/plays (its repeating plays' rows ride along)
    '/app/plays': { '/api/plays': { plays: [...WATCHES.map(w => ({ key: `watch-${w.id}`, kind: 'watch', id: w.id, query: w.query, runs: [], last_job_id: w.last_job_id, last_run_at: w.last_run_at, last_status: null })), ...MONITORS.map(m => ({ key: `monitor-${m.id}`, kind: 'monitor', id: m.id, query: m.query, runs: [], last_job_id: m.last_job_id, last_run_at: m.last_run_at, last_status: null }))], watches: WATCHES, monitors: MONITORS, emails: false } },
    '/app/leads': { '/api/scan/status': { status: 'done', lead_count: LEADS.length, icp: ICP, icp_source: 'user', attempts: 1, max_attempts: 3, query: 'Dental practice owners in Ohio opening a new location' }, '/api/leads': { job_id: JOB, status: 'done', hidden_count: 0, leads: LEADS }, '/api/scan/jobs': { jobs: [] }, '/api/enrich/held': { held: [] } },
    '/app/inbox': { '/api/outreach/inbox': { available: true, consent_accepted: true, read_granted: true, account: 'me@x.example', booking_url: null, threads: THREADS, next_cursor: null, counts: { threads: 1, needs_owner: 1, unread: 1, unread_needs_owner: 1 } } },
  }
  const stubs = route === '/app' ? undefined : STUBS[route.split('?')[0]]
  if (!stubs) return
  await page.route('**/api/**', r => {
    const body = stubs[new URL(r.request().url()).pathname]
    return body ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }) : r.continue()
  })
}
