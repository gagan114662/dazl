// Production-build smoke check of credential forms, including the unhydrated and hydrated sign-up paths.
// a React onSubmit-only <form> without a method attribute natively submits GET, putting every field - passwords
// included - into the URL query (server logs, browser history, proxy logs). Observed live on sign-up and sign-in.
// With method="post" (refs #516), no credentials go in the URL. Native sign-in does not mutate the account;
// native sign-up still creates an account (#1116). Run: cd web && npm run build && npm run test:smoke:authforms
// Isolation as harness.mjs: throwaway database, server under the test network fence, off-host browser requests aborted.
import { loadPlaywright, root, startServer } from './harness.mjs'
import { createRequire } from 'node:module'
import path from 'node:path'
const require = createRequire(path.join(root, 'package.json'))
const { chromium } = loadPlaywright()

// Synthetic fixture values only - never a real or account-shaped secret.
const FIX = {
  name: 'Smoke Fixture',
  email: 'smoke-fixture@invalid.test',
  business_name: 'Smoke Fixture Co',
  password: 'smoke-fixture-value-9f2c-not-a-secret',
}
// #1428: /reset renders its complete form in the initial HTML too (as sign-up: connection() with no Suspense boundary).
// This harness sends no mail, so its Send button is (rightly) disabled: the /reset check below is that the form itself is
// in the first HTML with no script, never a loading line.
const CASES = [
  // #1116: sign-up WORKS without its script: the form posts to /api/auth/signup, which creates the account and redirects
  // back with a code ("Check your email"), or into the app when this deployment sends no confirmation mail.
  { path: '/sign-up', works: true, fields: { name: FIX.name, email: FIX.email, business_name: FIX.business_name, password: FIX.password } },
  { path: '/sign-in', fields: { email: FIX.email, password: FIX.password } },
]

