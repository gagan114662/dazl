// Frontend quality baseline (#534) on the production build. NOT part of `npm test` (needs a build and a browser).
// Run:  cd web && npm run build && npm run test:smoke:frontend   (part of `npm run test:smoke`; SHOTS=<dir> saves one
// screenshot per page and viewport). Docs, inventory and the recorded baseline: docs/FRONTEND-BASELINE.md.
// Isolation (test/smoke/harness.mjs): throwaway database with one seeded user, server under test/helpers/net-fence.ts,
// off-host browser requests aborted. Leads and Inbox get their /api/* data from in-browser stubs (synthetic rows);
// everything else is the real fenced server. Nothing is scanned, sent or billed.
// For every page below, in Chromium at desktop (1280x900) and with Playwright's iPhone 13 and Pixel 7 device
// descriptors (viewport, DPR, touch, mobile UA - EMULATION, not a physical device):
//   1. axe-core (WCAG 2.0/2.1 A+AA and 2.2 AA, which includes target-size) violations must match
//      test/ui/frontend-baseline.json exactly: a new rule or more nodes fails, and so does a baseline entry that no
//      longer occurs (the baseline only ever lists violations that are still there).
//   2. keyboard: the first Tab lands on the skip link, Enter moves to #main; then Tab walks the page: every stop is
//      visible while focused and changes its look (a focus indicator), and every visible tabbable control is reached.
//   3. no horizontal page overflow at any viewport.
// And on the public routes (server HTML, i.e. what a crawler fetches): title, description, self canonical, og:* and
// twitter:* tags, og:url == canonical, the og:image is a 1200x630 PNG, robots.txt and sitemap.xml list them, and
// /pricing and /plans redirect to /#pricing. Live social-network previews are NOT checked here (no network).
// Exit 1 on a failed check. Missing playwright/axe-core/build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes that exit 0).
import { readFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadPlaywright, notRun, root, startServer } from '../smoke/harness.mjs'
const require = createRequire(path.join(root, 'package.json'))
const { chromium, devices } = loadPlaywright()
let axePath
try { axePath = require.resolve('axe-core/axe.min.js') } catch (e) { notRun(e.message.split('\n')[0]) }
const BASELINE = JSON.parse(readFileSync(path.join(root, 'test/ui/frontend-baseline.json'), 'utf8')).violations

// The origin baked into the build's static public pages (lib/site.ts SITE_BASE at build time). Absolute URLs found in
// the metadata, robots and sitemap are fetched from the local server instead, so nothing leaves this machine.
const SITE = process.env.PUBLIC_BASE_URL || 'https://dazl.ai'
const PUBLIC = ['/', '/sign-in', '/sign-up', '/privacy', '/terms', '/reset']
const NOINDEX = new Set(['/reset']) // opened from an emailed one-time link: never indexed, no canonical, not in the sitemap
const APP = ['/app/leads?job_id=' + 'b'.repeat(24) + '&passive=1', '/app/inbox', '/app/settings']
// reducedMotion: the homepage demo then shows its finished state instead of a mid-fade frame, so axe is deterministic.
// Playwright's device descriptors, run in Chromium (defaultBrowserType dropped): viewport, DPR, touch, mobile UA.
const emulate = name => { const d = { ...devices[name], reducedMotion: 'reduce' }; delete d.defaultBrowserType; return d }
const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' },
  'iphone-13': emulate('iPhone 13'),
  'pixel-7': emulate('Pixel 7'),
}

