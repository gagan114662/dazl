// Plays vs Leads (#351): Plays lists the saved, repeating searches; Leads is searching and every run's results.
// NOT part of `npm test`. Run:  cd web && npm run build && node test/ui/plays.ui.mjs   (SHOTS=<dir> saves desktop and
// 390px screenshots). Production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call
// stubbed in the browser with synthetic rows: no scan, no send. It proves:
//   1. the sidebar's Plays opens /app/plays (not the latest results) and is the current page there; Leads opens results;
//   2. each saved play (weekly watch or scheduled monitor) shows its audience, signal, schedule, last and next run,
//      status, and links to its last run's leads in Leads;
//   3. Pause / Resume / Delete send only the existing route actions, and Delete asks first (cancel sends nothing);
//   4. no saved plays: an empty state that says how to make one; a list that did not load is never shown as "none";
//   5. the bare Leads page is headed "Find leads" (not "Plays") and links back to Plays from its weekly watches;
//   6. no horizontal scroll at 390px.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-plays-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

// Synthetic plays: two weekly watches (one live, one paused for quota) and one daily monitor. Dates at noon UTC.
const T = Date.UTC(2026, 9, 26, 12) / 1000, W = 'a'.repeat(24), W2 = 'e'.repeat(24), M = 'c'.repeat(24), RUN = 'b'.repeat(24)
const WATCHES = [
  { id: W, query: 'Dental practices in Leeds opening a second location', icp: { summary: 'Independent dental practices', who: ['Practice owner'], where: ['Leeds, UK'], signals: ['opening a second location'] }, active: true, next_run_at: T + 7 * 86400, last_run_at: T, paused_reason: null, last_job_id: RUN, last_status: 'done', new_leads: 3 },
  { id: W2, query: 'Physio clinics in Manchester hiring', icp: { summary: 'Physiotherapy clinics', where: ['Manchester, UK'], signals: ['hiring'] }, active: false, next_run_at: T, last_run_at: T - 7 * 86400, paused_reason: 'quota', last_job_id: null, last_status: null, new_leads: 0 },
]
const MONITORS = [{ id: M, query: 'Accounting firms in Bristol hiring payroll staff', icp: JSON.stringify({ summary: 'Accounting firms', where: ['Bristol, UK'], signals: ['hiring payroll staff'] }), interval_hours: 24, enabled: 1, paused_reason: null, last_run_at: null, next_run_at: T + 86400, last_new_count: null, run_count: 0, last_job_id: null }]

