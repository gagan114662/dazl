// Rendered check for the compiled targeting plan on the Leads review step (#876 / #752). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/plan-view.ui.mjs   (SHOTS=<dir> also saves screenshots at 1280 and 390 px)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, every /api/* call answered from a browser stub. It proves the plan
// (AND / OR / NOT, a completed hire worded as one, per-condition clocks, ambiguity with the reading used) is shown above Run, starts nothing, and fits at both widths.
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

// The plan the real /api/scan/icp route returns for these requests (planView of compileTargeting; covered against the real compiler in test/targeting-plan-view.test.ts).
const cond = (id, text, means, window, kind) => ({ op: 'cond', id, text, means, window, kind })
const PLAN = {
  explicit: true, empty: false, summary: '(C1 AND (C2 OR NOT C3))',
  root: { op: 'and', of: [
    cond('C1', 'made their first sales hire within 30 days', 'a completed first hire (sales): a source saying the hire was made, not a vacancy', 'within 30 days', 'hire_made'),
    { op: 'or', of: [
      cond('C2', 'raised seed funding within 90 days', 'a completed seed funding round', 'within 90 days', 'funding'),
      { op: 'not', of: cond('C3', 'excluding competitors', 'a company on your saved competitor list', null, 'competitor') },
    ] },
  ] },
  filters: [{ kind: 'where', values: ['London, UK'], semantics: 'the company is in this place' }],
  ambiguities: [{ text: 'seed or hiring and a founder', readings: ['(seed or hiring) and a founder', 'seed or (hiring and a founder)'], chosen: '(seed or hiring) and a founder' }],
}
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
    if (p === '/api/scan/icp' && m === 'POST') return json({ icp: ICP, inferred: true, plan: PLAN })
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
try {
  for (const w of WIDTHS) {
    const { ctx, page, writes } = await open(PROFILE)
    await page.setViewportSize({ width: w, height: 1100 })
    await page.getByTestId('play-suggestion').nth(1).click()
    await page.getByRole('button', { name: 'Review profile first' }).click()
    const view = page.getByTestId('plan-view')
    await view.waitFor()
    assert.deepEqual(writes, ['POST /api/scan/icp'], 'showing the plan starts nothing')
    // Above the Run button: the plan is read before anything starts.
    const vy = (await view.boundingBox()).y, ry = (await page.getByRole('button', { name: 'Run scan with this profile' }).first().boundingBox()).y
    assert.ok(vy < ry, `the plan sits above Run at ${w}px (${vy} < ${ry})`)
    assert.deepEqual(await view.getByTestId('plan-group').evaluateAll(g => g.map(x => x.getAttribute('data-op'))), ['and', 'or', 'not'])
    assert.deepEqual(await view.getByTestId('plan-cond').evaluateAll(c => c.map(x => x.getAttribute('data-kind'))), ['hire_made', 'funding', 'competitor'])
    const text = await view.innerText()
    assert.match(text, /ALL of these must be shown/); assert.match(text, /ANY ONE of these is enough/); assert.match(text, /NONE of these may apply/)
    assert.match(text, /a completed first hire \(sales\): a source saying the hire was made, not a vacancy/, 'a completed hire is never worded as a vacancy')
    assert.match(text, /within 30 days/); assert.match(text, /within 90 days/, 'each condition keeps its own clock')
    assert.match(text, /Your words: .made their first sales hire within 30 days./)
    assert.match(text, /Not clear in your request/); assert.match(text, /could mean \(seed or hiring\) and a founder or seed or \(hiring and a founder\)/); assert.match(text, /Used: \(seed or hiring\) and a founder/)
    assert.match(text, /London, UK/)
    // Nothing is clipped or pushed off screen, and no one word per line.
    const fit = await page.evaluate(() => { const v = document.querySelector('[data-testid="plan-view"]'); const r = v.getBoundingClientRect(); return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, right: r.right, vw: window.innerWidth, h: r.height } })
    assert.ok(fit.sw <= fit.cw + 1, `no horizontal scroll at ${w}px (${fit.sw} > ${fit.cw})`); assert.ok(fit.right <= fit.vw, `the plan stays inside the screen at ${w}px`)
    await shot(page, `plan-${w}`)
    await ctx.close()
  }
  // An empty plan says so and adds nothing.
  const e = await open(PROFILE)
  await e.ctx.route('**/api/scan/icp', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ icp: ICP, inferred: true, plan: { explicit: false, empty: true, summary: '(no targeting conditions)', root: null, filters: [], ambiguities: [] } }) }))
  await e.page.getByTestId('play-suggestion').nth(1).click(); await e.page.getByRole('button', { name: 'Review profile first' }).click()
  await e.page.getByTestId('plan-view').waitFor()
  assert.match(await e.page.getByTestId('plan-view').innerText(), /no trigger or exclusion it can check/); assert.equal(await e.page.getByTestId('plan-cond').count(), 0)
  await e.ctx.close()
  console.log('plan view UI check passed: the compiled plan (AND/OR/NOT, per-condition clocks, ambiguity) is shown above Run at 1280 and 390 px, starts nothing, and an empty plan says so')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
