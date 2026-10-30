// Rendered check for unsupported session adapters in Settings (#436). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/advanced-unsupported.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, the REAL /api/settings/advanced
// route, off-host requests aborted. (net-fence scrubs *TOKEN* env vars, so the session tier itself reads as off.)
// At desktop (1280) and phone (390) width it proves: Facebook and XiaoHongShu show "Not available" once, with no risk
// notice, consent button or session field; Reddit (supported) is not marked unavailable; no horizontal scroll.
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
const { migrateAllSqlite } = await import(path.join(dir, 'lib/db/sqlite-migrations.ts'))
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-advunsup-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
migrateAllSqlite(db)
db.prepare("INSERT INTO users (id, email, password_hash, salt) VALUES ('u1', 's@example.test', 'x', 'y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600)
db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0',
  ADVANCED_CONNECTORS: '1', ADVANCED_WORKER_URL: 'http://worker.invalid:9', ADVANCED_WORKER_TOKEN: 'synthetic', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }
const b = await chromium.launch()
try {
  for (const w of [1280, 390]) {
    const ctx = await b.newContext({ viewport: { width: w, height: 900 } })
    await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
    const page = await ctx.newPage(); await page.route(u => u.origin !== base, r => r.abort())
    await page.goto(`${base}/app/settings#social`, { waitUntil: 'networkidle' })
    for (const p of ['facebook', 'xiaohongshu']) {
      const card = page.getByTestId(`channel-${p}`); await card.waitFor({ timeout: 15000 })
      const text = (await card.innerText()).replace(/\s+/g, ' ')
      assert.match(text, /Not available/i, `${p}@${w}: badge`)
      assert.match(text, /Not available: .* No session is collected and scans never search it\./, `${p}@${w}: note`)
      assert.equal((text.match(/Not available:/g) ?? []).length, 1, `${p}@${w}: said once`)
      assert.equal(await card.locator('input, button').count(), 0, `${p}@${w}: no consent, session or connect control`)
      await card.scrollIntoViewIfNeeded()
      if (process.env.SHOTS) { const box = await card.boundingBox(); const y = Math.max(0, box.y - 40); await page.screenshot({ path: path.join(process.env.SHOTS, `${p}-${w}.png`), clip: { x: 0, y, width: w, height: Math.min(box.height + 80, 900 - y) } }) }
    }
    // a supported platform is not marked unavailable (net-fence scrubs the worker token, so the tier shows as off here)
    const reddit = (await page.getByTestId('channel-reddit').innerText()).replace(/\s+/g, ' ')
    assert.match(reddit, /Needs worker/i); assert.doesNotMatch(reddit, /Not available/i)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `no horizontal scroll @${w}`)
    await ctx.close()
  }
  console.log('unsupported adapters UI check passed at 1280 and 390: Facebook and XiaoHongShu are "Not available" with no consent or session controls; supported platforms are not marked unavailable')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
