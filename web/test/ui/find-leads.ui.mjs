// Rendered check for the Leads search area: one primary action, everything else under "More sources", and only
// sources the account can actually use. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/find-leads.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call answered from a
// stub in the browser: no scan runs, no key check, nothing is imported. Off-host requests are aborted. It proves:
//   1. the search area has one primary button ("Find leads"); the secondary sources are not on screen until
//      "More sources" is opened;
//   2. inside it: the built-in public sources, the website fill, Review a source, Companies posting roles;
//      connected social sources only when consented+connected+enabled (others are absent, not offered);
//   3. a free account does not see the Pro-only imports, only one line saying where they are; a Pro account does;
//   4. a source ticked under More sources still reaches the scan: Find leads sends exactly one
//      POST /api/scan carrying it.
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
async function open(plan) {
  const writes = []; const scanBodies = []
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (m !== 'GET') writes.push(`${m} ${p}`)
    if (p === '/api/usage') return json({ plan, scans_used: 1, scan_limit: 10, has_key: true, trial: null })
    // X is consented, connected and enabled; LinkedIn is not connected; Reddit has no consent. Only X is usable.
    if (p === '/api/settings/advanced') return json({ available: true, platforms: [
      { platform: 'x', consent: true, connected: true, enabled: true },
      { platform: 'linkedin', consent: true, connected: false, enabled: false },
      { platform: 'reddit', consent: false, connected: true, enabled: true },
    ] })
    if (p === '/api/scan/jobs') return json({ jobs: [] })
    if (p === '/api/scan' && m === 'POST') { scanBodies.push(JSON.parse(req.postData())); return json({ job_id: 'b'.repeat(24) }, 202) }
    if (p === '/api/scan/status') return json({ status: 'pending', lead_count: 0, attempts: 0, max_attempts: 3 })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/app/leads`, { waitUntil: 'networkidle' })
  await page.getByTestId('play-settings').locator('summary').first().click() // sources live in the closed "Settings for this play" drawer
  return { ctx, page, writes, scanBodies }
}
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) }
try {
  if (process.env.BEFORE_ONLY) { const { page } = await open('free'); await page.waitForTimeout(800); await shot(page, 'leads'); console.log('before shot'); process.exit(0) }
  // Free account.
  const { ctx, page, writes, scanBodies } = await open('free')
  const more = page.getByTestId('more-sources')
  await more.waitFor()
  await shot(page, 'leads')
  const main = page.locator('main')
  assert.deepEqual(await main.locator('button.btn-primary:visible').allTextContents(), ['Find leads'], 'one primary action')
  for (const t of ['Bulk import company domains (Pro)', 'Import post commenters (Pro)', 'Also search public GitHub repositories', 'Fill from my website']) assert.equal(await page.getByText(t).first().isVisible(), false, `${t} is not on screen until More sources is opened`)
  await more.locator('summary').first().click()
  for (const t of ['Also search public GitHub repositories', 'Also search public YouTube videos', 'Also read public job postings', 'Fill from my website']) assert.equal(await more.getByText(t).first().isVisible(), true, t)
  assert.equal(await more.locator('details > summary').count() >= 2, true, 'Review a source and Companies posting roles are inside More sources')
  assert.equal(await more.getByText('Also search X posts (via web index, no account risk)').isVisible(), true, 'a usable social source is offered')
  assert.equal(await more.getByText(/linkedin|reddit/i).count(), 0, 'unusable social sources are not offered')
  assert.equal(await more.getByText('Bulk import company domains (Pro)').count(), 0)
  assert.equal(await more.getByText('Import post commenters (Pro)').count(), 0)
  assert.match(await more.getByTestId('pro-sources-note').textContent(), /on the Pro plan/)
  assert.equal(await more.getByTestId('pro-sources-note').getByRole('link').getAttribute('href'), '/app/settings#plan')
  await shot(page, 'more-sources-free')
  // A ticked source still reaches the scan.
  await page.locator('main textarea').first().fill('Dental practice owners in Ohio opening a new location')
  await more.getByText('Also search public GitHub repositories').click()
  assert.deepEqual(writes, [], 'nothing written before a run')
  await page.getByRole('button', { name: 'Find leads' }).click()
  await page.waitForTimeout(800)
  assert.equal(scanBodies.length, 1)
  assert.deepEqual(scanBodies[0].sources?.adapters, ['github'])
  assert.equal(scanBodies[0].query, 'Dental practice owners in Ohio opening a new location')
  await ctx.close()
  // Pro account: the imports are there.
  const pro = await open('pro')
  const more2 = pro.page.getByTestId('more-sources'); await more2.waitFor(); await more2.locator('summary').first().click()
  assert.equal(await more2.getByText('Bulk import company domains (Pro)').isVisible(), true)
  assert.equal(await more2.getByText('Import post commenters (Pro)').isVisible(), true)
  assert.equal(await more2.getByTestId('pro-sources-note').count(), 0)
  await shot(pro.page, 'more-sources-pro')
  await pro.ctx.close()
  console.log('find leads UI check passed: one primary action; More sources truthful for free and pro; ticked source reached the one scan request')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
