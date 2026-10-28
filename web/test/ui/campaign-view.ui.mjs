// Rendered check for the one-campaign page (/app/campaigns/<scan>). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/campaign-view.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, and EVERY /api/* CALL ANSWERED
// FROM A STUB in the browser: no scan, no draft, nothing sent. Off-host requests are aborted. It proves:
//   1. the Campaigns list, Home ("Your plays") and Leads (the scan being viewed) all link a campaign to its own page;
//   2. the page shows the play (the search sentence) and the scan's state from GET /api/campaigns/<id> only: it never
//      calls the scan status read (which can reap stale jobs) or the account-wide Outreach list (newest 200 only);
//   3. every lead of the scan (rejected ones included) shows where it stands: rejected, needs review, not verified,
//      source-checked, draft waiting, approved not sent, sent;
//   4. drafts and sends list only this scan's emails (another scan's draft is not shown);
//   5. if the campaign cannot be read, nothing is claimed (no leads, no emails); an unknown scan says not found;
//   6. loading the page writes nothing.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-campaignview-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const JOB = 'b'.repeat(24), OTHER_JOB = 'c'.repeat(24)
const L = (id, company, o = {}) => ({ id: id.repeat(24), company, name: '', evidence_excerpt: `${company} opened a second office`, confidence: 80, human_confirmed_at: null, review_reason: null, quarantined_at: null, quarantine_reason: null, ...o })
const LEADS = [
  L('1', 'Sent Dental'), L('2', 'Approved Dental'), L('3', 'Draft Dental'), L('4', 'Checked Dental'),
  L('5', 'Review Dental', { review_reason: 'no_quote' }), L('6', 'Legacy Dental', { evidence_excerpt: null }),
  L('7', 'Rejected Dental', { quarantined_at: 1, quarantine_reason: 'Rejected: not a fit' }),
]
const M = (lead, status, to, sent_at = null) => ({ id: lead.slice(0, 1) + 'm', lead_id: lead.repeat(24), to_email: to, subject: `Hello ${to}`, body: 'Hi', status, error: null, created_at: 1, sent_at, test: 0 })
const MSGS = [M('1', 'sent', 'hi@sent.example', 1761600000), M('2', 'approved', 'hi@approved.example'), M('3', 'draft', 'hi@draft.example'), M('9', 'draft', 'hi@elsewhere.example')]
let detailFail = false
const writes = []; const calls = []
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method()
  if (u.origin !== base) return route.abort()
  if (!u.pathname.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (m !== 'GET') writes.push(`${m} ${u.pathname}`)
  if (u.pathname === '/api/scan/jobs') return json({ jobs: [{ id: JOB, status: 'done', error: null, query: 'Dental practice owners in Ohio - opened a new location', business_name: '', csv_domain: null, created_at: 1761500000, finished_at: 1761500100, candidates: 9, verified: 4, needs_review: 1, dropped: 2, lead_count: 7, test_only: false }] })
  if (u.pathname === '/api/scan/status') return json({ job_id: JOB, status: 'done', lead_count: LEADS.length, attempts: 1, max_attempts: 3, query: 'Dental practice owners in Ohio - opened a new location' })
  if (u.pathname === '/api/leads') return json({ job_id: JOB, status: 'done', hidden_count: 0, leads: [] })
  if (u.pathname === '/api/campaigns') return json({ campaigns: [{ id: JOB, query: 'Dental practice owners in Ohio - opened a new location', status: 'done', error: null, created_at: 1761500000, discovery: { candidates: 9, leads: 7 }, qualification: { sourceChecked: 4, confirmedByYou: 0, needsReview: 1, unverified: 1, held: 0, rejected: 1 }, contact: { withContact: 3 }, outreach: { drafts: 1, approved: 1, sent: 1, draftsReady: 1, draftsSetup: 0, draftsHeld: 0, approvedReady: 1, approvedSetup: 0, approvedHeld: 0 }, sequence: { active: 0, stopped: 0 }, reply: { replied: 0, interested: 0, bounced: 0, optOuts: 0 }, next: { label: 'Review 1 draft', href: '/app/outreach' } }] })
  calls.push(u.pathname)
  if (u.pathname === `/api/campaigns/${JOB}`) return detailFail ? json({ error: 'unavailable' }, 503) : json({ job: { id: JOB, query: 'Dental practice owners in Ohio - opened a new location', status: 'done', error: null, created_at: 1761500000, candidates: 9, verified: 4, needs_review: 1, dropped: 2 }, leads: LEADS, messages: MSGS })
  if (u.pathname.startsWith('/api/campaigns/')) return json({ error: 'Not found' }, 404)
  return json({}, 404)
})
const page = await ctx.newPage()
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
try {
  await page.goto(`${base}/app/campaigns`, { waitUntil: 'networkidle' })
  const link = page.getByTestId('campaign-link'); await link.waitFor({ timeout: 15000 })
  assert.equal(await link.getAttribute('href'), `/app/campaigns/${JOB}`)
  await link.click()
  await page.waitForURL(`**/app/campaigns/${JOB}`)
  await page.getByTestId('lead-status').first().waitFor()
  await page.getByTestId('campaign-email').first().waitFor()
  assert.equal(await page.getByTestId('campaign-play').textContent(), 'Dental practice owners in Ohio - opened a new location')
  assert.match(await page.getByTestId('campaign-status').textContent(), /^Scan: 9 found: 4 source-checked, 1 needs your review, 2 dropped/)
  assert.ok(!calls.some(p => p === '/api/scan/status' || p === '/api/outreach' || p === '/api/leads'), `only the campaign read is used: ${calls.join(', ')}`)
  const rows = await page.getByTestId('campaign-lead').evaluateAll(els => els.map(e => [e.children[0].textContent, e.children[1].textContent]))
  assert.deepEqual(rows, [
    ['Sent Dental', 'Sent'], ['Approved Dental', 'Approved, not sent yet'], ['Draft Dental', 'Draft waiting for your review'],
    ['Checked Dental', 'Source-checked, not drafted'], ['Review Dental', 'Needs your review'], ['Legacy Dental', 'Not verified - check the source'],
    ['Rejected Dental', 'Rejected: not a fit'],
  ])
  const emails = await page.getByTestId('campaign-email').allTextContents()
  assert.equal(emails.length, 3)
  assert.ok(emails.some(t => t.startsWith('hi@sent.example') && /sent \d/.test(t)))
  assert.ok(emails.some(t => t.startsWith('hi@approved.example') && t.endsWith('approved, not sent')))
  assert.ok(!emails.some(t => t.includes('elsewhere')), "another scan's draft is not listed")
  assert.equal(await page.locator('main').last().getByRole('link', { name: 'Outreach', exact: true }).getAttribute('href'), `/app/outreach?job_id=${JOB}`)
  await shot('campaign')
  // The campaign cannot be read: no lead or email is claimed.
  detailFail = true
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByTestId('messages-unavailable').waitFor()
  assert.equal(await page.getByTestId('campaign-email').count(), 0)
  assert.equal(await page.getByText('hi@elsewhere.example').count(), 0)
  assert.equal(await page.getByTestId('campaign-lead').count(), 0)
  // Unknown scan.
  detailFail = false
  await page.goto(`${base}/app/campaigns/${OTHER_JOB}`, { waitUntil: 'networkidle' })
  await page.getByText('This campaign was not found.').waitFor()
  await page.goto(`${base}/app/campaigns/not-a-scan`, { waitUntil: 'networkidle' })
  await page.getByText('This campaign was not found.').waitFor()
  // Home: the play in "Your plays" opens its campaign page.
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  const fromHome = page.getByTestId('play-campaign-link').first(); await fromHome.waitFor({ timeout: 15000 })
  await fromHome.click()
  await page.waitForURL(`**/app/campaigns/${JOB}`)
  await page.getByTestId('campaign-play').filter({ hasText: 'Dental practice owners in Ohio' }).waitFor()
  // Leads: the scan being viewed links to its campaign page.
  await page.goto(`${base}/app/leads?job_id=${JOB}&passive=1`, { waitUntil: 'networkidle' })
  const fromLeads = page.getByTestId('campaign-page-link'); await fromLeads.waitFor()
  await shot('leads-link')
  await fromLeads.click()
  await page.waitForURL(`**/app/campaigns/${JOB}`)
  await page.getByTestId('campaign-play').filter({ hasText: 'Dental practice owners in Ohio' }).waitFor()
  assert.deepEqual(writes, [], 'loading writes nothing')
  console.log('campaign view UI check passed: Campaigns, Home and Leads link to the page, play + status from the campaign read only, every lead staged, only this scan\'s emails, fail closed, not found, no writes')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
