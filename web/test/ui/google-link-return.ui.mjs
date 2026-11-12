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
import { spawn } from 'node:child_process'
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
]
const b = await chromium.launch()
async function open(width, url, pending) {
  const ctx = await b.newContext({ viewport: { width, height: 900 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/api/usage') return json({ plan: 'free', scans_used: 0, scan_limit: 10, has_key: false, trial: { funded: true, remaining: 3, cap: 3, blocked: null } })
    if (p === '/api/settings/profile') return json(PROFILE)
    if (p === '/api/settings/advanced') return json({ available: true, platforms: [] })
    if (p === '/api/scan/jobs') return json({ jobs: [] })
    if (p === '/api/scan/latest') return json({ query: 'an OLDER search from the last job', icp: null }) // must never replace the restored one
    if (p === '/api/auth/email') return json({ email: 'pat@example.test', verified: false, google: false })
    if (p === '/api/auth/reauth') return json({ fresh: true, method: 'password' })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/robots.txt`)
  if (pending) await page.evaluate(([q, step]) => sessionStorage.setItem('dazl_pending_search', JSON.stringify({ query: q, step, at: Date.now() })), [QUERY, pending])
  await page.goto(base + url, { waitUntil: 'networkidle' })
  return { ctx, page }
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
        assert.equal(await page.getByTestId('ready-cta').isEnabled(), true, `${label}: Run is enabled`)
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
        assert.equal(await page.locator('form:has(#ask) button.send').isEnabled(), true, `${label}: Run is enabled`)
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
        await o.page.waitForTimeout(300) // let /api/scan/latest land: it must not replace the restored search
        assert.equal(await o.page.locator('#play').inputValue(), QUERY, `${label}: the same search is back`)
        assert.equal(await o.page.locator('form:has(#play) button.send').isEnabled(), true, `${label}: Find leads is enabled`)
        assert.equal(await saved(o.page) !== null, !ok, `${label}: ${ok ? 'consumed' : 'kept'}`)
        await noOverflow(o.page, label)
        if (process.env.SHOTS) await o.page.screenshot({ path: path.join(process.env.SHOTS, `leads-${result}-${width}.png`), fullPage: true })
        } finally { await o.ctx.close() }
      })
    }
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
