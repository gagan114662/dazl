// Rendered check for the compiled targeting plan on the Leads review step (#876 / #752). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/plan-view.ui.mjs   (SHOTS=<dir> also saves screenshots at 1280 and 390 px)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, every /api/* call answered from a browser stub. NOTHING about the plan is stubbed:
// the page compiles the request in the box with the real compiler (the same query and expected structure live in test/helpers/plan-view-fixture.json, which
// test/targeting-plan-view.test.ts proves the real compiler produces). It proves the plan is shown above Run, starts nothing, fits at both widths, and follows edits:
// changing the request recompiles it, and the request Run sends is the one the plan describes.
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-playstep-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const PROFILE = { business_name: 'Bright Smile Software', sells: 'Online booking for dental practices', website: 'https://brightsmile.example',
  buyer: { summary: 'Dental practices', who: ['Dental practice owners', 'Clinic administrators'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['opened a new location', 'hiring front-desk staff', 'switching practice software'], exclude: [] } }
const ICP = { summary: 'Clinic administrators in Ohio hiring front-desk staff', who: ['Clinic administrators'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['hiring front-desk staff'], exclude: [] }

const FIX = JSON.parse(readFileSync(path.join(dir, 'test/helpers/plan-view-fixture.json'), 'utf8'))
const b = await chromium.launch()
async function open(profile) {
  const writes = []; const scanBodies = []
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (m !== 'GET') writes.push(`${m} ${p}`)
    if (p === '/api/settings/profile' && m === 'GET') return json({ ...profile, new_play_offer: profile.sells || null }) // as the route: the profile offer (no Memory here)
    if (p === '/api/usage') return json({ plan: 'free', scans_used: 1, scan_limit: 10, has_key: true, trial: null })
    if (p === '/api/settings/advanced') return json({ available: false, platforms: [] })
    if (p === '/api/scan/jobs') return json({ jobs: [] })
    if (p === '/api/scan/latest') return json({})
    if (p === '/api/scan/icp' && m === 'POST') return json({ icp: ICP, inferred: true })
    if (p === '/api/scan/estimate' && m === 'POST') { scanBodies.push(JSON.parse(req.postData())); return json({ error: 'stub' }, 400) }
    if (p === '/api/scan' && m === 'POST') { scanBodies.push(JSON.parse(req.postData())); return json({ job_id: 'b'.repeat(24) }, 202) }
    if (p === '/api/scan/status') return json({ status: 'pending', lead_count: 0, attempts: 0, max_attempts: 3 })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/app/leads`, { waitUntil: 'networkidle' })
  return { ctx, page, writes, scanBodies }
}
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: false }) }
const WIDTHS = [1280, 390]
const kindsOf = page => page.getByTestId('plan-view').getByTestId('plan-cond').evaluateAll(c => c.map(x => x.getAttribute('data-kind')))
try {
  for (const w of WIDTHS) {
    const { ctx, page, writes, scanBodies } = await open(PROFILE)
    await page.setViewportSize({ width: w, height: 1100 })
    const box = page.getByLabel('Who do you want to reach?')
    await box.fill(FIX.query)
    await page.getByRole('button', { name: 'Review profile first' }).click()
    const view = page.getByTestId('plan-view')
    await view.waitFor()
    assert.deepEqual(writes, ['POST /api/scan/icp'], 'showing the plan starts nothing')
    // Above the Run button: the plan is read before anything starts.
    const vy = (await view.boundingBox()).y, ry = (await page.getByRole('button', { name: 'Run scan with this profile' }).first().boundingBox()).y
    assert.ok(vy < ry, `the plan sits above Run at ${w}px (${vy} < ${ry})`)
    // The structure the REAL compiler produced for this request (the fixture is proven against the compiler in targeting-plan-view.test.ts).
    assert.deepEqual(await view.getByTestId('plan-group').evaluateAll(g => g.map(x => x.getAttribute('data-op'))), FIX.expect.groups)
    assert.deepEqual(await kindsOf(page), FIX.expect.kinds)
    const text = await view.innerText()
    for (const win of FIX.expect.windows) if (win) assert.match(text, new RegExp(win), 'each condition keeps its own clock')
    assert.match(text, /ALL of these must be shown/); assert.match(text, /ANY ONE of these is enough/); assert.match(text, /NONE of these may apply/)
    assert.match(text, /a completed first hire \(VP of Sales\): a source saying the hire was made, not a vacancy/, 'a completed hire is never worded as a vacancy')
    assert.match(text, /a company on your saved competitor list/)
    const fit = await page.evaluate(() => { const r = document.querySelector('[data-testid="plan-view"]').getBoundingClientRect(); return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, right: r.right, vw: window.innerWidth } })
    assert.ok(fit.sw <= fit.cw + 1, `no horizontal scroll at ${w}px (${fit.sw} > ${fit.cw})`); assert.ok(fit.right <= fit.vw, `the plan stays inside the screen at ${w}px`)
    await shot(page, `plan-${w}`)

    // The plan follows the request in the box: edit it and the plan recompiles on the spot (no stale description of the earlier request).
    await box.fill(FIX.edited_query)
    await page.waitForFunction(() => document.querySelector('[data-testid="plan-view"]')?.getAttribute('data-empty') === 'true')
    assert.equal(await page.getByTestId('plan-cond').count(), 0, 'the old conditions are gone')
    assert.match(await view.innerText(), /no trigger or exclusion it can check/)
    await shot(page, `plan-edited-${w}`)
    await box.fill(FIX.query)
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="plan-cond"]').length === 3)
    // ...and the request Run sends is the one the plan describes.
    await box.fill(FIX.edited_query)
    await page.waitForFunction(() => document.querySelector('[data-testid="plan-view"]')?.getAttribute('data-empty') === 'true')
    await page.getByRole('button', { name: 'Run scan with this profile' }).first().click()
    await page.waitForTimeout(500)
    const est = scanBodies.find(b => b && typeof b.query === 'string')
    assert.ok(est, 'Run asked for its estimate'); assert.equal(est.query, FIX.edited_query, 'the request Run sends is the request the plan on screen describes')
    await ctx.close()
  }
  console.log('plan view UI check passed: the real compiler\'s plan (AND/OR/NOT, per-condition clocks, completed hire) is shown above Run at 1280 and 390 px, starts nothing, recompiles when the request is edited, and Run sends the request the plan describes')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
