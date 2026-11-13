// #917 follow-up (Hermes live check on staging after #1118): at 390 px the draft card's Run button was pushed off the card (427 px wide in
// a 374 px card) and the "left out" disclosure was squeezed beside it. This check uses the REAL production build and its CSS (the #1118
// check bundled LeadsClient with no stylesheet, so its "no overflow" assertion could not see this), every /api/* call answered from a stub.
// NOT part of `npm test`. Run:  cd web && npm run build && node test/ui/run-button-fit-917.ui.mjs   (SHOTS=<dir> saves screenshots)
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-runfit-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), email_verified_at INTEGER); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt,email_verified_at) VALUES ('u1','s@example.test','x','y',1)").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })

const LONG = 'Find independent bookkeeping firms in Ohio and Indiana with 5 to 500 staff that are hiring a controller or a senior accountant this quarter, '
  + 'run by the founder, not part of a franchise or a national chain, that use QuickBooks Online, '
  + 'and that have posted on LinkedIn about closing the monthly books faster; exclude firms that only do payroll or tax preparation for individuals or estates.'
assert.equal(LONG.length, 388)
const b = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {})
const results = []
try {
  for (const [label, width] of [['390', 390], ['640', 640], ['700', 700], ['768', 768], ['1024', 1024], ['1280', 1280]]) {
    const ctx = await b.newContext({ viewport: { width, height: 900 } })
    await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
    await ctx.route('**/*', async route => {
      const req = route.request(); const u = new URL(req.url()); const p = u.pathname
      if (u.origin !== base) return route.abort()
      if (!p.startsWith('/api/')) return route.continue()
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (p === '/api/scan/icp') return json({ icp: { summary: LONG.slice(0, 300), who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] }, inferred: false,
        coverage: { complete: false, kept_chars: 300, request_chars: 388, dropped: LONG.slice(300) } })
      if (p === '/api/scan/jobs') return json({ jobs: [] })
      if (p === '/api/usage') return json({ plan: 'free', scans_used: 0, scan_limit: 10, has_key: true, trial: null })
      if (p === '/api/settings/llm-key') return json({ keys: [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1 }], rejection: null })
      return json({}, 404)
    })
    const page = await ctx.newPage()
    await page.goto(base + '/app/leads', { waitUntil: 'networkidle' })
    await page.locator('#play').fill(LONG)
    await page.getByRole('button', { name: 'Review profile first' }).click()
    const dropped = page.getByTestId('draft-dropped'); await dropped.waitFor({ timeout: 15000 })
    const run = page.getByRole('button', { name: 'Run scan with this profile' }).first()
    const card = dropped.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " card ")][1]')
    const [c, r, d, n] = [await card.boundingBox(), await run.boundingBox(), await dropped.boundingBox(), await page.getByTestId('draft-note').boundingBox()]
    const inner = await card.evaluate(e => { const s = getComputedStyle(e); return e.getBoundingClientRect().width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) })
    results.push(`${label}: card ${c.width}px, Run ${Math.round(r.width)}px at x ${Math.round(r.x)}-${Math.round(r.x + r.width)}, disclosure ${Math.round(d.width)}px, note ${Math.round(n.width)}px`)
    assert.ok(r.x >= c.x - 0.5 && r.x + r.width <= c.x + c.width + 0.5, `${label}: the Run button stays inside the card (${results.at(-1)})`)
    assert.ok(r.x + r.width <= width + 0.5, `${label}: the Run button is on screen`)
    assert.equal(await page.getByRole('button', { name: 'Run scan with this profile' }).count(), 2, `${label}: the card has its two Run buttons`)
    const r2 = await page.getByRole('button', { name: 'Run scan with this profile' }).last().boundingBox()   // the card's second Run button, at its foot
    assert.ok(r2.x >= c.x - 0.5 && r2.x + r2.width <= c.x + c.width + 0.5, `${label}: the second Run button stays inside the card too`)
    assert.ok(await run.isVisible(), `${label}: the Run button is visible`)
    assert.ok(d.width >= inner * 0.6 && n.width >= inner * 0.6, `${label}: the note and the disclosure get at least 60% of the card's width, never squeezed beside the button (${results.at(-1)})`)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${label}: no horizontal scroll`)
    await dropped.scrollIntoViewIfNeeded()
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `run-button-fit-${label}.png`), fullPage: false })
    await ctx.close()
  }
  console.log(`run button fit UI check passed (real CSS): ${results.join('; ')}`)
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
