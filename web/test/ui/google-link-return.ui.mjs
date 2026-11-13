// #1095: coming back from "Link Google" (/api/auth/callback/google -> the page that asked, ?google=<result>) never
// dead-ends. NOT part of `npm test`. Run:  cd web && npm run build && node test/ui/google-link-return.ui.mjs
// (SHOTS=<dir> saves 1280 and 390 screenshots). Production build, throwaway database, no outside network:
// every non-app request aborted and every /api/* call stubbed in the browser (no Google, no scan). For every result (linked,
// already, and each failure incl. failed), on onboarding (/app, at the ready and ask steps) and on Leads, it asserts:
//   the note says how it went; the saved search is back in the box (after a failure it also stays saved for the next
//   attempt); onboarding reopens the step where the search started (never Home without a word); Run is enabled.
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pickUiPort } from '../helpers/ui-port.mjs'
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(dir, 'package.json'))
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? ' (allowed by SMOKE_ALLOW_SKIP=1)' : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
let chromium
try { ({ chromium } = require('playwright')) } catch (e) { notRun(e.message.split('\n')[0]) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const Database = require('better-sqlite3'); const { createHash, randomBytes } = require('crypto')
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-linkreturn-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), email_verified_at INTEGER); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt,email_verified_at) VALUES ('u1','pat@example.test','x','y',NULL)").run() // a new password account, unconfirmed
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', DAZL_MASTER_KEY: randomBytes(32).toString('base64'), PUBLIC_BASE_URL: base }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const JOB = 'c'.repeat(24)
const QUERY = 'Find founders of SaaS companies hiring a controller'
const PROFILE = { business_name: 'Ledgerline', sells: 'Bookkeeping for founders', website: 'ledgerline.example', buyer: { summary: 'Founders of small SaaS companies', who: ['Founder'], industries: ['Software'], sizes: [], where: ['United States'], signals: ['hiring a controller'], exclude: [] }, new_play_offer: null }
// what each result must say (lib/google-link.ts googleLinkResultCopy)
const RESULTS = [
  ['linked', true, /Google sign-in is added to this account\. Your search is ready: run it\./],
  ['already', true, /Google sign-in was already added\./],
  ['failed', false, /Google sign-in was not added \(cancelled or failed\)/],
  ['google_unverified', false, /Google has not verified that email address/],
  ['mismatch', false, /uses a different email/],
  ['taken', false, /already signs in to another dazl account/],
  ['reauth_required', false, /Confirm it is you first: enter your password/],
  ['signed_out', false, /Sign in first, then add Google sign-in/],
  ['unverified', false, /Confirm your email first/], // no longer returned; an old ?google= in a bookmark still reads
]
// #1095 (Hermes review): the server's own estimate for a password account refused the free trial for google_required, so the
// cost panel on Leads is checked with what /api/scan/estimate really returns for it (lib/scan/price-estimate.ts estimateRun).
const BLOCKED_EST = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e',
  "import { estimateRun } from './lib/scan/price-estimate.ts'; process.stdout.write(JSON.stringify(estimateRun({ budget: null, payer: 'trial', limited: true, trialRefusal: 'google_required', trialUsed: 0 })))"],
  { cwd: dir, env: { PATH: process.env.PATH } }).toString())
