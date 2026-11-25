// Settings' free-trial line (#410, #1704): a fresh account on a deployment without the trial is told the trial is unavailable,
// never that it used three; a used-up account sees its count; a network limit gives retry guidance; the count says what was
// really used and the plan's monthly quota is not shown beside it; no key step. NOT part of
// `npm test`. Run:  cd web && npm run build && node test/ui/trial-status.ui.mjs   (SHOTS=<dir> saves desktop and 390px
// screenshots). Production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed
// in the browser with synthetic usage: no trial activation, no key, no scan.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-trialstatus-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), email_verified_at INTEGER); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt,email_verified_at) VALUES ('u1','s@example.test','x','y',1)").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

// GET /api/usage as the route builds it (app/api/usage/route.ts): a keyless account's trial block with its reason.
const usage = trial => ({ plan: 'free', scans_used: 0, scan_limit: 50, has_key: false, billing_status: null, trial })
const SCENES = [
  ['fresh-unavailable', usage({ funded: false, remaining: 0, used: 0, exempt: false, cap: 3, blocked: 'not_configured' }), 'unavailable', "Free searches aren't available here right now."],
  ['fresh', usage({ funded: true, remaining: 3, used: 0, exempt: false, cap: 3, blocked: null }), 'available', '3 free searches left.'],
  ['available', usage({ funded: true, remaining: 2, used: 1, exempt: false, cap: 3, blocked: null }), 'available', '2 free searches left (1 used).'],
  ['qa', usage({ funded: true, remaining: 3, used: 2, exempt: true, cap: 3, blocked: null }), 'available', 'QA account: unlimited free searches (2 used).'],
  ['used-up', usage({ funded: false, remaining: 0, used: 3, exempt: false, cap: 3, blocked: 'account_cap' }), 'exhausted', 'You have used all 3 free search attempts (a failed attempt that cost something counts; one that stopped after an interruption, or at its spending limit before finding any company, does not).'],
  ['throttled', usage({ funded: false, remaining: 3, used: 0, exempt: false, cap: 3, blocked: 'ip_throttle' }), 'throttled', 'Too many free searches from your network today. Try again tomorrow. You have used 0 of 3 free search attempts.'],
  ['email-used', usage({ funded: false, remaining: 0, used: 1, exempt: false, cap: 3, blocked: 'google_required' }), 'ineligible', 'You have used 1 free search on this account. More need Google sign-in: link Google to this account (no card).'],
  // The money ceiling reached by website reads on the trial, with every scan attempt still unused: the line says
  // which allowance, that reads count toward it, and the true attempt count.
  ['allowance', usage({ funded: false, remaining: 3, used: 0, exempt: false, cap: 3, blocked: 'account_total_cap' }), 'exhausted', "Your free searches' spending allowance is used up (website reads on the free trial count toward it). You have used 0 of 3 free search attempts."],
]
const b = await chromium.launch()
try {
  for (const [width, height, tag] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
    for (const [name, body, state, text] of SCENES) {
      const ctx = await b.newContext({ viewport: { width, height } })
      await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
      const writes = []
      await ctx.route('**/*', async route => {
        const req = route.request(); const u = new URL(req.url())
        if (u.origin !== base) return route.abort()
        if (!u.pathname.startsWith('/api/')) return route.continue()
        if (req.method() !== 'GET') writes.push(`${req.method()} ${u.pathname}`)
        if (u.pathname === '/api/usage') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
      })
      const page = await ctx.newPage()
      await page.goto(`${base}/app/settings`, { waitUntil: 'networkidle' })
      const line = page.getByTestId('trial-status')
      await line.waitFor({ timeout: 15000 })
      assert.equal(await line.getAttribute('data-state'), state, name)
      assert.equal((await line.innerText()).trim(), text, name)
      assert.equal(await line.getByRole('link').count(), 0, `${name}: no key step under the trial line`)
      assert.doesNotMatch(await page.getByTestId('plan-panel').innerText(), /AI key/, `${name}: no AI key on the plan panel`)
      if (name !== 'used-up' && name !== 'allowance') assert.doesNotMatch(await page.getByTestId('plan-panel').innerText(), /used up|used all/, `${name}: never "used up"`)
      if (name === 'allowance') assert.doesNotMatch(await line.innerText(), /used all|used your three/, 'the allowance line never says the attempts are used')
      if (name === 'fresh-unavailable') assert.doesNotMatch(await line.innerText(), /none|used/, 'an unavailable trial claims nothing about past use')
      assert.doesNotMatch(await page.getByTestId('plan-panel').innerText(), /of 50 scans used/, 'the plan quota is not shown beside the free-search count')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll at ${width}px`)
      if (process.env.SHOTS) await page.getByTestId('plan-panel').screenshot({ path: path.join(process.env.SHOTS, `${name}-${tag}.png`) })
      assert.deepEqual(writes, [], 'reading Settings writes nothing')
      await ctx.close()
    }
  }
  console.log('trial status UI check passed: fresh/unavailable says unavailable (no claim about past use), available counts down with what was used, the QA account says what it used, used-up says all 3 attempts used, network limit says try tomorrow, an email account past its first search is told what it used; no key step, no plan quota beside the count; desktop + 390px, no writes')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
