// Rendered check for scan outcomes in scan history (Leads "Past scans"), Home ("Your plays") and the campaign page.
// NOT part of `npm test`. Run:  cd web && npm run build && node test/ui/scan-outcomes.ui.mjs   (SHOTS=<dir> saves screenshots;
// BEFORE_ONLY=1 only takes the screenshots, for a build without this change).
// Real production build, throwaway database, server under test/helpers/net-fence.ts, and EVERY /api/* CALL ANSWERED
// FROM A STUB in the browser: no scan runs, nothing is drafted or sent. Off-host requests are aborted. It proves:
//   1. a failed scan, a zero-match scan, an all-dropped scan, a budget stop and an older scan without counts each read
//      as their own outcome in Past scans, from the fields the scan record holds, each with one next-step link;
//   2. the campaign page shows the same outcome and next step for an all-dropped and a zero-match scan;
//   3. Home's plays say "no matches", "stopped" and "N found, all dropped" instead of one "failed";
//   4. nothing is written.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-scanoutcomes-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const J = c => c.repeat(24)
const job = (id, query, o) => ({ id: J(id), query, business_name: '', csv_domain: null, created_at: 1761500000, finished_at: 1761500100, error: null, candidates: null, verified: null, needs_review: null, dropped: null, lead_count: 0, test_only: false, ...o })
const JOBS = [
  job('a', 'Dentists in Ohio opening a second location', { status: 'done', candidates: 9, verified: 4, needs_review: 1, dropped: 2, lead_count: 5 }),
  job('b', 'Roofers in Texas hiring estimators', { status: 'done', candidates: 6, verified: 0, needs_review: 0, dropped: 6 }),
  job('c', 'Breweries in Maine that just raised a round', { status: 'failed', error: 'no_candidates', candidates: 0 }),
  job('d', 'Law firms in Denver moving offices', { status: 'failed', error: 'budget_stopped' }),
  job('e', 'Gyms in Austin switching software', { status: 'failed', error: 'upstream 502' }),
  job('f', 'Cafes in Leeds', { status: 'done' }),
]
const writes = []
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 1100 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method()
  if (u.origin !== base) return route.abort()
  if (!u.pathname.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (m !== 'GET') writes.push(`${m} ${u.pathname}`)
  if (u.pathname === '/api/scan/jobs') return json({ jobs: JOBS })
  const one = JOBS.find(j => u.pathname === `/api/campaigns/${j.id}`)
  if (one) return json({ job: { id: one.id, query: one.query, status: one.status, error: one.error, created_at: one.created_at, candidates: one.candidates, verified: one.verified, needs_review: one.needs_review, dropped: one.dropped }, leads: [], messages: [] })
  return json({}, 404)
})
const page = await ctx.newPage()
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
const before = process.env.BEFORE_ONLY === '1'
try {
  await page.goto(`${base}/app/leads`, { waitUntil: 'networkidle' })
  await page.getByText('Past scans').waitFor({ timeout: 15000 })
  await page.getByText('Past scans').scrollIntoViewIfNeeded()
  await shot('history')
  if (!before) {
    const rows = await page.getByTestId('past-scan').evaluateAll(els => els.map(e => [e.dataset.outcome, e.querySelector('[data-testid=next-step]')?.textContent ?? null, e.querySelector('[data-testid=next-step]')?.getAttribute('href') ?? null]))
    assert.deepEqual(rows, [
      ['leads', null, null],
      ['all_dropped', 'See why they were dropped', `/app/leads?job_id=${J('b')}`],
      ['zero_match', 'Rephrase or broaden the search', '/app/leads'],
      ['stopped', 'Run it again with a larger budget', '/app/leads'],
      ['failed', 'Try again', '/app/leads'],
      ['unrecorded', 'Run the search again', '/app/leads'],
    ])
    const text = await page.getByTestId('past-scan').allTextContents()
    assert.match(text[1], /6 found, all dropped by the checks/)
    assert.match(text[2], /No matches - the search found no companies to check/)
    assert.match(text[3], /Stopped by its budget - not an empty search/)
    assert.match(text[5], /did not record whether nothing matched or everything was dropped/)
  }
  for (const [id, name, kind, next] of [['b', 'campaign-all-dropped', 'all_dropped', 'See why they were dropped'], ['c', 'campaign-zero-match', 'zero_match', 'Rephrase or broaden the search']]) {
    await page.goto(`${base}/app/campaigns/${J(id)}`, { waitUntil: 'networkidle' })
    await page.getByTestId('campaign-status').waitFor({ timeout: 15000 })
    await shot(name)
    if (!before) {
      assert.equal(await page.getByTestId('campaign-status').getAttribute('data-outcome'), kind)
      assert.equal(await page.getByTestId('campaign-status').getByTestId('next-step').textContent(), next)
    }
  }
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  await page.getByTestId('play-campaign-link').first().waitFor({ timeout: 15000 })
  await page.getByTestId('play-campaign-link').first().scrollIntoViewIfNeeded()
  await shot('home-plays')
  if (!before) {
    for (const t of ['no matches', 'stopped', '6 found, all dropped by the checks', 'failed']) await page.locator('main').getByRole('link', { name: t, exact: true }).first().waitFor({ timeout: 5000 })
  }
  assert.deepEqual(writes, [], 'loading writes nothing')
  console.log(before ? 'screenshots taken (BEFORE_ONLY)' : 'scan outcomes UI check passed: failed, zero-match, all-dropped, stopped and unrecorded scans are distinct in Past scans, on the campaign page and on Home, each with one next step; no writes')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