const srv = await startServer()
const { base } = srv
const failures = []
const expectedSignups = [FIX.email]
let browser
try {
  browser = await chromium.launch()
  const ctx = await browser.newContext({ javaScriptEnabled: false })
  await ctx.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
  const page = await ctx.newPage()
  for (const c of CASES) {
    const errs = []
    await page.goto(base + c.path, { waitUntil: 'domcontentloaded' })
    for (const [n, v] of Object.entries(c.fields)) await page.fill(`input[name=${n}]`, v)
    const [resp] = await Promise.all([
      page.waitForNavigation({ timeout: 15000 }),
      page.click('button[type=submit]'),
    ])
    const errsAt = (m) => errs.push(m)
    if (!resp) errsAt('no navigation response')
    else {
      // a working native post is answered with a 303, so the response that lands is the GET after it: the submit itself is the request it was redirected from
      const method = (resp.request().redirectedFrom() ?? resp.request()).method()
      const landed = new URL(page.url())
      const bodyText = await resp.text()
      if (method !== 'POST') errsAt(`native submit was ${method}, not POST - values go into the URL query`)
      if (landed.search && !(c.works && landed.search === '?sent=1')) errsAt(`landed URL carries a query: ${landed.search.slice(0, 80)}`)
      for (const v of Object.values(c.fields)) {
        if (decodeURIComponent(landed.href).includes(v)) errsAt(`fixture value in the URL`)
        if (bodyText.includes(v)) errsAt(`fixture value echoed in the response body`)
      }
      // The harmless outcomes for a native POST to a page route are 405 (Method Not Allowed) or a plain
      // 200 re-render of the page: no action handler exists, so nothing mutates and nothing echoes (both
      // asserted separately). Anything else (redirect carrying values, 5xx) is a failure.
      if (c.works) {
        // the native post reached the route and the visitor is told what happened (or is in the app): never a silent reload
        const text = await page.locator('body').innerText()
        const ok = (landed.pathname === '/sign-up' && landed.search === '?sent=1' && /Check your email/.test(text)) || landed.pathname.startsWith('/app')
        if (!ok) errsAt(`sign-up without script did not finish: landed ${landed.pathname}${landed.search}, page says "${text.replace(/\s+/g, ' ').slice(0, 80)}"`)
      } else if (method === 'POST' && ![405, 200].includes(resp.status())) errsAt(`native POST answered HTTP ${resp.status()}, expected the harmless 405 or page re-render`)
    }
    console.log(`${errs.length ? 'FAIL' : 'ok  '} JS disabled ${c.path}`)
    for (const e of errs) console.log(`     ${e}`)
    for (const e of errs) failures.push(`${c.path}: ${e}`)
  }
  {
    await page.goto(base + '/reset', { waitUntil: 'domcontentloaded' })
    const text = await page.locator('body').innerText()
    const ok = (await page.locator('input[name=email]').count()) === 1 && /Reset your password/.test(text) && !/Loading account recovery/.test(text)
    console.log(`${ok ? 'ok  ' : 'FAIL'} JS disabled /reset: the form is in the first HTML, no loading line`)
    if (!ok) failures.push(`/reset: first HTML has no form: "${text.replace(/\s+/g, ' ').slice(0, 80)}"`)
  }
  // #1116: the pages a native post is redirected to, rendered by the server with NO script: "Check your email", and an error
  // in the scripted form's words. (This harness sends no mail, so the posts above land in the app; these are what a
  // deployment with mail delivery shows.) An unknown code shows no message.
  for (const [q, want, not] of [['?sent=1', /Check your email/, /Create your account/], ['?error=password', /Use a password of 10 to 200 characters/, /Check your email/], ['?error=%3Cscript%3E', /Create your account/, /script>/]]) {
    await page.goto(base + '/sign-up' + q, { waitUntil: 'domcontentloaded' })
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    const ok = want.test(text) && !not.test(text)
    console.log(`${ok ? 'ok  ' : 'FAIL'} JS disabled /sign-up${q}: "${text.slice(0, 70)}"`)
    if (!ok) failures.push(`/sign-up${q} without script does not show the outcome`)
  }
  // #1116, the incident's own shape: JavaScript is ON but the page's script files do not load (a stale or mixed build), so the
  // form is never hydrated. At desktop and phone width the visitor still gets an account and "Check your email".
  for (const width of [1280, 390]) {
    const c2 = await browser.newContext({ viewport: { width, height: 844 } })
    await c2.route('**/*', route => { const r = route.request(); if (new URL(r.url()).origin !== base) return route.abort(); return r.resourceType() === 'script' ? route.abort() : route.continue() })
    const p2 = await c2.newPage(); const posts = []
    p2.on('request', r => { if (r.method() === 'POST') posts.push(new URL(r.url()).pathname) })
    await p2.goto(base + '/sign-up', { waitUntil: 'domcontentloaded' })
    await p2.waitForTimeout(4000)   // the page's own chunk-failure recovery may reload it (a bounded number of times): let that settle first
    await p2.waitForLoadState('domcontentloaded')
    const hydrated = await p2.evaluate(() => Object.keys(document.querySelector('form')).some(k => k.startsWith('__reactProps')))
    const email = `smoke-nohydrate-${width}@invalid.test`
    expectedSignups.push(email)
    await p2.fill('input[name=name]', FIX.name); await p2.fill('input[name=email]', email); await p2.fill('input[name=password]', FIX.password)
    await Promise.all([p2.waitForURL(u => u.search === '?sent=1' || u.pathname.startsWith('/app'), { timeout: 15000 }).catch(() => {}), p2.click('button[type=submit]')])
    const landed = new URL(p2.url()), text = (await p2.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ')
    const ok = !hydrated && posts.join() === '/api/auth/signup' && ((landed.pathname === '/sign-up' && landed.search === '?sent=1' && /Check your email/.test(text)) || landed.pathname.startsWith('/app')) && !decodeURIComponent(landed.href).includes(email)
    console.log(`${ok ? 'ok  ' : 'FAIL'} scripts failed to load, ${width}px: hydrated=${hydrated}, posts=${posts.join(',')}, landed ${landed.pathname}${landed.search}, "${text.slice(0, 60)}"`)
    if (!ok) failures.push(`/sign-up with its scripts failing to load at ${width}px did not create the account and say so`)
    if (process.env.SHOTS) await p2.screenshot({ path: `${process.env.SHOTS}/signup-no-hydration-${width}.png` })
    await c2.close()
  }
  // #1116: with its script, a fresh visitor on desktop or a phone taps the form, posts JSON, and signs up.
  for (const width of [1280, 390]) {
    const mobile = width === 390
    const email = `smoke-hydrated-${width}@invalid.test`
    expectedSignups.push(email)
    const c3 = await browser.newContext({ viewport: { width, height: 844 }, isMobile: mobile, hasTouch: mobile })
    await c3.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
    const p3 = await c3.newPage(); const types = []
    p3.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/auth/signup') types.push(r.headers()['content-type'] ?? '') })
    await p3.goto(base + '/sign-up', { waitUntil: 'networkidle' })
    await p3.waitForFunction(() => Object.keys(document.querySelector('form')).some(k => k.startsWith('__reactProps')), null, { timeout: 15000 })
    await p3.fill('input[name=name]', FIX.name); await p3.fill('input[name=email]', email); await p3.fill('input[name=password]', FIX.password)
    const submit = p3.locator('button[type=submit]')
    if (mobile) {
      if (await p3.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) failures.push('/sign-up overflows the mobile viewport')
      await submit.tap()
    } else await submit.click()
    await p3.waitForFunction(() => /Check your email/.test(document.body.innerText) || location.pathname.startsWith('/app'), null, { timeout: 15000 }).catch(() => {})
    const ok = types.length === 1 && types[0].includes('application/json') && (/Check your email/.test(await p3.locator('body').innerText()) || new URL(p3.url()).pathname.startsWith('/app'))
    console.log(`${ok ? 'ok  ' : 'FAIL'} hydrated form at ${width}px posts JSON (${types.join(',')}) and finishes`)
    if (!ok) failures.push(`the hydrated sign-up form did not post JSON exactly once and finish at ${width}px`)
    await c3.close()
  }
  const Database = require('better-sqlite3')
  const db = new Database(srv.dbPath, { readonly: true })
  const n = db.prepare('SELECT COUNT(*) AS c FROM users').get().c
  const countByEmail = db.prepare('SELECT COUNT(*) AS c FROM users WHERE email = ?')
  const wrongCount = expectedSignups.filter(email => countByEmail.get(email).c !== 1)
  db.close()
  const accountsOk = n === expectedSignups.length + 1 && wrongCount.length === 0 // one seeded user
  if (!accountsOk) failures.push(`expected the seeded user plus exactly one account per sign-up (${n} rows, wrong counts: ${wrongCount.join(', ') || 'none'})`)
  console.log(`${accountsOk ? 'ok  ' : 'FAIL'} each sign-up made exactly one account (${n} users)`)
} finally {
  await browser?.close()
  srv.stop()
}
if (failures.length) { for (const f of failures) console.log(f); console.log(`\n${failures.length} problem(s)`); process.exit(1) }
console.log('\nJS disabled: sign-up completes through its route (#1116); the sign-in native submit is a harmless POST - no values in any URL, no echo.')
