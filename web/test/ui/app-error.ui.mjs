// Rendered check for the /app error boundary when a page breaks AFTER an action already succeeded. NOT part of
// `npm test`. Run:  cd web && npm run build && node test/ui/app-error.ui.mjs   (SHOTS=<dir> also saves a screenshot)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, every /api/* call stubbed in the
// browser (nothing is approved or sent anywhere). Scenario: on Outreach the user approves a draft (the POST succeeds),
// then the reload of the list returns malformed data and the page throws while rendering. It proves:
//   1. the boundary shows in the content area (nav stays), never a blank page;
//   2. its copy does not claim the action had no effect, and tells the user to check the result before repeating;
//   3. Try again re-renders without submitting anything: the one successful POST is the only write.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-apperror-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }
const b = await chromium.launch()
try {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const writes = []; let approved = false
  const draft = { id: 'm1', to_email: 'owner@dentist.example', subject: 'Your new office', body: 'Hi Dr. Lee, congrats on the new office in Dublin.', status: 'draft', error: null, sent_at: null, send_footer: 'Dana\n1 Main St\nUnsubscribe', evidence_state: 'machine', provenance: null }
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (m !== 'GET') writes.push(`${m} ${p}`)
    if (p === '/api/outreach/m1' && m === 'POST') { approved = true; return json({ ok: true }) }
    // After the approval succeeds, the list comes back malformed: the page throws while rendering.
    if (p === '/api/outreach' && m === 'GET') return json(approved ? { messages: { malformed: true } } : { messages: [draft] })
    if (p === '/api/outreach/sequences') return json({ sequences: [], test_addresses: [], status: {}, campaigns: [] })
    if (p === '/api/outreach/settings') return json({ gmail: { email: 'me@example.test', status: 'active', read_granted: false }, sender: { sender_name: 'Dana', postal_address: '1 Main St, Columbus OH' } })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/app/outreach`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Approve' }).click()
  const boundary = page.locator('main [role="alert"]')
  await boundary.waitFor({ timeout: 10000 })
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'error-after-success.png') })
  const text = (await boundary.innerText()).replace(/\s+/g, ' ')
  assert.match(text, /This page could not be shown/)
  assert.match(text, /may already have gone through: reload and check its result before doing it again/)
  assert.doesNotMatch(text, /nothing (was|is|has been) (sent|changed|affected)|not affected|no effect/i, 'never claims the action had no effect')
  assert.equal(await page.locator('aside').getByRole('link', { name: 'Outreach' }).isVisible(), true, 'nav stays')
  assert.deepEqual(writes, ['POST /api/outreach/m1'], 'the one successful approval')
  await boundary.getByRole('button', { name: 'Try again' }).click()
  await page.waitForTimeout(1500)
  assert.deepEqual(writes, ['POST /api/outreach/m1'], 'Try again submits nothing')
  assert.equal(await boundary.getByRole('button', { name: 'Reload' }).isVisible(), true)
  console.log('app error UI check passed: error after a successful action shows uncertainty-safe copy; Try again writes nothing')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