// Synthetic /api answers for the pages whose content would otherwise be empty on a fresh database.
const JOB = 'b'.repeat(24)
const lead = (id, company, over = {}) => ({ id, name: '', company, contact: null, signal: `${company} opened a second office`, source_url: `https://www.news.example/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} opened a second office`, event_date: '2026-10-01', date_status: 'unverified', confidence: 80, review_reason: null, company_domain: null, human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 3, action: 3, why: `${company} matches your dental owner profile.`, signals: null, icp_match: null, enrichments: [], events: [], ...over })
const LEADS = [lead('a'.repeat(24), 'Bright Dental', { contact: 'hello@brightdental.example' }), lead('c'.repeat(24), 'Lakeside Smiles'), lead('d'.repeat(24), 'Old Town Dental', { contact: 'info@oldtown.example', window_held: true })]
const ICP = { summary: 'Growing dental practices', who: ['Practice owner'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['new location'], exclude: [] }
const now = Math.floor(Date.now() / 1000)
const THREADS = [
  { thread_id: 't1', gmail_id: 'g1', lead_id: 'l1', job_id: JOB, from_email: 'ceo@older.example', excerpt: 'Yes - send details', classification: 'positive', received_at: now - 3600, replies: 2, company: 'Older Co', lead_name: 'Sam', followups_sent: 1, stopped: null, unread: true, needs_owner: true },
  { thread_id: 't2', gmail_id: 'g2', lead_id: 'l2', job_id: JOB, from_email: 'ops@wobble.example', excerpt: 'Not now, thanks', classification: 'negative', received_at: now - 7200, replies: 1, company: 'Wobble Works', lead_name: 'Rae', followups_sent: 0, stopped: null, unread: false, needs_owner: false },
]
const STUBS = {
  '/app/leads': { '/api/scan/status': { status: 'done', lead_count: LEADS.length, icp: ICP, icp_source: 'user', attempts: 1, max_attempts: 3, query: 'Dental practice owners in Ohio opening a new location' }, '/api/leads': { job_id: JOB, status: 'done', hidden_count: 0, leads: LEADS }, '/api/scan/jobs': { jobs: [] }, '/api/enrich/held': { held: [] } },
  '/app/inbox': { '/api/outreach/inbox': { available: true, consent_accepted: true, read_granted: true, account: 'me@x.example', booking_url: null, threads: THREADS, next_cursor: null, counts: { threads: 2, needs_owner: 1, unread: 1, unread_needs_owner: 1 } } },
}

const failures = []
const fail = (where, msg) => { failures.push(`${where}: ${msg}`); console.log(`     FAIL ${msg}`) }
const observed = {}

async function axeCheck(page, key) {
  await page.addScriptTag({ path: axePath })
  const res = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] })).violations
    .map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes.slice(0, 3).map(x => `${x.target.join(' ')} - ${(x.failureSummary || '').split('\n').slice(1).join(' ').slice(0, 160)}`) })))
  const got = Object.fromEntries(res.map(v => [v.id, v.n])); if (res.length) observed[key] = got
  const want = BASELINE[key] ?? {}
  for (const v of res) {
    if (!(v.id in want)) fail(key, `new axe violation ${v.id} (${v.impact}, ${v.n} node(s)): ${v.sample.join(' | ')}`)
    else if (v.n > want[v.id]) fail(key, `axe ${v.id} grew ${want[v.id]} -> ${v.n} node(s): ${v.sample.join(' | ')}`)
    else console.log(`     baseline ${v.id} (${v.impact}): ${v.n} node(s) - known, still open`)
  }
  for (const id of Object.keys(want)) if (!(id in got)) fail(key, `baseline lists ${id} but it no longer occurs: remove it from frontend-baseline.json`)
  for (const v of res) if (v.id in want && v.n < want[v.id]) fail(key, `axe ${v.id} dropped ${want[v.id]} -> ${v.n}: lower it in frontend-baseline.json`)
}

// Tabbable, rendered controls (radios: one stop per group). Elements are tagged with data-kb so stops can be matched.
const TABBABLES = () => {
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex], [contenteditable="true"]'
  const out = []; const radioGroups = new Set(); let i = 0
  for (const el of document.querySelectorAll(sel)) {
    if (el.disabled || el.tabIndex < 0 || el.closest('[inert]')) continue
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el)
    const hiddenInput = el.matches('input') && (r.width < 2 || r.height < 2 || cs.opacity === '0')
    const labelled = hiddenInput && [...(el.labels ?? [])].some(l => l.checkVisibility({ visibilityProperty: true }) && l.getBoundingClientRect().width > 1)
    if (!el.checkVisibility({ visibilityProperty: true }) && !el.classList.contains('skip-link')) continue
    if (r.width === 0 && r.height === 0 && !el.classList.contains('skip-link')) continue
    if (hiddenInput && !labelled) { if (!el.classList.contains('skip-link')) continue }
    if (el.type === 'radio') { if (radioGroups.has(el.name)) continue; radioGroups.add(el.name) }
    if (!el.dataset.kb) el.dataset.kb = `k${i}`; i++
    out.push({ kb: el.dataset.kb, radio: el.type === 'radio' ? el.name : null, desc: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} "${(el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 40)}"` })
  }
  return out
}
// The focused element (or, for a visually hidden native input, its visible label): visible while focused, and a
// different look focused vs not focused (outline, ring, border, background, colour or underline).
const FOCUS_STATE = () => {
  const el = document.activeElement
  if (!el || el === document.body) return null
  const r0 = el.getBoundingClientRect()
  const proxies = el.matches('input') && (r0.width < 2 || r0.height < 2) ? [...(el.labels ?? [])] : [el]
  const look = n => { const s = getComputedStyle(n); return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor, s.color, s.textDecorationLine].join('|') }
  // The ring may be drawn by the control or by a wrapper (:focus-within), so the control and two ancestors are compared.
  const looks = n => [n, n.parentElement, n.parentElement?.parentElement].filter(Boolean).map(look).join('#')
  const vis = n => { const r = n.getBoundingClientRect(); return r.width >= 2 && r.height >= 2 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && n.checkVisibility({ visibilityProperty: true }) }
  const focused = proxies.map(looks); const visible = proxies.some(vis)
  el.blur(); const blurred = proxies.map(looks); el.focus()
  return { kb: el.dataset.kb ?? null, radio: el.type === 'radio' ? el.name : null, desc: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40)}"`, visible, indicator: focused.some((f, i) => f !== blurred[i]) }
}

