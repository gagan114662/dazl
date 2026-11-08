// Rendered check: the reviewed business profile carries through the FIRST scan, and reopening the brain editor keeps
// its research decisions. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/profile-carrythrough.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed in the
// browser (no model call, no scan runs). Live finding (staging, 2026-11-07): the saved business profile was reviewed
// and saved, but the first Find leads sent NO profile (the server worked out a new one, discarding the review), and
// reopening Home > Build dropped every saved Dismiss because the editor only hydrated the flat fields. It proves:
//   1. first scan, saved buyer with a rejection, a hold and the canonical fields (country/language/window/lookalike):
//      the page says Find leads uses the saved business profile AS IT IS (never "review decisions you made" - a saved
//      profile is not a review), and the estimate POST and the scan POST carry exactly the same profile, whole, both
//      marked reviewed: false so the server never treats presence as approval;
//   2. a changed sentence on that first scan still carries the saved business profile (decisions never silently
//      discarded); the note stays visible so the person can see what runs;
//   3. no saved buyer: no note, and the scan request carries no profile (the server works one out);
//   4. an autosaved, never-reviewed buyer (no decisions, statements only sourced): same honest note, still
//      reviewed: false, and NO research decisions are claimed;
//   5. reload after that carried first scan (latest reads icp_source 'carried'): the exact-sentence repeat carries
//      the stored profile raw again - reviewed: false, never the default semantics that would promote it;
//   6. Home > Build (?setup=brain) reopen + save: the POST /api/settings/profile keeps the research block and its
//      rejections whole, and the canonical fields (country/language/window/lookalike) with it (fail-before: the save
//      dropped research and every non-flat field entirely);
//   7. "Review profile first" carries the saved profile in prior_icp (never a silent decision reset) and the draft
//      editor shows the dismissed statements.
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
  u: [{ n: ['dazl lead finding'], k: 'persona', t: '', s: 'reviewed', w: true, o: true }],
  decisions: [{ offer: 'o1', hypothesis: 'h2', action: 'reject' }],
}
const LOOKALIKE = { v: 1, p: 6, q: 6, f: [{ d: 'i', t: 'software', n: 3, x: 2.5 }], h: { p: 0.8, b: 0.4, n: 6 }, k: { c: 'abcde12345', x: 'zzzzz', n: 'yyyyy' } }
const BUYER = { summary: 'Businesses that need evidence-backed outbound leads', who: ['Founders', 'B2B sales teams'], industries: [], sizes: [], where: [], signals: ['seeking a lead-finding tool'], exclude: [], country: 'US', language: 'en', window_days: 180, lookalike: LOOKALIKE, research: RESEARCH }
// The same buyer as dazl autosaves it before any review: every statement sourced, no decisions recorded.
const UNREVIEWED_BUYER = { ...BUYER, research: { ...RESEARCH, hyps: RESEARCH.hyps.map(h => ({ ...h, s: 'sourced' })), decisions: [] } }
const ESTIMATE = { estimate: { rows: [], total: { min: 0, max: 0 }, unpriced: [], assumptions: ['Synthetic fenced estimate'], payer: 'you', cap: { max_usd: null, reserved_usd: 0, remaining_usd: null, binding: null, capped_total: { min: 0, max: 0 }, month_cap_usd: null, month_reserved_usd: 0, unknown: false }, verdict: { ok: true, reason: null, message: 'Synthetic estimate only', change: [], warning: null }, ack: 'synthetic-fenced-ack' } }

