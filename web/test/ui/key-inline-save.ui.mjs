// KeyInline inside the first-run brain form (#409): on 40e7bf30 the nested <form> was parser-dropped, so 'Save key'
// submitted the BRAIN form natively (POST /app) - no llm-key PUT, state lost (reviewer-confirmed: real Chromium,
// server logs, pixels; E2/E3 blocked). This drives the real UI through the fixed path on the exact build under
// test: keyless free read -> brain step (KeyInline inside the brain <form>) -> Save key BY CLICK and BY ENTER ->
// the llm-key PUT runs, no native document POST ever happens, and onSaved's keyed re-read fires.
// House style: production build, throwaway database, server under test/helpers/net-fence.ts, every /api/* call
// stubbed in the browser (the persist chain against the real encrypted store is the reviewer's fenced harness).
// NOT part of `npm test`. Run: cd web && npm run build && node test/ui/key-inline-save.ui.mjs
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import path from 'node:path'
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(dir, 'package.json'))
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? ' (allowed by SMOKE_ALLOW_SKIP=1)' : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
let chromium
try { ({ chromium } = require('playwright')) } catch (e) { notRun(e.message.split('\n')[0]) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const Database = require('better-sqlite3'); const { createHash, randomBytes } = require('crypto')
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-keyinline-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','k@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const FREE = { free: true, site: 'acme.example', source: 'https://acme.example/', facts: [
  { kind: 'title', text: 'Acme Inc', source: 'https://acme.example/' },
  { kind: 'description', text: 'CRM cleanup for sales teams.', source: 'https://acme.example/' },
] }
const KEYED = { sells: 'CRM cleanup for sales teams', source: 'https://acme.example/', icp: { summary: 'Sales ops teams at B2B SaaS companies.', who: ['Sales ops managers'], industries: ['B2B SaaS'], sizes: [], where: [], signals: [], exclude: [] } }
const usage = hasKey => ({ plan: 'free', scans_used: 0, scan_limit: 50, has_key: hasKey, billing_status: null, trial: null })

const b = await chromium.launch()
try {
  for (const [tag, pressEnter] of [['click', false], ['enter-key', true]]) {
    const puts = []; const icpCalls = []; const nativePosts = []
    const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
    await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
    await ctx.route('**/*', async route => {
      const req = route.request(); const u = new URL(req.url())
      if (u.origin !== base) return route.abort()
      if (!u.pathname.startsWith('/api/')) return route.continue()
      if (u.pathname === '/api/usage') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(usage(puts.length > 0)) })
      if (u.pathname === '/api/scan/jobs') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"jobs":[]}' })
      if (u.pathname === '/api/settings/profile' && req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      if (u.pathname === '/api/settings/llm-key' && req.method() === 'PUT') { puts.push(req.postData() ?? ''); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }) }
      if (u.pathname === '/api/scan/icp-from-url') { icpCalls.push(req.postData() ?? ''); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(puts.length > 0 ? KEYED : FREE) }) }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
    })
    const page = await ctx.newPage()
    page.on('request', r => { if (r.isNavigationRequest() && r.method() === 'POST') nativePosts.push(r.url()) })
    await page.goto(`${base}/app?setup=site`, { waitUntil: 'networkidle' })
    await page.getByTestId('site-step').waitFor({ timeout: 15000 })
    await page.getByLabel('Your website').fill('acme.example')
    await page.getByRole('button', { name: 'Read my site' }).click()
    await page.getByTestId('free-site-read').waitFor({ timeout: 15000 })
    // KeyInline is inside the brain <form> here: the placement that ate the save on the released build.
    assert.ok(await page.locator('form #ai-key').isVisible(), `${tag}: KeyInline rendered inside the brain form`)
    await page.locator('#ai-key').fill('sk-ant-fixture-key-0123456789')
    if (pressEnter) await page.locator('#ai-key').press('Enter')
    else await page.getByRole('button', { name: 'Save key' }).click()
    await page.waitForTimeout(2500)
    assert.equal(nativePosts.length, 0, `${tag}: no native document POST (the nested-form capture)`)
    assert.equal(puts.length, 1, `${tag}: exactly one llm-key PUT`)
    const body = JSON.parse(puts[0])
    assert.equal(body.vendor, 'anthropic', `${tag}: vendor from the key prefix`)
    assert.equal(body.api_key, 'sk-ant-fixture-key-0123456789', `${tag}: the trimmed key is what goes out`)
    assert.equal(icpCalls.length, 2, `${tag}: onSaved re-read the site (keyed)`)
    await page.getByTestId('ready-step').waitFor({ timeout: 30000 })
    assert.equal(await page.getByTestId('free-site-read').count(), 0, `${tag}: keyed re-read replaced the free card`)
    if (process.env.SHOTS) await page.locator('[data-testid=onboarding-screen]').first().screenshot({ path: path.join(process.env.SHOTS, `key-inline-save-${tag}.png`) })
    await ctx.close()
    console.log(`PASS ${tag}: KeyInline save runs the real PUT inside the brain form; no native POST`)
  }
} finally { srv.kill(); await b.close(); rmSync(tmp, { recursive: true, force: true }) }
console.log('key-inline-save: all journeys pass')