const b = await chromium.launch()
async function open(width, url, pending, profile = PROFILE) {
  const fresh = !/google=reauth_required/.test(url) // the server said the session is stale: so does /api/auth/reauth
  const ctx = await b.newContext({ viewport: { width, height: 900 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/api/usage') return json({ plan: 'free', scans_used: 0, scan_limit: 10, has_key: false, trial: { funded: true, remaining: 3, cap: 3, blocked: null } })
    if (p === '/api/settings/profile') return json(profile)
    if (p === '/api/settings/advanced') return json({ available: true, platforms: [] })
    if (p === '/api/scan/jobs') return json({ jobs: [] })
    if (p === '/api/scan/latest') return json({ query: 'an OLDER search from the last job', icp: null }) // must never replace the restored one
    // an older job open on Leads (?job_id=): its own query must not replace the restored search
    if (p === '/api/scan/status') return json({ status: 'done', query: 'an OLDER search from the open job', lead_count: 0, attempts: 1, max_attempts: 3 })
    if (p === '/api/leads') return json({ job_id: JOB, status: 'done', hidden_count: 0, leads: [] })
    if (p === '/api/scan/icp') return json({ icp: PROFILE.buyer, inferred: true })
    if (p === '/api/scan/estimate') return json({ estimate: BLOCKED_EST })
    if (p === '/api/scan' && req.method() === 'POST') return json({ error: 'fenced: no scan starts in this check' }, 418)
    if (p === '/api/auth/email') return json({ email: 'pat@example.test', verified: false, google: false })
    if (p === '/api/auth/reauth') return json({ fresh, method: 'password' })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/robots.txt`)
  if (pending) await page.evaluate(([q, step]) => sessionStorage.setItem('dazl_pending_search', JSON.stringify({ query: q, step, at: Date.now() })), [QUERY, pending])
  await page.goto(base + url, { waitUntil: 'networkidle' })
  return { ctx, page }
}
// After a failure the page offers the way forward at once (never "try again" with nothing to press): Link Google back to
// this page, or the password first when the session is stale. After a success there is no refusal.
async function wayForward(page, ok, result, label) {
  const notice = page.getByTestId('trial-refusal-notice')
  if (ok) { assert.equal(await notice.count(), 0, `${label}: no refusal after a success`); return }
  await notice.waitFor({ timeout: 8000 })
  if (result === 'reauth_required') assert.equal(await notice.getByLabel('Your password').count(), 1, `${label}: the password field`)
  else {
    const href = await notice.getByRole('link', { name: 'Link Google' }).getAttribute('href')
    assert.match(href ?? '', /^\/api\/auth\/google\?link=1&next=%2Fapp/, `${label}: Link Google back to this page`)
  }
}
const saved = page => page.evaluate(() => sessionStorage.getItem('dazl_pending_search'))
const noOverflow = async (page, label) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${label}: no horizontal scroll`)
let checks = 0; const failures = []
async function check(label, fn) { try { await fn(); checks++ } catch (e) { failures.push(`${label}: ${e.message.split('\n')[0]}`) } }
try {
  for (const width of [1280, 390]) {
    for (const [result, ok, copy] of RESULTS) {
      // onboarding, search started at the ready step
      await check(`/app ready ${result} @${width}`, async () => {
        const { ctx, page } = await open(width, `/app?google=${result}`, 'ready')
        const label = `/app ready ${result} @${width}`
        try {
        await page.getByTestId('ready-step').waitFor({ timeout: 8000 })
        assert.match(await page.getByTestId('google-link-note').innerText(), copy, `${label}: the note`)
        assert.equal(await page.getByTestId('first-ask').inputValue(), QUERY, `${label}: the same search is back`)
        await wayForward(page, ok, result, label)
        assert.equal(await page.getByTestId('ready-cta').isEnabled(), ok, `${label}: Run is ${ok ? 'enabled' : 'disabled while the refusal and its way forward show'}`)
        assert.equal(new URL(page.url()).searchParams.get('google'), null, `${label}: ?google= read once and removed`)
        assert.equal(await saved(page) !== null, !ok, `${label}: ${ok ? 'consumed after success' : 'kept for the next attempt after a failure'}`)
        await noOverflow(page, label)
        if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `app-ready-${result}-${width}.png`), fullPage: true })
        } finally { await ctx.close() }
      })
      // onboarding, search started at the ask step
      await check(`/app ask ${result} @${width}`, async () => {
        const { ctx, page } = await open(width, `/app?google=${result}`, 'ask')
        const label = `/app ask ${result} @${width}`
        try {
        await page.locator('#ask').waitFor({ timeout: 8000 })
        assert.match(await page.getByTestId('google-link-note').innerText(), copy, `${label}: the note`)
        assert.equal(await page.locator('#ask').inputValue(), QUERY, `${label}: the same search is back`)
        await wayForward(page, ok, result, label)
        assert.equal(await page.locator('form:has(#ask) button.send').isEnabled(), ok, `${label}: Run is ${ok ? 'enabled' : 'disabled while the refusal shows'}`)
        await noOverflow(page, label)
        if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `app-ask-${result}-${width}.png`), fullPage: true })
        } finally { await ctx.close() }
      })
      // Leads
      await check(`/app/leads ${result} @${width}`, async () => {
        const o = await open(width, `/app/leads?google=${result}`, 'leads')
        const label = `/app/leads ${result} @${width}`
        try {
        await o.page.getByTestId('google-link-note').waitFor({ timeout: 8000 })
        assert.match(await o.page.getByTestId('google-link-note').innerText(), copy, `${label}: the note`)
        // on screen without scrolling (at 390 it sits below the search card)
        const inView = await o.page.getByTestId('google-link-note').evaluate(e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight })
        assert.equal(inView, true, `${label}: the note is on screen`)
        await o.page.waitForTimeout(300) // let /api/scan/latest land: it must not replace the restored search
        assert.equal(await o.page.locator('#play').inputValue(), QUERY, `${label}: the same search is back`)
        await wayForward(o.page, ok, result, label)
        assert.equal(await o.page.locator('form:has(#play) button.send').isEnabled(), ok, `${label}: Find leads is ${ok ? 'enabled' : 'disabled while the refusal shows'}`)
        assert.equal(await saved(o.page) !== null, !ok, `${label}: ${ok ? 'consumed' : 'kept'}`)
        await noOverflow(o.page, label)
        if (process.env.SHOTS) await o.page.screenshot({ path: path.join(process.env.SHOTS, `leads-${result}-${width}.png`), fullPage: true })
        } finally { await o.ctx.close() }
      })
    }
    // #1095 (Hermes review): the cost panel for a run the free trial refused claims no payer (never "Paid by the shared
    // free trial" above "Free scans need a Google account") and offers Link Google back to this page.
    await check(`/app/leads blocked trial estimate @${width}`, async () => {
      const o = await open(width, '/app/leads', null)
      const label = `/app/leads blocked estimate @${width}`
      try {
        await o.page.locator('#play').waitFor({ timeout: 8000 })
        await o.page.locator('#play').fill(QUERY)
        await o.page.locator('form:has(#play) button.send').click()
        const panel = o.page.getByTestId('estimate-confirm'); await panel.waitFor({ timeout: 15000 })
        assert.equal(await panel.getAttribute('data-verdict'), 'blocked', `${label}: blocked`)
        const t = await panel.innerText()
        assert.doesNotMatch(t, /Paid by the shared free trial/i, `${label}: a refused run is not paid by the trial`)
        assert.match(t, /Free scans need a Google account/, `${label}: why, in words`)
        await wayForward(o.page, false, 'failed', label)
        assert.equal(await o.page.getByTestId('estimate-confirm-run').count(), 0, `${label}: no Run button`)
        await noOverflow(o.page, label)
        if (process.env.SHOTS) await o.page.screenshot({ path: path.join(process.env.SHOTS, `leads-blocked-estimate-${width}.png`), fullPage: true })
      } finally { await o.ctx.close() }
    })
    // Leads with an older job open (?job_id=): the job's status tick must not replace the restored search
    await check(`/app/leads?job_id linked @${width}`, async () => {
      const o = await open(width, `/app/leads?job_id=${JOB}&google=linked`, 'leads')
      try {
        await o.page.getByTestId('google-link-note').waitFor({ timeout: 8000 })
        await o.page.waitForTimeout(1500) // the first status tick lands
        assert.equal(await o.page.locator('#play').inputValue(), QUERY, `job_id @${width}: the restored search stays`)
      } finally { await o.ctx.close() }
    })
    // a new account with nothing known about the business and no saved search: the website step with the note,
    // never a 'Your brain is ready' card with nothing in it
    await check(`/app empty profile, no saved search @${width}`, async () => {
      const { ctx, page } = await open(width, '/app?google=failed', null, { business_name: '', sells: '', website: '', buyer: null })
      try {
        await page.getByTestId('site-step').waitFor({ timeout: 8000 })
        assert.match(await page.getByTestId('google-link-note').innerText(), /not added \(cancelled or failed\)/, `empty profile @${width}: the note`)
        await wayForward(page, false, 'failed', `empty profile @${width}`)
        assert.equal(await page.getByTestId('ready-step').count(), 0, `empty profile @${width}: no empty ready card`)
      } finally { await ctx.close() }
    })
    // a link started from the website step (the free site read's guard) comes back there with its way forward
    await check(`/app site step failed @${width}`, async () => {
      const { ctx, page } = await open(width, '/app?google=failed', 'site')
      try {
        await page.getByTestId('site-step').waitFor({ timeout: 8000 })
        assert.match(await page.getByTestId('google-link-note').innerText(), /not added/, `site @${width}: the note`)
        assert.match(await page.getByTestId('trial-refusal').innerText(), /Link Google to this account to read your site free/, `site @${width}: the site-read wording`)
        await wayForward(page, false, 'failed', `site @${width}`)
      } finally { await ctx.close() }
    })
    // the reviewer's repro: a failed result with NO saved search still says how it went (never silent Home)
    await check(`/app no saved search mismatch @${width}`, async () => {
      const { ctx, page } = await open(width, '/app?google=mismatch', null)
      try {
        await page.getByTestId('google-link-note').waitFor({ timeout: 8000 })
        assert.match(await page.getByTestId('google-link-note').innerText(), /uses a different email/, `/app no saved search @${width}`)
      } finally { await ctx.close() }
    })
  }
  if (failures.length) { console.error(`FAIL google-link-return: ${failures.length} of ${checks + failures.length} page checks\n  ${failures.join('\n  ')}`); process.exitCode = 1 }
  else console.log(`OK google-link-return: ${checks} page checks (results x {/app ready, /app ask, /app/leads} x {1280, 390})`)
} catch (e) { console.error('FAIL', e.message); process.exitCode = 1 }
finally { await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true }) }
