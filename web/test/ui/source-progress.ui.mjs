// Rendered check: live per-source progress on a running scan (the status route's `progress`, lib/scan/progress.ts). NOT
// part of `npm test`.  Run:  cd web && npm run build && node test/ui/source-progress.ui.mjs   (SHOTS=<dir> saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call answered from a stub
// in the browser: no scan runs, nothing is sent. It proves:
//   1. each source that has started gets a row with its state; one that has not started is not listed (nothing invented);
//   2. rows update from the next status poll without a reload (running -> done with counts, a new source appears, a failure
//      is named), counts are shown as recorded and an unknown count is "-", never 0;
//   3. no source rows yet says so; loading and watching the scan writes nothing.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-srcprogress-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const b = await chromium.launch()
const JOB = 'c'.repeat(24)
const T0 = Math.floor(Date.now() / 1000) - 180   // started three minutes ago
const STEP = [
  [],
  [{ source: 'search:tinyfish', state: 'running', status: 'running', note: null, candidates: null, accepted: null, review: null, rejected: null }],
  [{ source: 'search:tinyfish', state: 'done', status: 'ok', note: null, candidates: 6, accepted: 3, review: 1, rejected: 2 },
   { source: 'search:news', state: 'running', status: 'running', note: null, candidates: null, accepted: null, review: null, rejected: null },
   { source: 'adapter:jobboards', state: 'done', status: 'skipped', note: null, candidates: null, accepted: null, review: null, rejected: null },
   { source: 'adapter:github', state: 'failed', status: 'failed', note: null, candidates: null, accepted: null, review: null, rejected: null },
   { source: 'search:anthropic', state: 'done', status: 'ok', note: null, candidates: 2, accepted: null, review: null, rejected: null }],
]
let step = 0
const writes = []
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
  if (u.origin !== base) return route.abort()
  if (!p.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (m !== 'GET') { writes.push(`${m} ${p}`); return json({ error: 'not stubbed' }, 400) }
  if (p === '/api/usage') return json({ plan: 'free', scans_used: 1, scan_limit: 10, has_key: true, trial: null })
  if (p === '/api/settings/advanced') return json({ available: true, platforms: [] })
  if (p === '/api/scan/sources') return json({ web_index: true, news: true, websites: true })
  if (p === '/api/scan/jobs') return json({ jobs: [{ id: JOB, status: 'running', error: null, query: 'Dental practices in Ohio', business_name: 'Acme', csv_domain: null, created_at: 1, finished_at: null, candidates: null, verified: null, needs_review: null, dropped: null, lead_count: 0, test_only: false }] })
  if (p === '/api/scan/status') return json({ job_id: JOB, status: 'running', progress: STEP[step], lead_count: step === 2 ? 3 : 0, attempts: 1, max_attempts: 3, claimed_at: T0, created_at: T0, error: null, quality: null })
  if (p === '/api/leads') return json({ leads: [], hidden_count: 0 })
  return json({}, 404)
})
const page = await ctx.newPage()
let docs = 0; page.on('request', r => { if (r.resourceType() === 'document') docs++ })
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) }
const rows = () => page.getByTestId('source-row').evaluateAll(els => els.map(e => [e.querySelector('.font-medium').textContent, e.querySelector('[data-testid=source-state]').textContent, e.querySelector('[data-testid=source-counts]')?.textContent ?? null]))
try {
  await page.goto(`${base}/app/leads?job_id=${JOB}`, { waitUntil: 'networkidle' })
  if (process.env.BEFORE_ONLY) { await page.getByText('Scanning - this can take a few minutes.').waitFor({ timeout: 15000 }); await page.waitForTimeout(500); await shot('before'); console.log('before shot'); process.exit(0) }
  await page.getByTestId('source-progress-empty').waitFor({ timeout: 15000 })
  assert.equal(await page.getByTestId('source-progress-empty').textContent(), 'No source has reported yet.')
  step = 1
  await page.getByTestId('source-row').first().waitFor({ timeout: 15000 })
  assert.deepEqual(await rows(), [['Web search', 'Searching...', null]], 'only a started source is listed')
  await shot('after-running')
  step = 2
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=source-row]').length === 5, null, { timeout: 15000 })
  assert.deepEqual(await rows(), [
    ['Web search', 'Done', '6 found · 3 checked · 1 to review · 2 rejected'],
    ['News articles', 'Searching...', null],
    ['Job postings', 'Not used for this search', null],
    ['GitHub', 'Failed', null],
    ['Web research with your AI key', 'Done', '2 found · - checked · - to review · - rejected'],
  ])
  assert.equal(docs, 1, 'updated from the status poll, no reload')
  assert.equal(await page.getByText('dazl cannot show a per-source count yet').count(), 0)
  assert.deepEqual(writes, [], 'watching a scan writes nothing')
  await shot('after')
  console.log('source progress UI check passed: started sources listed live with state and recorded counts, unknown never 0, updates without reload, no writes')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
