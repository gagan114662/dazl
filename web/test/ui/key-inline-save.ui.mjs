// The first-run brain form after a keyless free read, post-#1703: bring-your-own-key is finished, so the form has NO
// key field and never calls the key route - and continuing it, BY CLICK and BY ENTER inside a text field, runs exactly
// one controlled profile POST with no native document POST. This keeps the original #409 nested-form regression class
// (a parser-dropped nested <form> natively POSTing the page) pinned on the form that remains, after KeyInline became a
// no-op pending deletion (#1879/#1880).
// House style: production build, throwaway database, server under test/helpers/net-fence.ts, every /api/* call
// stubbed in the browser. NOT part of `npm test`. Run: cd web && npm run build && node test/ui/key-inline-save.ui.mjs
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-keyinline-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), email_verified_at INTEGER); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt,email_verified_at) VALUES ('u1','k@example.test','x','y',1)").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const FREE = { free: true, site: 'acme.example', source: 'https://acme.example/', facts: [
  { kind: 'title', text: 'Acme Inc', source: 'https://acme.example/' },
  { kind: 'description', text: 'CRM cleanup for sales teams.', source: 'https://acme.example/' },
] }
// A fresh founder with its free searches intact: the read and the first play run on dazl's keys, no customer key anywhere.
const USAGE = { plan: 'free', scans_used: 0, scan_limit: 50, has_key: false, billing_status: null, trial: { funded: true, remaining: 3, cap: 3 } }

const b = await chromium.launch()
try {
  for (const [tag, pressEnter] of [['click', false], ['enter-key', true]]) {
    const keyCalls = []; const nativePosts = []; const saves = []
    const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
    await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
    await ctx.route('**/*', async route => {
      const req = route.request(); const u = new URL(req.url())
      if (u.origin !== base) return route.abort()
      if (!u.pathname.startsWith('/api/')) return route.continue()
      if (u.pathname === '/api/usage') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USAGE) })
      if (u.pathname === '/api/scan/jobs') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"jobs":[]}' })
      if (u.pathname === '/api/settings/profile' && req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      if (u.pathname === '/api/settings/profile' && req.method() === 'POST') { saves.push(req.postData() ?? ''); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }) }
      if (u.pathname === '/api/settings/llm-key') { keyCalls.push(`${req.method()} ${u.pathname}`); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }) }
      if (u.pathname === '/api/scan/icp-from-url') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FREE) })
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
    })
    const page = await ctx.newPage()
    page.on('request', r => { if (r.isNavigationRequest() && r.method() === 'POST') nativePosts.push(r.url()) })
    await page.goto(`${base}/app?setup=site`, { waitUntil: 'networkidle' })
    await page.getByTestId('site-step').waitFor({ timeout: 15000 })
    await page.getByLabel('Your website').fill('acme.example')
    await page.getByRole('button', { name: 'Read my site' }).click()
    await page.getByTestId('free-site-read').waitFor({ timeout: 15000 })
    // #1703: the brain form offers no key field and no Save key button - searches run on dazl's own keys.
    assert.equal(await page.locator('#ai-key').count(), 0, `${tag}: no key field in the brain form (#1703)`)
    assert.equal(await page.getByRole('button', { name: 'Save key' }).count(), 0, `${tag}: no Save key button (#1703)`)
    assert.equal(await page.getByLabel('Your AI key').count(), 0, `${tag}: no labelled key input anywhere (#1703)`)
    await page.getByLabel('What you sell').fill('CRM cleanup for sales teams.')
    await page.getByLabel('Who buys it').fill('Sales ops teams at B2B SaaS companies.')
    if (pressEnter) await page.getByLabel('What you sell').press('Enter')
    else await page.getByRole('button', { name: 'Looks right, continue' }).click()
    await page.getByText('Who do you want to find?').waitFor({ timeout: 15000 })
    assert.equal(nativePosts.length, 0, `${tag}: no native document POST (the nested-form capture class)`)
    assert.equal(keyCalls.length, 0, `${tag}: the key route is never called (#1703)`)
    assert.equal(saves.length, 1, `${tag}: exactly one controlled profile save`)
    const savedBody = JSON.parse(saves[0])
    assert.equal(savedBody.sells, 'CRM cleanup for sales teams.', `${tag}: the save carries the typed sells`)
    assert.equal(savedBody.website, 'https://acme.example', `${tag}: the save carries the normalized website`)
    assert.equal(savedBody.buyer?.summary, 'Sales ops teams at B2B SaaS companies.', `${tag}: the save carries the typed buyer`)
    if (process.env.SHOTS) await page.locator('[data-testid=onboarding-screen]').first().screenshot({ path: path.join(process.env.SHOTS, `brain-no-key-${tag}.png`) })
    await ctx.close()
    console.log(`PASS ${tag}: brain form has no key field; continue runs one profile POST, no native POST, no key call`)
  }
} finally { srv.kill(); await b.close(); rmSync(tmp, { recursive: true, force: true }) }
console.log('key-inline-save: all journeys pass')