const b = await chromium.launch()
async function open({ width, height, watches = WATCHES, monitors = MONITORS, fail = null }) {
  const ctx = await b.newContext({ viewport: { width, height }, timezoneId: 'UTC' })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const writes = []
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (m !== 'GET') { writes.push([m, p, req.postData() ? JSON.parse(req.postData()) : null]); return json({ ok: true }) }
    if (p === '/api/watch') return fail === 'watch' ? json({ error: 'x' }, 500) : json({ watches })
    if (p === '/api/monitors') return fail === 'monitors' ? json({ error: 'x' }, 500) : json({ monitors })
    if (p === '/api/scan/jobs') return json({ jobs: [] })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  return { ctx, page, writes }
}
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
const noScroll = async (page, w) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll at ${w}px`)

try {
  for (const [width, height, tag] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
    const { ctx, page, writes } = await open({ width, height })
    // 1. From a lead run, the sidebar's Plays opens the plays page (desktop: the sidebar; phone: the same link in the menu).
    await page.goto(`${base}/app/leads?job_id=${RUN}`, { waitUntil: 'domcontentloaded' })
    const nav = page.locator('nav[aria-label=Main]').getByRole('link', { name: 'Plays', includeHidden: true })
    await nav.waitFor({ state: 'attached', timeout: 15000 })
    assert.equal(await nav.getAttribute('href'), '/app/plays')
    assert.equal(await page.locator('nav[aria-label=Main]').getByRole('link', { name: 'Leads', includeHidden: true }).getAttribute('href'), '/app/leads?latest=1', 'Leads opens results')
    await page.goto(`${base}/app/plays`, { waitUntil: 'networkidle' })
    assert.equal(await page.locator('h1').last().textContent(), 'Plays')
    if (width > 800) assert.equal(await page.locator('aside').getByRole('link', { name: 'Plays' }).getAttribute('aria-current'), 'page')
    const cards = page.getByTestId('saved-play')
    await cards.first().waitFor({ timeout: 10000 })
    assert.equal(await cards.count(), 3)
    // 2. Audience, signal, schedule, last and next run, status.
    const row = async i => Object.fromEntries(await Promise.all(['audience', 'signal', 'schedule', 'last-run', 'next-run', 'status', 'sentence'].map(async k => [k, (await cards.nth(i).getByTestId(`play-${k}`).innerText()).replace(/\n+/g, ': ')])))
    assert.deepEqual(await row(0), { audience: 'AUDIENCE: Independent dental practices · Leeds, UK', signal: 'SIGNAL: opening a second location', schedule: 'SCHEDULE: Weekly', 'last-run': 'LAST RUN: 26 Oct 2026, 3 new', 'next-run': 'NEXT RUN: 2 Nov 2026', status: 'Live', sentence: 'Dental practices in Leeds opening a second location' })
    assert.deepEqual(await row(1), { audience: 'AUDIENCE: Physiotherapy clinics · Manchester, UK', signal: 'SIGNAL: hiring', schedule: 'SCHEDULE: Weekly', 'last-run': 'LAST RUN: 19 Oct 2026', 'next-run': 'NEXT RUN: Paused: resume to schedule it', status: "Paused: this month's scans are used up", sentence: 'Physio clinics in Manchester hiring' })
    assert.deepEqual(await row(2), { audience: 'AUDIENCE: Accounting firms · Bristol, UK', signal: 'SIGNAL: hiring payroll staff', schedule: 'SCHEDULE: Daily', 'last-run': 'LAST RUN: Not run yet', 'next-run': 'NEXT RUN: 27 Oct 2026', status: 'Live', sentence: 'Accounting firms in Bristol hiring payroll staff' })
    assert.equal(await cards.nth(0).getByTestId('play-results').getAttribute('href'), `/app/leads?job_id=${RUN}`, "results are in Leads")
    assert.equal(await cards.nth(1).getByTestId('play-results').count(), 0, 'no run to link: no link')
    assert.deepEqual(await cards.evaluateAll(cs => cs.map(c => c.querySelector('[data-testid=play-toggle]').textContent)), ['Pause', 'Resume', 'Pause'])
    assert.equal(await page.getByTestId('new-play').getAttribute('href'), '/app/leads')
    await noScroll(page, width)
    for (const c of await cards.all()) assert.ok((await c.getByTestId('play-name').boundingBox()).width >= Math.min(240, width - 100), `the play name keeps its width at ${width}px (a long status wraps below)`)
    await shot(page, `plays-${tag}`)
    // 3. Only the existing actions; Delete asks first.
    if (tag === 'desktop') {
      await cards.nth(0).getByTestId('play-toggle').click()
      await cards.nth(1).getByTestId('play-toggle').click()
      await cards.nth(2).getByTestId('play-toggle').click()
      page.once('dialog', d => d.dismiss()); await cards.nth(0).getByTestId('play-delete').click()
      page.once('dialog', d => d.accept()); await cards.nth(2).getByTestId('play-delete').click()
      await page.waitForTimeout(500)
      assert.deepEqual(writes, [
        ['POST', '/api/watch', { action: 'pause', id: W }], ['POST', '/api/watch', { action: 'resume', id: W2 }],
        ['PATCH', `/api/monitors/${M}`, { enabled: false }], ['DELETE', `/api/monitors/${M}`, null],
      ], 'pause/resume/delete only, through the existing routes; a cancelled delete sends nothing')
      // 5. The bare Leads page is "Find leads" and links back to Plays from its weekly watches.
      await page.goto(`${base}/app/leads`, { waitUntil: 'networkidle' })
      assert.equal(await page.locator('h1').last().textContent(), 'Find leads')
      assert.equal(await page.getByTestId('manage-plays').getAttribute('href'), '/app/plays')
      assert.equal(await page.locator('aside').getByRole('link', { name: 'Leads' }).getAttribute('aria-current'), 'page')
    }
    await ctx.close()
  }
  // 4. Empty, and a list that did not load.
  for (const [width, height, tag] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
    const { ctx, page, writes } = await open({ width, height, watches: [], monitors: [] })
    await page.goto(`${base}/app/plays`, { waitUntil: 'networkidle' })
    await page.getByTestId('plays-empty').waitFor({ timeout: 10000 })
    assert.match(await page.getByTestId('plays-empty').innerText(), /No saved plays yet[\s\S]*Watch this weekly/)
    await noScroll(page, width); await shot(page, `plays-empty-${tag}`)
    assert.deepEqual(writes, [])
    await ctx.close()
  }
  const { ctx, page } = await open({ width: 1440, height: 900, fail: 'watch' })
  await page.goto(`${base}/app/plays`, { waitUntil: 'networkidle' })
  await page.getByTestId('plays-unavailable').waitFor({ timeout: 10000 })
  assert.equal(await page.getByTestId('plays-unavailable').textContent(), 'Could not load your weekly plays. Refresh to retry.')
  assert.equal(await page.getByTestId('plays-empty').count(), 0, 'an unread list is never "no plays"')
  assert.equal(await page.getByTestId('saved-play').count(), 1, 'what did load is still shown')
  await ctx.close()
  console.log('plays UI check passed: sidebar Plays -> saved plays (audience, signal, schedule, last/next run, status, results link), Leads -> results, pause/resume/delete via existing routes with a confirm, empty + unreadable states, no overflow at 390px')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
