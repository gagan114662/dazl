// Rendered check: Find leads is disabled while a scan is running or enriching (finishing contacts / people / fit), with a short reason
// shown, and enabled again once the scan completes or fails. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/scan-active.ui.mjs
// Real production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call answered from a stub in the browser:
// no scan runs, nothing is sent. The scan state is switched by the test; the page picks it up on its next status poll.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-findleads-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const b = await chromium.launch()
const JOB = 'c'.repeat(24)
let state = 'running'
const posts = []
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
  if (u.origin !== base) return route.abort()
  if (!p.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (m === 'POST' && p === '/api/scan') { posts.push(p); return json({ error: 'scan_active', message: 'A scan is still running or finishing. Wait for it to end before starting another.' }, 409) }
  if (p === '/api/usage') return json({ plan: 'free', scans_used: 1, scan_limit: 10, has_key: true, trial: null })
  if (p === '/api/settings/advanced') return json({ available: true, platforms: [] })
  if (p === '/api/scan/jobs') return json({ jobs: [{ id: JOB, status: state, error: null, query: 'Dental practices in Ohio', business_name: 'Acme', csv_domain: null, created_at: 1, finished_at: null, candidates: null, verified: null, needs_review: null, dropped: null, lead_count: 0, test_only: false }] })
  if (p === '/api/scan/status') return json({ job_id: JOB, status: state, lead_count: 0, attempts: 1, max_attempts: 3, claimed_at: 1, created_at: 1, error: state === 'failed' ? 'key_rejected' : null, quality: null })
  if (p === '/api/leads') return json({ leads: [], hidden_count: 0 })
  return json({}, 404)
})
const page = await ctx.newPage()
const find = () => page.getByRole('button', { name: 'Find leads' })
const reason = () => page.locator('[data-reason="scan-active"]')
const until = async (fn, what) => { for (let i = 0; i < 40; i++) { if (await fn()) return; await page.waitForTimeout(500) } assert.fail(`timed out: ${what}`) }
try {
  await page.goto(`${base}/app/leads`, { waitUntil: 'networkidle' })
  await page.locator('main textarea').first().fill('Dental practices in Ohio opening a new location')
  // running: disabled with a reason
  await until(async () => await find().isDisabled(), 'Find leads disabled while the scan runs')
  assert.match(await reason().textContent(), /scan is already running/)
  // enriching: still disabled, and the reason says it is finishing
  state = 'enriching'
  await until(async () => /finishing/.test((await reason().textContent().catch(() => '')) ?? ''), 'reason says the scan is finishing')
  assert.equal(await find().isDisabled(), true, 'Find leads stays disabled while enriching')
  assert.equal(await page.getByText('Finishing - finding contacts and checking fit.').isVisible(), true)
  // done: enabled again, no reason
  state = 'done'
  await until(async () => await find().isEnabled(), 'Find leads enabled once the scan is done')
  assert.equal(await reason().count(), 0)
  // failed (a new scan that failed): also enabled
  state = 'failed'
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  assert.equal(await find().isEnabled(), true, 'enabled after a failed scan')
  assert.equal(posts.length, 0, 'no scan was started while the button was disabled')
  console.log('scan-active UI check passed: Find leads disabled during running and enriching (with a reason), enabled after done and failed')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
