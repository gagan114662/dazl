// Production smoke check: loads every /app page from a production build in a real browser.
// NOT part of `npm test` (needs a build and a browser). Run:  cd web && npm run build && npm run test:smoke
// Isolated: a throwaway SQLite database with one seeded user and session, search/crawl flags off, and every browser
// request to a host other than the local server is aborted. Nothing is scanned, sent or billed.
// Fails (exit 1) on any page error, console error, ChunkLoadError, 4xx/5xx static asset, redirect to sign-in or missing <h1>.
// Exit 0 with "SKIP" when playwright/chromium or the .next build is missing.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'
const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
let chromium
try { ({ chromium } = require('playwright')) } catch (e) { console.log(`SKIP: ${e.message.split('\n')[0]}`); process.exit(0) }
if (!existsSync(path.join(root, '.next/BUILD_ID'))) { console.log('SKIP: no production build (run npm run build first)'); process.exit(0) }
const Database = require('better-sqlite3')

// Every page under app/app, so a new page is covered without editing this file. Dynamic segments are skipped.
function pages(dir, route) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) { if (!name.startsWith('[') && !name.startsWith('_')) out.push(...pages(full, `${route}/${name}`)) }
    else if (name === 'page.tsx') out.push(route)
  }
  return out
}
const routes = pages(path.join(root, 'app/app'), '/app').sort()

const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-smoke-'))
const DB_PATH = path.join(tmp, 'app.db')
const db = new Database(DB_PATH)
db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()));
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id, email, password_hash, salt) VALUES ('smoke-user', 'smoke@example.test', 'x', 'y')").run()
const token = randomBytes(32).toString('hex')
db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), 'smoke-user', Math.floor(Date.now() / 1000) + 3600)
db.close()

const port = await new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)) }) })
const base = `http://127.0.0.1:${port}`
const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', DB_PATH, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', PUBLIC_BASE_URL: base }
const server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''; server.stdout.on('data', d => { serverLog += d }); server.stderr.on('data', d => { serverLog += d })
const failures = []
let browser
try {
  for (let i = 0; ; i++) {
    try { await fetch(`${base}/sign-in`); break } catch { if (i > 100 || server.exitCode !== null) throw new Error(`server did not start\n${serverLog}`); await new Promise(r => setTimeout(r, 200)) }
  }
  browser = await chromium.launch()
  const ctx = await browser.newContext()
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
  for (const route of routes) {
    const page = await ctx.newPage(); const errs = []
    page.on('pageerror', e => errs.push(`page error: ${e.name}: ${e.message.split('\n')[0]}`))
    page.on('console', m => { if (m.type() === 'error') errs.push(`console error: ${m.text().split('\n')[0]}`) })
    page.on('response', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/_next/') && r.status() >= 400) errs.push(`asset ${r.status()} ${u.pathname}`) })
    const res = await page.goto(base + route, { waitUntil: 'networkidle' })
    await page.waitForTimeout(500)
    if (!res || res.status() >= 400) errs.push(`HTTP ${res?.status()}`)
    if (new URL(page.url()).pathname !== route) errs.push(`landed on ${new URL(page.url()).pathname}`)
    const h1 = await page.locator('main h1').first().textContent({ timeout: 5000 }).catch(() => null)
    if (!h1) errs.push('no <h1> rendered')
    console.log(`${errs.length ? 'FAIL' : 'ok  '} ${route}${h1 ? ` (${h1.trim()})` : ''}`)
    for (const e of errs) { console.log(`     ${e}`); failures.push(`${route}: ${e}`) }
    await page.close()
  }
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  rmSync(tmp, { recursive: true, force: true })
}
if (failures.length) { console.log(`\n${failures.length} problem(s) across ${routes.length} pages`); process.exit(1) }
console.log(`\nAll ${routes.length} /app pages loaded from the production build without errors.`)