const b = await chromium.launch()
async function open({ buyer, latest = { query: null, icp: null, icp_source: null }, page: pagePath = '/app/leads' }) {
  const scanBodies = [], estBodies = [], saves = [], previews = []
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
    if (p === '/api/scan/estimate' && m === 'POST') { estBodies.push(JSON.parse(req.postData())); return json(ESTIMATE) }
    if (p === '/api/scan/icp' && m === 'POST') { previews.push(JSON.parse(req.postData())); const prior = JSON.parse(req.postData()).prior_icp; return json({ icp: { summary: 'Fresh inference from the sentence', who: ['Owners'], industries: [], sizes: [], where: [], signals: [], exclude: [], ...(prior?.research ? { research: prior.research } : {}) }, inferred: true }) }
    if (p === '/api/scan' && m === 'POST') { scanBodies.push(JSON.parse(req.postData())); return json({ job_id: 'e'.repeat(24) }, 202) }
    if (p === '/api/scan/status') return json({ status: 'pending', lead_count: 0, attempts: 0, max_attempts: 3 })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}${pagePath}`, { waitUntil: 'networkidle' })
  return { ctx, page, scanBodies, estBodies, saves, previews }
}
try {
  // 1. First scan: the saved buyer carries through whole - rejections, the held offer, the canonical fields - and the
  //    estimate and scan requests are the SAME profile, both marked reviewed: false (presence is not approval).
  const a = await open({ buyer: BUYER })
  await a.page.getByTestId('business-profile').waitFor({ timeout: 15000 })
  const note = await a.page.getByTestId('business-profile').textContent()
  assert.match(note, /^Find leads uses the saved profile as it is: Businesses that need evidence-backed outbound leads\./)
  assert.ok(!note.includes('review decisions you made'), 'a saved profile is not a review: the note never claims decisions were made on it')
  await a.page.getByLabel('Who do you want to reach?').fill(Q)
  await a.page.getByRole('button', { name: 'Find leads' }).click()
  assert.equal(a.scanBodies.length, 0, 'no scan before estimate confirmation')
  assert.equal(a.estBodies.length, 1)
  await a.page.getByTestId('estimate-confirm-run').click()
  await a.page.getByText('Queued - waiting to start.').waitFor()
  assert.equal(a.scanBodies.length, 1)
  assert.deepEqual(a.estBodies[0].icp, a.scanBodies[0].icp, 'the estimate and the scan carry the same profile')
  assert.deepEqual(a.scanBodies[0].icp, BUYER, 'the saved profile is sent whole: research, held offer, country/language/window/lookalike')
  assert.equal(a.estBodies[0].reviewed, false, 'the estimate says not-a-review')
  assert.equal(a.scanBodies[0].reviewed, false, 'the scan says not-a-review')
  assert.deepEqual(a.scanBodies[0].research_decisions, RESEARCH.decisions, 'the recorded reject and hold decisions ride along, still marked sourced/held server-side')
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
  assert.equal(c.scanBodies[0].reviewed, false)
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
  assert.equal(d.scanBodies[0].reviewed, undefined, 'nothing carried, nothing marked')
  await d.ctx.close()
  // 4. An autosaved, never-reviewed buyer: the same honest note, still not a review, and no decisions claimed.
  const f = await open({ buyer: UNREVIEWED_BUYER })
  await f.page.getByTestId('business-profile').waitFor({ timeout: 15000 })
  const note4 = await f.page.getByTestId('business-profile').textContent()
  assert.ok(!note4.includes('review decisions you made'), 'the autosaved buyer was never reviewed and the note says so')
  await f.page.getByLabel('Who do you want to reach?').fill(Q)
  await f.page.getByRole('button', { name: 'Find leads' }).click()
  await f.page.getByTestId('estimate-confirm-run').click()
  await f.page.getByText('Queued - waiting to start.').waitFor()
  assert.deepEqual(f.scanBodies[0].icp, UNREVIEWED_BUYER, 'the autosaved profile carries whole too')
  assert.equal(f.scanBodies[0].reviewed, false, 'autosaved is carried as stored, never as approval')
  assert.deepEqual(f.scanBodies[0].research_decisions, [], 'no review act ever happened, so no decisions are claimed')
  await f.ctx.close()
  // 5. Reload + exact-sentence repeat of a carried scan: the stored origin ('carried') keeps the repeat raw.
  const g = await open({ buyer: BUYER, latest: { query: Q, icp: BUYER, icp_source: 'carried' } })
  await g.page.getByLabel('Who do you want to reach?').waitFor({ timeout: 15000 })
  await g.page.getByLabel('Who do you want to reach?').fill(Q)
  await g.page.getByRole('button', { name: 'Find leads' }).click()
  await g.page.getByTestId('estimate-confirm-run').click()
  await g.page.getByText('Queued - waiting to start.').waitFor()
  assert.deepEqual(g.scanBodies[0].icp, BUYER, 'the restored carried profile runs whole on the repeat')
  assert.equal(g.scanBodies[0].reviewed, false, 'a carried job is never re-read as a review')
  await g.ctx.close()
  // 6. Home > Build reopen: the editor re-saves the research block and the canonical fields whole.
  const e = await open({ buyer: BUYER, page: '/app?setup=brain' })
  await e.page.getByRole('button', { name: /Looks right|continue/i }).first().waitFor({ timeout: 15000 })
  await e.page.getByRole('button', { name: /Looks right|continue/i }).first().click()
  await e.page.waitForResponse(r => r.url().includes('/api/settings/profile') && r.request().method() === 'POST', { timeout: 15000 }).catch(() => {})
  assert.equal(e.saves.length, 1, 'the save went out')
  assert.deepEqual(e.saves[0].buyer.research, BUYER.research, 'reopen + save keeps every decision and the research block whole')
  assert.deepEqual(e.saves[0].buyer.who, BUYER.who)
  assert.equal(e.saves[0].buyer.country, 'US', 'the canonical fields survive the round-trip')
  assert.equal(e.saves[0].buyer.language, 'en')
  assert.equal(e.saves[0].buyer.window_days, 180)
  assert.deepEqual(e.saves[0].buyer.lookalike, LOOKALIKE)
  await e.ctx.close()
  // 7. "Review profile first" with a saved profile: the preview request CARRIES the profile, and the draft editor
  //    shows the review state (the dismissed statement is there to restore) instead of silently resetting it.
  const h = await open({ buyer: BUYER })
  await h.page.getByTestId('business-profile').waitFor({ timeout: 15000 })
  await h.page.getByLabel('Who do you want to reach?').fill(Q)
  await h.page.getByRole('button', { name: 'Review profile first' }).click()
  await h.page.getByText('Dismissed targeting (restore explicitly)').waitFor({ timeout: 15000 })
  assert.equal(h.previews.length, 1)
  assert.deepEqual(h.previews[0].prior_icp, BUYER, 'the preview carries the saved profile whole so the server can keep its decisions')
  assert.deepEqual(h.scanBodies, [], 'a preview never starts a scan')
  await h.ctx.close()
  console.log('profile carry-through UI check passed: first scan uses the saved reviewed business profile with its decisions; reopen + save keeps the research whole')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
