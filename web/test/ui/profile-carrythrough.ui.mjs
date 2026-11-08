// Rendered check: the reviewed business profile carries through the FIRST scan, and reopening the brain editor keeps
// its research decisions. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/profile-carrythrough.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed in the
// browser (no model call, no scan runs). Live finding (staging, 2026-11-07): the saved business profile was reviewed
// and saved, but the first Find leads sent NO profile (the server worked out a new one, discarding the review), and
// reopening Home > Build dropped every saved Dismiss because the editor only hydrated the flat fields. It proves:
//   1. first scan, saved reviewed buyer with rejections: the page says Find leads uses the saved business profile,
//      and the one POST /api/scan carries exactly that profile, with its research decisions;
//   2. a changed sentence on that first scan still carries the saved business profile (decisions never silently
//      discarded); the note stays visible so the person can see what runs;
//   3. no saved buyer: no note, and the scan request carries no profile (the server works one out);
//   4. Home > Build (?setup=brain) reopen + save: the POST /api/settings/profile keeps the research block and its
//      rejections whole (fail-before: the save dropped research entirely).
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-carry-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const Q = 'Companies that need evidence-backed outbound leads'
// The reviewed business buyer: two sourced statements, one dismissed (reject decision), one answer in the person's words.
const RESEARCH = {
  v: 1, site: 'dazl.ai', q: 'Who buys this?', ans: { q: 'Who buys this?', o: 'o1', t: 'B2B sales teams' },
  offers: [{ i: 'o1', n: 'Dazl lead finding' }],
  hyps: [
    { i: 'h1', o: 'o1', k: 'persona', t: 'Founders', s: 'sourced', u: 'https://dazl.ai/', q: 'for founders and sales teams', at: null },
    { i: 'h2', o: 'o1', k: 'persona', t: 'Head of Real Estate', s: 'rejected', u: 'https://dazl.ai/', q: 'illustrative example', at: null },
  ],
  decisions: [{ offer: 'o1', hypothesis: 'h2', action: 'reject' }],
}
const BUYER = { summary: 'Businesses that need evidence-backed outbound leads', who: ['Founders', 'B2B sales teams'], industries: [], sizes: [], where: [], signals: ['seeking a lead-finding tool'], exclude: [], research: RESEARCH }
const ESTIMATE = { estimate: { rows: [], total: { min: 0, max: 0 }, unpriced: [], assumptions: ['Synthetic fenced estimate'], payer: 'you', cap: { max_usd: null, reserved_usd: 0, remaining_usd: null, binding: null, capped_total: { min: 0, max: 0 }, month_cap_usd: null, month_reserved_usd: 0, unknown: false }, verdict: { ok: true, reason: null, message: 'Synthetic estimate only', change: [], warning: null }, ack: 'synthetic-fenced-ack' } }

const b = await chromium.launch()
async function open({ buyer, latest = { query: null, icp: null, icp_source: null }, page: pagePath = '/app/leads' }) {
  const scanBodies = [], saves = []
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/api/settings/profile' && m === 'POST') { saves.push(JSON.parse(req.postData())); return json({ ok: true, buyer }) }
    if (p === '/api/settings/profile') return json({ business_name: 'dazl', sells: 'Finds B2B sales leads', website: 'https://dazl.ai', buyer, new_play_offer: null })
    if (p === '/api/usage') return json({ plan: 'free', scans_used: 0, scan_limit: 10, has_key: true, trial: null })
    if (p === '/api/settings/advanced') return json({ available: false, platforms: [] })
    if (p === '/api/scan/sources') return json({ web_index: true, news: true, websites: true })
    if (p === '/api/scan/jobs') return json({ jobs: [], totals: { finished: 0, searches: 0 } })
    if (p === '/api/scan/latest') return json(latest)
    if (p === '/api/scan/estimate' && m === 'POST') return json(ESTIMATE)
    if (p === '/api/scan' && m === 'POST') { scanBodies.push(JSON.parse(req.postData())); return json({ job_id: 'e'.repeat(24) }, 202) }
    if (p === '/api/scan/status') return json({ status: 'pending', lead_count: 0, attempts: 0, max_attempts: 3 })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}${pagePath}`, { waitUntil: 'networkidle' })
  return { ctx, page, scanBodies, saves }
}
try {
  // 1. First scan: the saved reviewed buyer carries through, decisions and all.
  const a = await open({ buyer: BUYER })
  await a.page.getByTestId('business-profile').waitFor({ timeout: 15000 })
  assert.match(await a.page.getByTestId('business-profile').textContent(), /^Find leads uses your saved business profile, with the review decisions you made on it: Businesses that need evidence-backed outbound leads\./)
  await a.page.getByLabel('Who do you want to reach?').fill(Q)
  await a.page.getByRole('button', { name: 'Find leads' }).click()
  assert.equal(a.scanBodies.length, 0, 'no scan before estimate confirmation')
  await a.page.getByTestId('estimate-confirm-run').click()
  await a.page.getByText('Queued - waiting to start.').waitFor()
  assert.equal(a.scanBodies.length, 1)
  assert.deepEqual(a.scanBodies[0].icp, BUYER, 'the saved reviewed profile is sent whole, research block included')
  assert.deepEqual(a.scanBodies[0].research_decisions, RESEARCH.decisions, 'the reject decision rides along')
  await a.ctx.close()
  // 2. A changed sentence on that first scan keeps the saved business profile, visibly.
  const c = await open({ buyer: BUYER })
  await c.page.getByTestId('business-profile').waitFor({ timeout: 15000 })
  await c.page.getByLabel('Who do you want to reach?').fill('A completely different sentence about another segment')
  assert.equal(await c.page.getByTestId('business-profile').count(), 1, 'the note stays: the saved profile still runs')
  await c.page.getByRole('button', { name: 'Find leads' }).click()
  await c.page.getByTestId('estimate-confirm-run').click()
  await c.page.getByText('Queued - waiting to start.').waitFor()
  assert.deepEqual(c.scanBodies[0].icp, BUYER, 'explicit review decisions are never silently discarded')
  await c.ctx.close()
  // 3. No saved buyer: nothing is carried, the server works out the profile.
  const d = await open({ buyer: null })
  await d.page.getByLabel('Who do you want to reach?').waitFor({ timeout: 15000 })
  assert.equal(await d.page.getByTestId('business-profile').count(), 0)
  await d.page.getByLabel('Who do you want to reach?').fill(Q)
  await d.page.getByRole('button', { name: 'Find leads' }).click()
  await d.page.getByTestId('estimate-confirm-run').click()
  await d.page.getByText('Queued - waiting to start.').waitFor()
  assert.equal(d.scanBodies[0].icp, undefined)
  await d.ctx.close()
  // 4. Home > Build reopen: the editor re-saves the research block whole.
  const e = await open({ buyer: BUYER, page: '/app?setup=brain' })
  await e.page.getByRole('button', { name: /Looks right|continue/i }).first().waitFor({ timeout: 15000 })
  await e.page.getByRole('button', { name: /Looks right|continue/i }).first().click()
  await e.page.waitForResponse(r => r.url().includes('/api/settings/profile') && r.request().method() === 'POST', { timeout: 15000 }).catch(() => {})
  assert.equal(e.saves.length, 1, 'the save went out')
  assert.deepEqual(e.saves[0].buyer.research, BUYER.research, 'reopen + save keeps every decision and the research block whole')
  assert.deepEqual(e.saves[0].buyer.who, BUYER.who)
  await e.ctx.close()
  console.log('profile carry-through UI check passed: first scan uses the saved reviewed business profile with its decisions; reopen + save keeps the research whole')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
