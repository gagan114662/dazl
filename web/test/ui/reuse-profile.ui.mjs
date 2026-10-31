// Rendered check: repeating a search keeps the profile the user reviewed. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/reuse-profile.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed in the
// browser (no model call, no scan runs). Live finding: Find leads on an unchanged sentence sent no profile, so the server
// worked out a new one and the reviewed profile was silently discarded. It proves:
//   1. last search restored with a profile reviewed by the user: the page says Find leads uses it, and the one
//      POST /api/scan carries exactly that profile;
//   2. a changed sentence: no reuse note, and the scan request carries no profile (a fresh one is worked out);
//   3. a profile dazl only inferred is never reused as if reviewed;
//   4. viewing a finished scan whose profile was reviewed: Find leads on its sentence reuses that profile.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-reuse-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const Q = 'Dental practice owners in Ohio - opened a new location'
const REVIEWED = { summary: 'Owner-run dental practices with 2-10 chairs', who: ['Practice owner'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['opened a new location'], exclude: ['Dental schools'], window_days: 90 }
const JOB = 'd'.repeat(24)
const b = await chromium.launch()
async function open({ latest, viewJob }) {
  const scanBodies = []
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/api/settings/profile') return json({ business_name: '', sells: '', website: '', buyer: null })
    if (p === '/api/usage') return json({ plan: 'free', scans_used: 1, scan_limit: 10, has_key: true, trial: null })
    if (p === '/api/settings/advanced') return json({ available: false, platforms: [] })
    if (p === '/api/scan/sources') return json({ web_index: true, news: true, websites: true })
    if (p === '/api/scan/jobs') return json({ jobs: [] })
    if (p === '/api/scan/latest') return json(latest)
    if (p === '/api/leads') return json({ job_id: JOB, status: 'done', hidden_count: 0, leads: [] })
    if (p === '/api/scan' && m === 'POST') { scanBodies.push(JSON.parse(req.postData())); return json({ job_id: 'e'.repeat(24) }, 202) }
    if (p === '/api/scan/status') return u.searchParams.get('job_id') === JOB
      ? json({ job_id: JOB, status: 'done', lead_count: 0, attempts: 1, max_attempts: 3, query: Q, icp: REVIEWED, icp_source: 'user' })
      : json({ status: 'pending', lead_count: 0, attempts: 0, max_attempts: 3 })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/app/leads${viewJob ? `?job_id=${JOB}&passive=1` : ''}`, { waitUntil: 'networkidle' })
  return { ctx, page, scanBodies }
}
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) }
try {
  // 1. Restored last search, profile reviewed by the user.
  const a = await open({ latest: { query: Q, icp: REVIEWED, icp_source: 'user' } })
  const box = a.page.getByLabel('Who do you want to reach?')
  await a.page.getByTestId('reuse-profile').waitFor({ timeout: 15000 })
  assert.equal(await box.inputValue(), Q)
  assert.match(await a.page.getByTestId('reuse-profile').textContent(), /^Find leads reuses this stored profile \(approval is not recorded here\): Owner-run dental practices with 2-10 chairs\./)
  await shot(a.page, 'reuse')
  await a.page.getByRole('button', { name: 'Find leads' }).click()
  await a.page.getByText('Queued - waiting to start.').waitFor()
  assert.equal(a.scanBodies.length, 1)
  assert.deepEqual(a.scanBodies[0].icp, REVIEWED, 'the reviewed profile is sent unchanged')
  assert.equal(a.scanBodies[0].query, Q)
  await a.ctx.close()
  // 2. Changed sentence: a new profile is worked out.
  const c = await open({ latest: { query: Q, icp: REVIEWED, icp_source: 'user' } })
  await c.page.getByTestId('reuse-profile').waitFor({ timeout: 15000 })
  await c.page.getByLabel('Who do you want to reach?').fill('Restaurant owners in Austin - started taking online orders')
  assert.equal(await c.page.getByTestId('reuse-profile').count(), 0)
  await c.page.getByRole('button', { name: 'Find leads' }).click()
  await c.page.getByText('Queued - waiting to start.').waitFor()
  assert.equal(c.scanBodies[0].icp, undefined, 'changed sentence: no stale profile sent')
  await c.ctx.close()
  // 3. Only inferred by dazl: never reused as if reviewed.
  const d = await open({ latest: { query: Q, icp: REVIEWED, icp_source: 'inferred' } })
  await d.page.getByText('Profile used:').waitFor({ timeout: 15000 })
  assert.equal(await d.page.getByTestId('reuse-profile').count(), 0)
  await d.page.getByRole('button', { name: 'Find leads' }).click()
  await d.page.getByText('Queued - waiting to start.').waitFor()
  assert.equal(d.scanBodies[0].icp, undefined)
  await d.ctx.close()
  // 4. Viewing a finished scan with a reviewed profile: repeating its sentence reuses it.
  const v = await open({ latest: {}, viewJob: true })
  await v.page.getByTestId('reuse-profile').waitFor({ timeout: 15000 })
  await v.page.getByRole('button', { name: 'Find leads' }).click()
  await v.page.getByText('Queued - waiting to start.').waitFor()
  assert.deepEqual(v.scanBodies[0].icp, REVIEWED)
  assert.equal(v.scanBodies[0].query, Q)
  await v.ctx.close()
  console.log('reuse profile UI check passed: unchanged sentence reuses the reviewed profile (restored or viewed), changed sentence or inferred profile does not')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
