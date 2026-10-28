// Rendered check for the "Needs your review" card actions on Leads. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/review-actions.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed in the
// browser: nothing is confirmed, drafted or sent for real. Off-host requests are aborted. It proves:
//   1. each review card has two labelled actions - Open source (its own source link) and a confirm button - and a hint
//      saying exactly what confirming unlocks for that lead;
//   2. a quote problem: "I checked the source - use it" (confirmed by you, never source-checked, can be drafted);
//      a date problem: "I checked the date - use it" (dazl has not verified the date); held by the time window:
//      "Keep as research" - an older dated lead says only a NEW wider-window scan (usual budget) can find it as current,
//      and an undated or future-dated lead says no window changes it (widening is never offered as its cure);
//   3. confirming sends only the existing POST /api/leads/<id>/confirm.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-review-actions-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const JOB = 'b'.repeat(24)
const ICP = { summary: 'Growing dental practices', who: ['Practice owner'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['new location'], exclude: [], window_days: 90 }
const lead = (id, company, over = {}) => ({ id, name: '', company, contact: null, signal: `${company} opened a second office`, source_url: `https://www.news.example/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} opened a second office`, event_date: '2026-10-01', date_status: 'unverified', confidence: 80, review_reason: null, company_domain: null, human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 3, action: 3, why: `${company} is a two-location practice that matches your dental owner profile. More detail follows.`, signals: null, icp_match: null, enrichments: [], events: [], ...over })
const LEADS = [
  lead('1'.repeat(24), 'Quote Dental', { review_reason: 'quote_unconfirmed', source_url: 'https://news.example/quote' }),
  lead('2'.repeat(24), 'Stale Dental', { review_reason: 'event_date_stale', event_date: '2026-09-15', source_url: 'https://news.example/stale' }),
  lead('3'.repeat(24), 'Window Dental', { review_reason: 'outside_window', window_held: true, event_date: '2025-01-01', source_url: 'https://news.example/window' }),
  // The real undated research case (Instinct #271): no event date at all.
  lead('4'.repeat(24), 'Undated Juicebox', { review_reason: 'outside_window_undated', window_held: true, event_date: null, source_url: 'https://news.example/undated' }),
  lead('5'.repeat(24), 'Future Dental', { review_reason: 'event_date_future_date', window_held: true, event_date: '2027-03-01', source_url: 'https://news.example/future' }),
]
const writes = []
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 1200 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method()
  if (u.origin !== base) return route.abort()
  if (!u.pathname.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (m !== 'GET') writes.push(`${m} ${u.pathname}`)
  if (u.pathname === '/api/scan/status') return json({ status: 'done', lead_count: 0, icp: ICP, icp_source: 'user', attempts: 1, max_attempts: 3, query: 'Dental practice owners in Ohio' })
  if (u.pathname === '/api/leads') return json({ job_id: JOB, status: 'done', hidden_count: 0, leads: LEADS })
  if (u.pathname === '/api/scan/jobs') return json({ jobs: [] })
  if (/^\/api\/leads\/[a-f0-9]{24}\/confirm$/.test(u.pathname)) return json({ confirmed: true })
  return json({}, 404)
})
const page = await ctx.newPage()
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
try {
  await page.goto(`${base}/app/leads?job_id=${JOB}&passive=1`, { waitUntil: 'networkidle' })
  if (process.env.BEFORE_ONLY) { await page.getByText('Needs your review').waitFor({ timeout: 15000 }); await page.getByText('Needs your review').scrollIntoViewIfNeeded(); await shot('review'); console.log('before shot'); process.exit(0) }
  const actions = page.getByTestId('review-actions'); await actions.first().waitFor({ timeout: 15000 })
  assert.equal(await actions.count(), 5)
  const rows = await actions.evaluateAll(els => els.map(e => [[...e.querySelectorAll('a,button')].map(x => x.textContent), e.querySelector('a').getAttribute('href'), e.querySelector('[data-testid=review-hint]').textContent]))
  assert.deepEqual(rows.map(r => r[0]), [['Open source', 'I checked the source - use it'], ['Open source', 'I checked the date - use it'], ['Open source', 'Keep as research'], ['Open source', 'Keep as research'], ['Open source', 'Keep as research']])
  assert.deepEqual(rows.map(r => r[1]), ['https://news.example/quote', 'https://news.example/stale', 'https://news.example/window', 'https://news.example/undated', 'https://news.example/future'])
  assert.match(rows[0][2], /never shown as source-checked/)
  assert.match(rows[1][2], /dazl has not verified the date or current need/)
  assert.match(rows[2][2], /older than the time window you asked for.*only a new scan with a wider window can find it as current \(it uses your usual scan budget\)/)
  for (const i of [3, 4]) {
    assert.match(rows[i][2], /no valid event date \(missing, invalid or in the future\), so it stays out of drafting\. A wider time window does not change that\./)
    assert.doesNotMatch(rows[i][2], /Widen the window|new scan/, 'widening is never offered as a cure for an undated or future-dated lead')
  }
  assert.ok(rows.every(r => !/Widen the window to draft it/.test(r[2])), 'the old false promise is gone everywhere')
  await page.getByText('Needs your review').scrollIntoViewIfNeeded()
  await shot('review')
  await actions.nth(1).getByRole('button', { name: 'I checked the date - use it' }).click()
  await page.waitForTimeout(500)
  assert.deepEqual(writes, [`POST /api/leads/${'2'.repeat(24)}/confirm`], 'only the existing confirm request')
  console.log('review actions UI check passed: labelled Open source + confirm per reason, exact unlock hints, only the confirm write')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
