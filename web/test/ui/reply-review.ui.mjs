// Rendered check for reply classification in the inbox (#368). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/reply-review.ui.mjs   (SHOTS=<dir> also saves screenshots, desktop and 390px)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, and /api/outreach/inbox answered
// FROM A STUB in the browser (synthetic replies; no Gmail, nothing sent). It proves the inbox labels an uncertain reply
// "needs your review" and says its follow-ups are stopped for review, next to opted-out and interested replies.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-replyreview-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const row = (id, cls, excerpt, stopped, company) => ({ gmail_id: id, thread_id: `t-${id}`, from_email: `sam@${company.toLowerCase()}.example`, excerpt, classification: cls, received_at: 1761600000, company, lead_name: 'Sam Example', followups_sent: 0, stopped })
const ROWS = [
  row('r1', 'uncertain', '', 'review', 'Northwind'),
  row('r2', 'opt_out', 'Bitte abmelden, danke.', 'opt_out', 'Brightline'),
  row('r3', 'positive', 'Sounds good, tell me more', null, 'Acme'),
]
const b = await chromium.launch()
const shots = process.env.SHOTS
const run = async (width, label) => {
  const ctx = await b.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx.route('**/*', async route => {
    const u = new URL(route.request().url())
    if (u.origin !== base) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (u.pathname === '/api/outreach/inbox') return json({ available: true, consent_accepted: true, read_granted: true, account: 'me@acme.example', rows: ROWS, booking_url: null })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/app/inbox`, { waitUntil: 'networkidle' })
  await page.getByText('needs your review').first().waitFor({ timeout: 20000 })
  const text = await page.locator('main').textContent()
  assert.match(text, /needs your review/)
  assert.match(text, /Follow-ups stopped: this reply needs your review/)
  assert.match(text, /opted out/)
  assert.match(text, /Follow-ups stopped \(opt out\)/)
  assert.match(text, /interested/)
  if (shots) await page.screenshot({ path: path.join(shots, `inbox-review-${label}.png`), fullPage: true })
  await ctx.close()
}
try {
  await run(1280, 'desktop')
  await run(390, 'mobile')
  console.log('reply review UI check passed: an uncertain reply shows "needs your review" and its stopped follow-ups, beside opted-out and interested replies (desktop and 390px)')
} catch (e) { console.error(e); process.exitCode = 1 } finally { await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true }) }
