// Rendered check for "Monitor this search" on Leads (Refs #898: the create-monitor action is restored, not removed).
// NOT part of `npm test`.  Run:  cd web && npm run build && node test/ui/create-monitor.ui.mjs
// Real production build, throwaway database, EVERY /api/* call answered from a stub in the browser: no scan or monitor
// actually runs. It proves, at 390px after hydration settles:
//   1. with no monitors and no search typed, the Continuous Monitors block is absent;
//   2. typing a search shows a visible "Monitor this search" button with a >= 44x44 hit area;
//   3. clicking it sends exactly one POST /api/monitors carrying the typed query, then shows a success status and the
//      refreshed list contains the new monitor;
//   4. a plan-limit refusal (monitor_limit) shows the plan message and no success status.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-monitor-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const QUERY = 'dental clinics in Ontario opening a second location'
const b = await chromium.launch()
async function open(mode) {
  const posts = []; let monitors = []
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/api/usage') return json({ plan: 'pro', scans_used: 1, scan_limit: 10, has_key: true, trial: null })
    if (p === '/api/scan/jobs') return json({ jobs: [] })
    if (p === '/api/monitors' && m === 'GET') return json({ monitors })
    if (p === '/api/monitors' && m === 'POST') {
      posts.push(JSON.parse(req.postData() || '{}'))
      if (mode === 'limit') return json({ error: 'monitor_limit', limit: 3 }, 400)
      monitors = [{ id: 'm1', query: posts.at(-1).query, interval_hours: 24, enabled: 1, paused_reason: null, next_run_at: null, last_new_count: null, run_count: 0 }]
      return json({ id: 'm1' }, 201)
    }
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/app/leads`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500) // let hydration settle
  return { ctx, page, posts }
}
try {
  {
    const { ctx, page, posts } = await open('ok')
    assert.equal(await page.getByTestId('monitors').count(), 0, 'no monitors block before a search is typed')
    await page.locator('#play').fill(QUERY)
    const btn = page.getByTestId('create-monitor')
    await btn.waitFor({ state: 'visible' })
    const box = await btn.boundingBox()
    assert.ok(box && box.width >= 44 && box.height >= 44, `hit area is at least 44x44 (got ${box?.width}x${box?.height})`)
    await btn.click()
    await page.getByTestId('monitor-created').waitFor()
    assert.equal(posts.length, 1, 'exactly one POST /api/monitors')
    assert.equal(posts[0].query, QUERY, 'the typed search is what gets monitored')
    await page.getByTestId('monitors').getByText(QUERY).first().waitFor()
    assert.equal(await page.getByTestId('monitor-error').count(), 0, 'no error on success')
    await ctx.close()
  }
  {
    const { ctx, page, posts } = await open('limit')
    await page.locator('#play').fill(QUERY)
    await page.getByTestId('create-monitor').click()
    await page.getByTestId('monitor-error').waitFor()
    assert.match(await page.getByTestId('monitor-error').textContent(), /Your plan allows 3 monitors\./)
    assert.equal(posts.length, 1)
    assert.equal(await page.getByTestId('monitor-created').count(), 0, 'no success status on refusal')
    await ctx.close()
  }
  console.log('PASS create-monitor')
} catch (e) { console.error(e); process.exitCode = 1 } finally { await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true }) }