async function keyboardCheck(page, key) {
  // From a fresh load (focus at the document start): Tab through the whole page and back out of it.
  const expected = await page.evaluate(TABBABLES)
  const seen = new Set(); const seenRadio = new Set(); let stops = 0; let firstKb = null
  for (let i = 0; i < 300; i++) {
    await page.keyboard.press('Tab')
    const st = await page.evaluate(FOCUS_STATE)
    if (!st) break // focus left the document: the end of the tab order
    if (st.kb && st.kb === firstKb) break // wrapped around
    if (!firstKb) firstKb = st.kb
    stops++
    if (stops === 1 && !(await page.evaluate(() => document.activeElement?.classList.contains('skip-link')))) fail(key, `first Tab stop is ${st.desc}, not the skip link`)
    if (st.kb) seen.add(st.kb); if (st.radio) seenRadio.add(st.radio)
    if (!st.visible) fail(key, `Tab stop ${stops} ${st.desc} is not visible while focused`)
    else if (!st.indicator) fail(key, `Tab stop ${stops} ${st.desc} shows no focus indicator`)
  }
  const missed = expected.filter(e => !(seen.has(e.kb) || (e.radio && seenRadio.has(e.radio))))
  for (const m of missed) fail(key, `visible control never reached by Tab: ${m.desc}`)
  // The skip link works: Enter on it, and the next Tab lands inside #main (past the navigation).
  await page.focus('.skip-link'); await page.keyboard.press('Enter')
  if (!(await page.evaluate(() => location.hash === '#main' && !!document.getElementById('main')))) fail(key, 'skip link Enter did not land on #main (missing id="main")')
  else {
    // #673: on /app routes focus itself must move to <main> (tabindex="-1"), not stay on BODY.
    if (key.includes(' /app')) { const at = await page.evaluate(() => document.activeElement?.id === 'main' ? 'MAIN' : document.activeElement?.tagName); if (at !== 'MAIN') fail(key, `skip link Enter left focus on ${at}, not <main id="main">`) }
    await page.keyboard.press('Tab')
    if (!(await page.evaluate(() => !!document.activeElement?.closest('#main') || !document.querySelector('#main a[href], #main button, #main input, #main select, #main textarea')))) fail(key, 'after the skip link, Tab did not move into #main')
  }
  console.log(`     keyboard: ${stops} Tab stop(s), ${expected.length} visible tabbable control(s), ${missed.length} unreached`)
}

async function overflowCheck(page, key) {
  const o = await page.evaluate(() => {
    const w = document.documentElement.clientWidth
    const wide = [document.documentElement, ...document.querySelectorAll('main')].filter(n => n.scrollWidth > n.clientWidth + 1)
    const culprits = wide.length ? [...document.querySelectorAll('body *')].filter(n => { const r = n.getBoundingClientRect(); return r.width > 0 && r.right > w + 1 && getComputedStyle(n).position !== 'fixed' && !n.closest('[class*="overflow-x-auto"], [class*="overflow-auto"] [class*="overflow-x"]') }).slice(0, 3).map(n => `${n.tagName.toLowerCase()}.${String(n.className).split(' ').slice(0, 3).join('.')} right=${Math.round(n.getBoundingClientRect().right)}`) : []
    return { w, wide: wide.map(n => `${n.tagName.toLowerCase()} scrollWidth=${n.scrollWidth}`), culprits }
  })
  if (o.wide.length) fail(key, `horizontal overflow at ${o.w}px: ${o.wide.join(', ')}; ${o.culprits.join(', ')}`)
}

