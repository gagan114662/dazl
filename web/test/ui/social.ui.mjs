// Rendered check for "Social opportunities" (was "Replies" / "Thread replies"). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/social.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, every /api/* call stubbed in the
// browser. It proves: the nav says "Social opportunities" (no "Replies" entry), the old URL /app/replies still opens it,
// its heading matches, it points email replies to Inbox, and the Inbox nav entry is unchanged. And availability:
// with Reddit/X not enabled, only a "Coming soon on this workspace" notice shows (no search box, no Add/Check buttons,
// no key prompt, no metrics); with it enabled, the searches card is there and the notice is not.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-social-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }
const b = await chromium.launch()
try {
  let enabled = false
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx.route('**/*', async route => {
    const u = new URL(route.request().url())
    if (u.origin !== base) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    if (u.pathname === '/api/replies') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ queries: [], threads: [], platforms: { reddit: enabled, x: false }, consent: enabled, has_key: false }) })
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/app/replies`, { waitUntil: 'networkidle' })
  await page.locator('main h1').waitFor()
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'social.png') })
  if (process.env.BEFORE_ONLY) { console.log('before shot'); process.exit(0) }
  const nav = page.locator('aside')
  assert.deepEqual(await nav.getByRole('link').allTextContents().then(a => a.filter(t => /Replies|Social|Inbox/.test(t))), ['Social opportunities', 'Inbox'])
  assert.equal(await nav.getByRole('link', { name: 'Social opportunities' }).getAttribute('href'), '/app/replies')
  assert.equal((await page.locator('main h1').textContent()).trim(), 'Social opportunities')
  assert.equal(await page.locator('main').getByRole('link', { name: 'Inbox' }).getAttribute('href'), '/app/inbox')
  // Not enabled on this workspace: nothing that cannot work is offered.
  const main = page.locator('main').last() // the page renders its own <main> inside the layout's
  assert.equal(await page.getByTestId('social-coming-soon').isVisible(), true)
  assert.match(await page.getByTestId('social-coming-soon').textContent(), /Coming soon on this workspace/)
  assert.equal(await main.getByRole('button').count(), 0, 'no Add or Check buttons')
  assert.equal(await main.locator('input, textarea').count(), 0, 'no search box')
  assert.equal(await main.getByRole('heading', { name: 'Searches' }).count(), 0, 'no searches card')
  assert.doesNotMatch(await main.innerText(), /Check for new threads|Reply drafts use your own AI key|No threads yet/)
  // Enabled (with consent): the searches card is there and the notice is gone.
  enabled = true
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Searches' }).waitFor()
  assert.equal(await page.getByTestId('social-coming-soon').count(), 0)
  assert.equal(await main.getByRole('button', { name: 'Check for new threads' }).count(), 1)
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'social-enabled.png') })
  console.log('social opportunities UI check passed')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
