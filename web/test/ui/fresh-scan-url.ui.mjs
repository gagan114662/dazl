// Rendered check for the fresh-scan URL (Instinct, scan 5): start on an older scan's Leads URL, run Find leads, and the
// address bar must name the NEW job. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/fresh-scan-url.ui.mjs   (SHOTS=<dir> saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, and EVERY /api/* CALL ANSWERED
// FROM A STUB in the browser: the scan is not run, nothing is drafted or exported. It proves:
//   1. from /app/leads?job_id=<old> (also with &passive=1), Find leads asks for the price estimate and, once it is
//      confirmed, sends one POST /api/scan; once the new job
//      exists, the URL is /app/leads?job_id=<new> (passive dropped) while the page shows the new result;
//   2. a refresh, and the same URL opened in a new tab, show the new result, never the old one;
//   3. the Campaign page link and the Download CSV link name the new job.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-freshscanurl-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const OLD = 'a'.repeat(24), NEW = 'a0480c99af14e8c72fde3851'
const QUERY = 'Dental practice owners in Ohio - opened a new location'
const ICP = { summary: 'Growing dental practices', who: ['Practice owner'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['new location'], exclude: [] }
const lead = (id, company) => ({ id, name: '', company, contact: `hello@${company.toLowerCase().replace(/\W/g, '')}.example`, signal: `${company} opened a second office`, source_url: `https://www.news.example/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} opened a second office`, event_date: '2026-10-01', date_status: 'unverified', confidence: 80, review_reason: null, company_domain: null, human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 3, action: 3, why: `${company} matches your dental owner profile.`, signals: null, icp_match: null, enrichments: [], events: [] })
const LEADS = { [OLD]: [lead('1'.repeat(24), 'Old Dental')], [NEW]: [lead('2'.repeat(24), 'New Dental')] }
let created = 0
const writes = []
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
  if (u.origin !== base) return route.abort()
  if (!p.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (m !== 'GET') writes.push(`${m} ${p}`)
  // the price estimate shown before every run (synthetic numbers); the scan starts only from its confirm button
  if (p === '/api/scan/estimate' && m === 'POST') return json({ estimate: { rows: [], total: { min: 0.05, max: 0.4 }, unpriced: [], assumptions: ['This is an estimate, not a quote or a bill.'], payer: 'you', cap: { max_usd: null, reserved_usd: 0, remaining_usd: null, binding: null, month_cap_usd: null, month_reserved_usd: 0, unknown: false, capped_total: { min: 0.05, max: 0.4 } }, verdict: { ok: true, reason: null, message: 'Within your limit.', change: [], warning: null }, ack: 'ack-fresh' } })
  if (p === '/api/scan' && m === 'POST') { created = Date.now(); return json({ job_id: NEW }, 202) }
  if (p === '/api/scan/status') {
    const id = u.searchParams.get('job_id')
    if (id !== OLD && !(id === NEW && created)) return json({ error: 'not_found' }, 404)
    const status = id === NEW && Date.now() - created < 2500 ? 'running' : 'done'
    return json({ job_id: id, status, created_at: 1761500000, claimed_at: 1761500001, attempts: 1, max_attempts: 3, lead_count: status === 'done' ? 1 : 0, quality: status === 'done' ? { candidates: 1, passed: 1, needs_review: 0, dropped: 0, drop_reasons: {} } : null, error: null, icp: ICP, icp_source: 'user', query: QUERY, enrichment: { state: 'none' } })
  }
  if (p === '/api/leads' && m === 'GET') { const id = u.searchParams.get('job_id'); return json({ job_id: id, status: 'done', hidden_count: 0, leads: LEADS[id] ?? [] }) }
  if (p === '/api/scan/jobs') return json({ jobs: [] })
  if (p === '/api/usage') return json({ plan: 'pro', scans_used: 1, scan_limit: 10, has_key: true, trial: null })
  if (p === '/api/scan/sources') return json({ web_index: true, news: true, websites: true })
  if (p === '/api/outreach' && m === 'GET') return json({ messages: [] })
  return json({}, 404)
})
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
const card = (page, company) => page.getByTestId('lead-card').filter({ hasText: company })
const showsNew = async (page, label) => {
  await card(page, 'New Dental').waitFor({ timeout: 15000 })
  assert.equal(await card(page, 'Old Dental').count(), 0, `${label}: the old result is not shown`)
  const url = new URL(page.url())
  assert.equal(url.pathname + '?' + url.searchParams.toString(), `/app/leads?job_id=${NEW}`, `${label}: the URL names the new job`)
  assert.equal(await page.getByTestId('campaign-page-link').getAttribute('href'), `/app/campaigns/${NEW}`, `${label}: Campaign page link`)
  assert.equal(await page.getByRole('link', { name: 'Download CSV' }).getAttribute('href'), `/api/leads/export?job_id=${NEW}`, `${label}: CSV export link`)
}
try {
  for (const start of [`/app/leads?job_id=${OLD}`, `/app/leads?job_id=${OLD}&passive=1`]) {
    created = 0; writes.length = 0
    const page = await ctx.newPage()
    await page.goto(base + start, { waitUntil: 'networkidle' })
    await card(page, 'Old Dental').waitFor({ timeout: 15000 })
    assert.equal(await page.getByTestId('campaign-page-link').getAttribute('href'), `/app/campaigns/${OLD}`)
    await shot(page, start.includes('passive') ? 'old-passive' : 'old')
    await page.getByRole('button', { name: 'Find leads' }).click()
    await page.getByTestId('estimate-confirm-run').click({ timeout: 15000 }) // the price estimate is confirmed; then the scan starts
    await page.waitForURL(u => u.searchParams.get('job_id') === NEW, { timeout: 15000 })
    await showsNew(page, `${start}: after Find leads`)
    assert.deepEqual(writes, ['POST /api/scan/estimate', 'POST /api/scan'], 'one estimate, then one scan request; nothing else written')
    await shot(page, start.includes('passive') ? 'new-passive' : 'new')
    await page.reload({ waitUntil: 'networkidle' })
    await showsNew(page, `${start}: after refresh`)
    const copy = await ctx.newPage()
    await copy.goto(page.url(), { waitUntil: 'networkidle' })
    await showsNew(copy, `${start}: copied URL in a new tab`)
    await copy.close(); await page.close()
  }
  console.log('fresh-scan URL UI check passed: Find leads from an older scan URL moves the URL, Campaign link and CSV link to the new job; refresh and a copied URL keep the new result')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