async function metadataCheck(base) {
  const meta = (html, attr, name) => { const m = new RegExp(`<meta[^>]*${attr}="${name}"[^>]*content="([^"]*)"`, 'i').exec(html) || new RegExp(`<meta[^>]*content="([^"]*)"[^>]*${attr}="${name}"`, 'i').exec(html); return m?.[1] ?? null }
  const local = u => u.replaceAll('&amp;', '&').replace(SITE, base) // fetch the page's own absolute URLs from this server
  const selfUrl = route => route === '/' ? SITE : SITE + route
  const titles = new Set()
  for (const route of PUBLIC) {
    const key = `metadata ${route}`; console.log(`---- ${key}`)
    const html = await (await fetch(base + route)).text()
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1]
    const canonical = /<link[^>]*rel="canonical"[^>]*href="([^"]*)"/.exec(html)?.[1] ?? null
    const noindex = /<meta[^>]*name="robots"[^>]*noindex/i.test(html)
    if (!title) fail(key, 'no <title>'); else if (titles.has(title)) fail(key, `title "${title}" duplicates another public page`); else titles.add(title)
    if (NOINDEX.has(route)) {
      if (!noindex) fail(key, 'expected noindex (one-time-link page)')
      if (canonical) fail(key, `noindex page carries a canonical ${canonical}`)
      console.log(`     title="${title}" noindex=${noindex} canonical=${canonical}`)
      continue
    }
    const tags = { description: meta(html, 'name', 'description'), 'og:title': meta(html, 'property', 'og:title'), 'og:description': meta(html, 'property', 'og:description'), 'og:url': meta(html, 'property', 'og:url'), 'og:image': meta(html, 'property', 'og:image'), 'og:image:width': meta(html, 'property', 'og:image:width'), 'og:image:height': meta(html, 'property', 'og:image:height'), 'twitter:card': meta(html, 'name', 'twitter:card'), 'twitter:title': meta(html, 'name', 'twitter:title'), 'twitter:image': meta(html, 'name', 'twitter:image') }
    if (noindex) fail(key, 'noindex on an indexable public page')
    if (canonical !== selfUrl(route)) fail(key, `canonical ${canonical} is not ${selfUrl(route)}`)
    for (const [k, v] of Object.entries(tags)) if (!v) fail(key, `missing ${k}`)
    for (const k of ['og:title', 'twitter:title']) if (tags[k] && title && tags[k] !== title) fail(key, `${k} "${tags[k]}" differs from <title> "${title}"`)
    if (tags['og:url'] && tags['og:url'] !== selfUrl(route)) fail(key, `og:url ${tags['og:url']} is not this page (${selfUrl(route)})`)
    if (tags['twitter:card'] && tags['twitter:card'] !== 'summary_large_image') fail(key, `twitter:card is ${tags['twitter:card']}`)
    for (const k of ['og:image', 'twitter:image']) if (tags[k]) {
      if (!tags[k].startsWith(SITE + '/')) fail(key, `${k} ${tags[k]} is not an absolute ${SITE} URL`)
      const img = await fetch(local(tags[k]))
      const buf = Buffer.from(await img.arrayBuffer())
      const png = buf.subarray(1, 4).toString() === 'PNG'
      const [w, h] = png ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : [0, 0]
      if (img.status !== 200 || !png || w !== 1200 || h !== 630) fail(key, `${k} ${img.status} ${img.headers.get('content-type')} ${w}x${h}, expected 200 PNG 1200x630`)
    }
    console.log(`     title="${title}" description=${tags.description ? 'yes' : 'no'} canonical=${canonical} og:url=${tags['og:url']} og:image=${tags['og:image'] ? 'yes' : 'no'} twitter:card=${tags['twitter:card']}`)
  }
  console.log('---- robots.txt, sitemap.xml, redirects')
  const robots = await (await fetch(base + '/robots.txt')).text()
  if (!robots.includes(`Sitemap: ${SITE}/sitemap.xml`)) fail('robots.txt', 'does not point at the sitemap')
  for (const d of ['/app', '/api']) if (!new RegExp(`Disallow: ${d}\\b`).test(robots)) fail('robots.txt', `does not disallow ${d}`)
  const sitemap = await (await fetch(base + '/sitemap.xml')).text()
  const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1])
  for (const route of PUBLIC.filter(r => !NOINDEX.has(r))) if (!locs.includes(selfUrl(route))) fail('sitemap.xml', `does not list ${route}`)
  for (const loc of locs) { const r = await fetch(local(loc), { redirect: 'manual' }); if (r.status !== 200) fail('sitemap.xml', `${loc} answers ${r.status}`) }
  for (const r of ['/pricing', '/plans']) { const res = await fetch(base + r, { redirect: 'manual' }); const loc = res.headers.get('location'); if (res.status !== 307 || !/\/#pricing$/.test(loc ?? '')) fail(r, `answers ${res.status} -> ${loc}, expected 307 -> /#pricing`) }
  console.log(`     sitemap lists ${locs.length} URL(s), each answers 200; robots.txt points at it and disallows /app, /api`)
}

// The same fence the harness sets, as a file URL so `--import` also resolves on Windows. Override the harness's
// default PUBLIC_BASE_URL=<local base> (#670 review): it exists so routes that build functional redirect URLs
// (OAuth, Stripe) work against this ephemeral server, but a dynamically-rendered public page (e.g. /sign-up,
// #668) reads SITE_BASE live from that same process env, so its canonical/og/twitter URLs would pick up the local
// override too. This check already assumes every public page's metadata resolves to SITE (this test's own
// PUBLIC_BASE_URL, defaulting to https://dazl.ai) - true by construction for a statically-baked page, but only
// true for a dynamic one if the server process has the same value. local() below still rewrites that into `base`
// to fetch it from this server, exactly as it already does for the static pages.
const srv = await startServer({ env: { PUBLIC_BASE_URL: SITE, NODE_OPTIONS: `--experimental-strip-types --import ${pathToFileURL(path.join(root, 'test/helpers/net-fence.ts'))}` } })
const { base } = srv
let browser
try {
  await metadataCheck(base)
  browser = await chromium.launch()
  if (process.env.SHOTS) mkdirSync(process.env.SHOTS, { recursive: true })
  for (const [vp, desc] of Object.entries(VIEWPORTS)) {
    const ctx = await browser.newContext(desc)
    await ctx.addCookies([{ name: 'dazl_session', value: srv.token, url: base }])
    let stubs = {}
    let hold = null
    await ctx.route('**/*', route => {
      const u = new URL(route.request().url())
      if (u.origin !== base) return route.abort()
      const body = route.request().method() === 'GET' ? stubs[u.pathname] : undefined
      // #673 loading state: hold this one stubbed answer until the test releases it.
      if (body && hold && u.pathname === hold.path) return hold.wait.then(() => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }))
      return body ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }) : route.continue()
    })
    for (const route of [...PUBLIC, ...APP]) {
      const pathname = route.split('?')[0]; const key = `${vp} ${pathname}`
      console.log(`---- ${key}`)
      stubs = STUBS[pathname] ?? {}
      const page = await ctx.newPage(); const errs = []
      page.on('pageerror', e => errs.push(`page error: ${e.message.split('\n')[0]}`))
      const res = await page.goto(base + route, { waitUntil: 'networkidle' })
      await page.waitForTimeout(400)
      if (!res || res.status() >= 400) fail(key, `HTTP ${res?.status()}`)
      if (new URL(page.url()).pathname !== pathname) fail(key, `landed on ${new URL(page.url()).pathname}`)
      if (pathname === '/app/leads' && !(await page.getByTestId('lead-card').count())) fail(key, 'no lead cards rendered from the stub')
      if (pathname === '/app/inbox' && !(await page.getByTestId('inbox-thread').count())) fail(key, 'no inbox threads rendered from the stub')
      for (const e of errs) fail(key, e)
      if (process.env.SHOTS) {
        // /app pages scroll inside <main>; unroll that for the full-page screenshot only (the checks run on the real layout).
        const unroll = pathname.startsWith('/app/')
        if (unroll) await page.evaluate(() => { const s = document.createElement('style'); s.id = 'shot-unroll'; s.textContent = '.app-ui{height:auto!important}.app-ui>main{overflow:visible!important}'; document.head.append(s) })
        await page.screenshot({ path: path.join(process.env.SHOTS, `${vp}${pathname === '/' ? '_home' : pathname.replaceAll('/', '_')}.png`), fullPage: true })
        if (unroll) await page.evaluate(() => document.getElementById('shot-unroll').remove())
      }
      await axeCheck(page, key)
      await overflowCheck(page, key)
      await keyboardCheck(page, key)
      await page.close()
    }
    // #673 (named regression): after Enter on the skip link, document.activeElement is <main id="main"> and its focus
    // ring shows, on Home, Settings and Inbox. Settings and Inbox loaded are covered in keyboardCheck above. Home (/app)
    // is not in APP (its content depends on onboarding state) but shares the /app layout's <main>; nothing on it may
    // autofocus past the skip link, so this walks it with a real first Tab.
    const mainFocus = () => { const el = document.activeElement; const s = el ? getComputedStyle(el) : null; return { at: el?.id === 'main' ? 'MAIN' : el?.tagName, ring: !!s && s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 } }
    {
      const key = `${vp} /app (skip link)`; console.log(`---- ${key}`)
      stubs = {}
      const page = await ctx.newPage()
      await page.goto(base + '/app', { waitUntil: 'networkidle' }); await page.waitForTimeout(400)
      const landed = new URL(page.url()).pathname
      if (!landed.startsWith('/app')) fail(key, `landed on ${landed}`)
      else {
        const pre = await page.evaluate(() => document.activeElement?.tagName)
        if (pre !== 'BODY') fail(key, `on load focus is already on ${pre} (autofocus skips the skip link)`)
        await page.keyboard.press('Tab')
        if (!(await page.evaluate(() => document.activeElement?.classList.contains('skip-link')))) fail(key, 'first Tab did not land on the skip link')
        await page.keyboard.press('Enter')
        const st = await page.evaluate(mainFocus)
        if (st.at !== 'MAIN') fail(key, `skip link Enter left focus on ${st.at}, not <main id="main">`)
        else if (!st.ring) fail(key, '<main> has focus but shows no focus ring')
        console.log(`     landed on ${landed}; first Tab -> skip link; Enter -> ${st.at} (ring ${st.ring})`)
      }
      await page.close()
    }
    // #673 loading state: the skip link is used while Inbox still shows "Loading..."; when the threads replace it,
    // focus must stay on <main>, not fall back to BODY.
    {
      const key = `${vp} /app/inbox (skip link while loading)`; console.log(`---- ${key}`)
      stubs = STUBS['/app/inbox']
      let release; hold = { path: '/api/outreach/inbox', wait: new Promise(r => { release = r }) }
      const page = await ctx.newPage()
      try {
        await page.goto(base + '/app/inbox', { waitUntil: 'load' })
        await page.getByText('Loading...').first().waitFor({ timeout: 15000 })
        await page.focus('.skip-link'); await page.keyboard.press('Enter')
        const during = await page.evaluate(mainFocus)
        if (during.at !== 'MAIN') fail(key, `while loading, skip link Enter left focus on ${during.at}`)
        release(); hold = null
        await page.getByTestId('inbox-thread').first().waitFor({ timeout: 15000 }); await page.waitForTimeout(300)
        const after = await page.evaluate(mainFocus)
        if (after.at !== 'MAIN') fail(key, `after the threads loaded, focus fell to ${after.at}, not <main id="main">`)
        console.log(`     loading: ${during.at}; loaded: ${after.at}`)
      } finally { release?.(); hold = null; await page.close() }
    }
    await ctx.close()
  }
} finally {
  await browser?.close()
  // Windows can still hold the throwaway database open for a moment after the kill; a failed temp cleanup is not a result.
  try { srv.stop() } catch (e) { console.log(`(temp cleanup: ${e.code})`) }
}
console.log('\nObserved axe violations (the shape of frontend-baseline.json "violations"):\n' + JSON.stringify(observed, null, 1))
if (failures.length) { console.log(`\n${failures.length} problem(s):\n- ${failures.join('\n- ')}`); process.exit(1) }
console.log(`\nFrontend baseline holds: ${PUBLIC.length + APP.length} pages x ${Object.keys(VIEWPORTS).length} viewports (desktop + emulated iPhone 13 / Pixel 7; emulation, not a physical device), metadata on ${PUBLIC.length} public routes.`)
