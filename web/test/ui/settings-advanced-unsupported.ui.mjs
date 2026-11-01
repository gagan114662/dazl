// The #436 unsupported-adapter gates in Settings > Connectors: a platform the worker cannot read shows
// "Not available yet" with the reason and offers NO consent checkbox, session field or connect button, while a
// supported platform keeps its consent gate. NOT part of `npm test`. Run:
//   cd web && npm run build && node test/ui/settings-advanced-unsupported.ui.mjs   (SHOTS=<dir> saves screenshots)
// Production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed in the
// browser: no worker, no session, no network. Exit 1 on a failed expectation; exit 2 when it cannot run
// (SMOKE_ALLOW_SKIP=1 makes that exit 0).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import path from 'node:path'
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(dir, 'package.json'))
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? (process.exit(0), '') : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
let chromium
try { ({ chromium } = require('playwright')) } catch (e) { notRun(e.message.split('\n')[0]) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const Database = require('better-sqlite3'); const { createHash, randomBytes } = require('crypto')
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-settings-adv-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const PLATFORMS = [
  { platform: 'facebook', allowed: true, supported: false, unsupported_reason: 'Facebook needs a browser worker dazl does not have yet', consent: false, connected: false, enabled: false, last4: null, high_risk: true },
  { platform: 'xiaohongshu', allowed: true, supported: false, unsupported_reason: 'its request signing is not implemented', consent: false, connected: false, enabled: false, last4: null, high_risk: true },
  { platform: 'reddit', allowed: true, supported: true, unsupported_reason: null, consent: false, connected: false, enabled: false, last4: null, high_risk: false },
]
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const p = u.pathname
  if (u.origin !== base) return route.abort()
  if (!p.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (p === '/api/settings/advanced' && req.method() === 'GET') return json({ available: true, version: 'v1', platforms: PLATFORMS })
  return json({}, 404)
})
const page = await ctx.newPage()
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) }
try {
  await page.goto(`${base}/app/settings`, { waitUntil: 'networkidle' })
  const card = page.locator('#connectors')
  await card.getByText('Not available yet', { exact: false }).first().waitFor({ timeout: 10000 })

  // Unsupported: honest reason, and NO consent/session/enable affordance of any kind.
  const fb = card.locator('div.border-t', { has: page.locator('span.font-medium', { hasText: 'Facebook' }) })
  assert.match(await fb.innerText(), /Not available yet - dazl cannot read Facebook: Facebook needs a browser worker dazl does not have yet\. Connecting a session is off for it\./, 'facebook shows the honest unavailable reason')
  assert.equal(await fb.locator('input[type="checkbox"]').count(), 0, 'no consent checkbox for an unsupported platform')
  assert.equal(await fb.locator('input[type="password"]').count(), 0, 'no session field for an unsupported platform')
  assert.equal(await fb.getByRole('button').count(), 0, 'no button of any kind for an unsupported platform')

  const xhs = card.locator('div.border-t', { has: page.locator('span.font-medium', { hasText: 'XiaoHongShu' }) })
  assert.match(await xhs.innerText(), /Not available yet - dazl cannot read XiaoHongShu: its request signing is not implemented\./, 'xiaohongshu shows its own reason')
  assert.equal(await xhs.getByRole('button').count(), 0, 'no button for xiaohongshu either')

  // Supported: the consent gate is exactly as before - checkbox first, button disabled until it is checked.
  const rd = card.locator('div.border-t', { has: page.locator('span.font-medium', { hasText: 'Reddit' }) })
  assert.match(await rd.innerText(), /I understand this can violate Reddit's terms/, 'a supported platform keeps its consent gate')
  assert.equal(await rd.locator('input[type="checkbox"]').count(), 1, 'the consent checkbox renders for reddit')
  assert.match(await rd.innerText(), /Accept and continue/, 'the consent button renders for reddit')
  assert.ok(!(await rd.innerText()).includes('Not available yet'), 'no false unavailable claim on a supported platform')
  await card.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await shot('settings-connectors-unsupported-desktop')

  await page.setViewportSize({ width: 390, height: 844 })
  // The card is taller than the mobile viewport: shoot each unsupported gate scrolled into view.
  await fb.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await shot('settings-connectors-unsupported-mobile')
  await xhs.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await shot('settings-connectors-unsupported-mobile-xhs')
  console.log('PASS settings-advanced-unsupported: unsupported platforms show the honest reason with no consent/session affordance; supported keeps its consent gate')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
