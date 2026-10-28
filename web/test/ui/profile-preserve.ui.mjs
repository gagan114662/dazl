// Rendered check: a profile the user REVIEWED is sent exactly as reviewed. Restore it (reload), click Find leads, repeat the search, edit the
// sentence. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/profile-preserve.ui.mjs
// Real production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call answered from a stub in the browser: no scan
// runs, nothing is sent. Proves, on the exact outgoing POST /api/scan body:
//   1. restored reviewed profile + unchanged sentence -> the profile is sent byte-for-byte (deep equal), the sentence unchanged;
//   2. after a reload, and on a repeat search of the finished scan, the same;
//   3. an edited sentence -> NO profile is sent and a visible notice says the reviewed one no longer applies; a profile that was only INFERRED
//      is never presented as reviewed (not sent);
//   4. AND is never turned into OR: the signal text the page sends is the one reviewed.
// The server side (the real runner neither infers nor alters it) is test/profile-preserved.test.ts.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-findleads-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const REVIEWED = { summary: 'Seed-funded London B2B SaaS startups (10-50 employees) that are also hiring sales', who: ['Founder', 'Co-founder', 'CEO'], industries: ['B2B SaaS'], sizes: ['10-50 employees'], where: ['London, UK'],
  signals: ['announced seed funding within the past 90 days AND currently hiring sales staff'], exclude: ['agencies', 'recruiters'], country: 'GB', language: 'en', window_days: 90 }
const SENTENCE = 'Find London UK B2B SaaS startups with 10-50 employees that announced seed funding within the past 90 days AND are currently hiring sales staff.'
const JOB = 'd'.repeat(24)
const b = await chromium.launch()
async function open(source) {
  const posts = []; let started = false
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (m === 'POST' && p === '/api/scan') { posts.push(JSON.parse(req.postData())); started = true; return json({ job_id: JOB }, 202) }
    if (p === '/api/usage') return json({ plan: 'free', scans_used: 1, scan_limit: 10, has_key: true, trial: null })
    if (p === '/api/settings/advanced') return json({ available: true, platforms: [] })
    // The last scan: its sentence and profile, as the server stores them. source 'user' = reviewed; 'inferred' = worked out by dazl.
    if (p === '/api/scan/latest') return json({ query: SENTENCE, icp: REVIEWED, icp_source: source })
    if (p === '/api/scan/jobs') return json({ jobs: started ? [{ id: JOB, status: 'done', error: null, query: SENTENCE, business_name: 'Acme', csv_domain: null, created_at: 1, finished_at: 2, candidates: 0, verified: 0, needs_review: 0, dropped: 0, lead_count: 0, test_only: false }] : [] })
    if (p === '/api/scan/status') return json({ job_id: JOB, status: 'done', lead_count: 0, attempts: 1, max_attempts: 3, claimed_at: 1, created_at: 1, error: null, quality: null, query: SENTENCE, icp: REVIEWED, icp_source: source })
    if (p === '/api/leads') return json({ leads: [], hidden_count: 0 })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/app/leads`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => document.querySelector('main textarea')?.value.length > 0, null, { timeout: 15000 })   // the restored sentence
  return { ctx, page, posts }
}
const find = page => page.getByRole('button', { name: 'Find leads' })
try {
  // 1. restored reviewed profile, unchanged sentence
  const a = await open('user')
  assert.equal(await a.page.locator('main textarea').first().inputValue(), SENTENCE)
  await a.page.getByTestId('profile-reused').waitFor()
  await find(a.page).click(); await a.page.waitForTimeout(800)
  assert.equal(a.posts.length, 1); assert.equal(a.posts[0].query, SENTENCE)
  assert.deepEqual(a.posts[0].icp, REVIEWED, 'the reviewed profile is sent exactly as reviewed')
  assert.equal(a.posts[0].icp.signals.length, 1); assert.match(a.posts[0].icp.signals[0], /within the past 90 days AND currently hiring sales staff/); assert.doesNotMatch(JSON.stringify(a.posts[0].icp), /\bOR\b|Managing Director|Head of Sales/)
  // 2. repeat search of the finished scan: the profile from the scan's own status is sent again
  await a.page.waitForTimeout(1200)
  await a.page.reload({ waitUntil: 'networkidle' })
  await a.page.waitForFunction(() => document.querySelector('main textarea')?.value.length > 0, null, { timeout: 15000 })
  await find(a.page).click(); await a.page.waitForTimeout(800)
  assert.equal(a.posts.length, 2, 'second Find leads after a reload'); assert.deepEqual(a.posts[1].icp, REVIEWED); assert.equal(a.posts[1].query, SENTENCE)
  await find(a.page).waitFor(); if (await find(a.page).isEnabled()) { await find(a.page).click(); await a.page.waitForTimeout(800); assert.equal(a.posts.length, 3, 'repeat search'); assert.deepEqual(a.posts[2].icp, REVIEWED) }
  // 3. edited sentence: the reviewed profile does not apply; nothing stale is sent; the user is told
  const e = await open('user')
  await e.page.locator('main textarea').first().fill(SENTENCE + ' Also in Manchester.')
  await find(e.page).click(); await e.page.waitForTimeout(800)
  assert.equal(e.posts.length, 1); assert.equal('icp' in e.posts[0], false, 'no stale profile sent for a different sentence'); assert.equal(e.posts[0].query, SENTENCE + ' Also in Manchester.')
  assert.match(await e.page.getByTestId('profile-invalidated').textContent(), /changed the request.*no longer applies/)
  // 4. a profile dazl only INFERRED is not presented as reviewed and not re-sent
  const i = await open('inferred')
  assert.equal(await i.page.getByTestId('profile-reused').count(), 0)
  await find(i.page).click(); await i.page.waitForTimeout(800)
  assert.equal(i.posts.length, 1); assert.equal('icp' in i.posts[0], false, 'an inferred profile is not sent as if reviewed')
  console.log('profile-preserve UI check passed: reviewed profile sent exactly (restore, reload, repeat); an edited sentence drops it with a notice; an inferred profile is not passed off as reviewed')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
