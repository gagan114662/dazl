// Rendered check for Find work email on "Needs your review" rows (#1036). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/work-email-review-lane.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call answered from a stub in the
// browser. It proves, on the rendered page:
//   1. a review row with a settled site and a buyer shows exactly ONE [data-testid="review-work-email"] with a Find work email
//      button while "Keep as research" is still unclicked, and loading the page makes NO /api/leads/<id>/work-email request;
//   2. a counterparty_signal row shows none;
//   3. the click posts once for that lead and shows the address; a long address does not overflow the card at 390 px.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-review-we-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), email_verified_at INTEGER); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt,email_verified_at) VALUES ('u1','s@example.test','x','y',1)").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const JOB = 'b'.repeat(24), A = 'a'.repeat(24), C = 'c'.repeat(24)
const ICP = { summary: 'Chicago law firms', who: ['Chief Marketing Officer'], industries: ['Legal'], sizes: [], where: ['Chicago, IL'], signals: ['new office'], exclude: [] }
const dom = { connector: 'sitecrawl', kind: 'domain', value: 'harlowreedlaw.example|evidence_own_domain', label: 'domain-basis-v1:evidence_own_domain', source_url: 'https://www.harlowreedlaw.example/', source_date: '2026-11-13', confidence: null, retrieved_at: Math.floor(Date.now() / 1000) }
const person = { connector: 'sitecrawl', kind: 'person', value: 'Jordan Hammond, Chief Marketing Officer', label: null, source_url: 'https://www.harlowreedlaw.example/contact-us/', source_date: '2026-11-13', confidence: null, retrieved_at: Math.floor(Date.now() / 1000) }
const lead = (id, company, review_reason) => ({ id, name: '', company, contact: null, signal: `${company} opened an office`, source_url: 'https://www.news.example/x', score: 70, evidence_excerpt: `${company} opened an office`, event_date: null, date_status: null, confidence: 80, review_reason, company_domain: null, human_confirmed_at: null, human_confirmed_from: null, quarantined_at: null, source_kind: 'query', fit: 4, intent: 3, action: 3, why: 'x', signals: null, icp_match: null, enrichments: [dom, person] })
const LEADS = [lead(A, 'Harlow Reed', 'outside_window_undated'), lead(C, 'Counterparty Co', 'counterparty_signal')]
// no hyphen or dot for the browser to break at before the domain: only the wrap class keeps it inside a 390 px card
const LONG = 'jordanhammondchiefmarketingofficerextralonglocalpartforalawfirm@averyveryverylonglawfirmdomainnameharlowreedlaw.example'
const weCalls = []
// #1182: the list answer carries the page's stored work-email lookups (one read), so no per-lead GET is made on load.
let stored = false
const STORED_ROW = { target: 'Jordan Hammond|Chief Marketing Officer', status: 'published', provider: 'site', address: 'jordan@harlowreedlaw.example', detail: 'printed on the company website', source_url: 'https://www.harlowreedlaw.example/contact-us/', mailbox_check: null, mailbox_verifier: null, updated_at: 1 }
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method()
  if (u.origin !== base) return route.abort()
  if (!u.pathname.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (u.pathname === '/api/scan/status') return json({ status: 'done', lead_count: LEADS.length, icp: ICP, icp_source: 'user', attempts: 1, max_attempts: 3, query: 'Chicago law firms that opened a new office' })
  if (u.pathname === '/api/leads') return json({ job_id: JOB, status: 'done', hidden_count: 0, leads: LEADS, work_email: { providers: { apollo: false, pdl: false, pdlNeedsOptIn: false, mailboxCheck: false }, providers_by_lead: {}, lookups: stored ? { [A]: [STORED_ROW] } : {} } })
  if (u.pathname === '/api/scan/jobs') return json({ jobs: [] })
  const we = /^\/api\/leads\/([a-f0-9]{24})\/work-email$/.exec(u.pathname)
  if (we) {
    weCalls.push(`${m} ${we[1]}`)
    if (m === 'POST') return json({ status: 'published', replayed: false, lookup: { target: 'Jordan Hammond|Chief Marketing Officer', status: 'published', provider: 'site', address: LONG, detail: 'printed on the company website', source_url: 'https://www.harlowreedlaw.example/contact-us/', checked_at: null, updated_at: Math.floor(Date.now() / 1000) } })
    return json({ providers: { apollo: false, pdl: false, pdlNeedsOptIn: false, mailboxCheck: false }, lookups: [] })
  }
  if (u.pathname === '/api/enrich/held') return json({ held: [] })
  return json({}, 404)
})
const page = await ctx.newPage()
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
try {
  await page.goto(`${base}/app/leads?job_id=${JOB}&passive=1`, { waitUntil: 'networkidle' })
  // 1. one block on the eligible review row, with the button, before any confirm click; nothing was requested for it on load
  const blocks = page.locator('[data-testid="review-work-email"]')
  await blocks.first().waitFor({ timeout: 15000 }).catch(async e => { console.log('PAGE TEXT:', (await page.locator('body').innerText()).slice(0, 1500)); throw e })
  assert.equal(await blocks.count(), 1, 'exactly one review-lane block on the page (the eligible row only, never twice)')
  assert.match(await blocks.first().innerText(), /WORK EMAIL FOR THE BUYER[\s\S]*Jordan Hammond[\s\S]*Chief Marketing Officer[\s\S]*Find work email/i)
  assert.equal(await blocks.first().getByRole('button', { name: 'Find work email' }).count(), 1)
  assert.ok(await page.getByRole('button', { name: 'Keep as research' }).count() >= 1, '"Keep as research" is still there, unclicked')
  assert.equal(await page.locator('[data-testid="work-email"]').count(), 1, 'no second work-email block anywhere (a review lead is not also a decided card)')
  assert.deepEqual(weCalls, [], 'loading the page made no work-email request for the review rows')
  // 2. the counterparty_signal row is shown, without the block
  const rows = page.locator('div.p-4.text-sm', { hasText: 'Counterparty Co' })
  assert.ok(await rows.count() >= 1, 'the counterparty row renders')
  assert.equal(await rows.first().locator('[data-testid="review-work-email"]').count(), 0, 'no block on a counterparty_signal row')
  await shot('review-lane-before-1280')
  // 3. the click posts once for that lead and shows the address
  await blocks.first().getByRole('button', { name: 'Find work email' }).click()
  await page.locator('[data-testid="work-email-address"]').first().waitFor({ timeout: 15000 })
  assert.deepEqual(weCalls, [`POST ${A}`], 'one POST for the clicked lead, nothing else')
  assert.match(await blocks.first().innerText(), /Published work email/)
  await shot('review-lane-after-1280')
  // ... and at 390 px the long address wraps inside the card: no horizontal overflow of the page or of the block
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const over = await page.evaluate(() => { const el = document.querySelector('[data-testid="review-work-email"]'); const a = document.querySelector('[data-testid="work-email-address"]'); const r = el.getBoundingClientRect(), ar = a.getBoundingClientRect(); return { page: document.documentElement.scrollWidth > document.documentElement.clientWidth, block: el.scrollWidth > el.clientWidth + 1, addressRight: Math.round(ar.right), blockRight: Math.round(r.right), vw: window.innerWidth } })
  assert.equal(over.page, false, `no horizontal page overflow at 390 px: ${JSON.stringify(over)}`)
  assert.equal(over.block, false, `the block does not overflow: ${JSON.stringify(over)}`)
  assert.ok(over.addressRight <= over.vw, `the long address stays inside the viewport: ${JSON.stringify(over)}`)
  await shot('review-lane-after-390')
  // control: without the wrap class the same address does overflow, so the assertions above are what the class buys
  const without = await page.evaluate(() => { const a = document.querySelector('[data-testid="work-email-address"] .font-mono'); a.classList.remove('break-all'); const r = document.querySelector('[data-testid="work-email-address"]').getBoundingClientRect(); return { right: Math.round(r.right), vw: window.innerWidth, page: document.documentElement.scrollWidth > document.documentElement.clientWidth } })
  assert.ok(without.right > without.vw || without.page, `control: the unwrapped address overflows at 390 px: ${JSON.stringify(without)}`)
  // 4. (#1182) a lookup stored earlier is shown after a reload with no click and no per-lead request at all
  weCalls.length = 0; stored = true
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto(`${base}/app/leads?job_id=${JOB}&passive=1`, { waitUntil: 'networkidle' })
  await page.locator('[data-testid="work-email-address"]').first().waitFor({ timeout: 15000 })
  assert.match(await page.locator('[data-testid="review-work-email"]').first().innerText(), /jordan@harlowreedlaw\.example/)
  assert.deepEqual(weCalls, [], 'the stored answer came with the list: no GET and no POST for the lead')
  await shot('review-lane-stored-1280')
  console.log('work-email review-lane UI check passed:', weCalls.join(', '))
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
