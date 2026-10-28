// Rendered check for the "N approved -> Review drafts" bar on Leads and the one-scan filter on Outreach.
// NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/review-drafts.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, and EVERY /api/* CALL ANSWERED
// FROM A STUB in the browser: no scan, no draft is really created, nothing is sent. Off-host requests are aborted.
// It proves:
//   1. no bar before anything from this scan is drafted (another scan's draft does not count);
//   2. each Approve sends the existing POST /api/outreach { lead_id } and the bar counts this scan's drafts, read back
//      from GET /api/outreach ("1 draft ... waiting for your review", then "2 drafts"); a draft is never called approved;
//   3. after a reload the bar still counts them; with one of them approved in Outreach (not sent), the bar shows the
//      two states apart and does not ask for a second approval; approved-only says "approved and not sent yet";
//   4. Review drafts opens /app/outreach?job_id=<scan>, which lists only that scan's emails, with "Show all emails";
//   5. if that scan's leads cannot be read, the filter fails closed: no emails listed, an error and "show all emails";
//   5b. the one-scan view never shows the workspace-wide Cold sequences (a sequence from another scan is in the fixture),
//      neither when the filter works nor when it fails; the full view still shows them;
//   6. the only writes are the two draft requests: nothing is approved for sending or sent.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-reviewdrafts-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const JOB = 'b'.repeat(24)
const ICP = { summary: 'Growing dental practices', who: ['Practice owner'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['new location'], exclude: [] }
const lead = (id, company, over = {}) => ({ id, name: '', company, contact: null, signal: `${company} opened a second office`, source_url: `https://www.news.example/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} opened a second office`, event_date: '2026-10-01', date_status: 'unverified', confidence: 80, review_reason: null, company_domain: null, human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 3, action: 3, why: `${company} is a two-location practice that matches your dental owner profile. More detail follows.`, signals: null, icp_match: null, enrichments: [], events: [], ...over })
const A = 'a'.repeat(24), G = '7'.repeat(24), OTHER = '9'.repeat(24)
const LEADS = [lead(A, 'Bright Dental', { contact: 'hello@brightdental.example' }), lead(G, 'Grove Dental', { contact: 'hello@grovedental.example' }), lead('c'.repeat(24), 'Lakeside Smiles')]
const msg = (lead_id, to_email, status = 'draft') => ({ id: lead_id.slice(0, 6) + 'm', lead_id, to_email, subject: `Hello ${to_email}`, body: 'Hi there', status, error: null, created_at: 1, sent_at: null, test: 0, evidence_state: 'machine', currentness_held: false, provenance: null, send_footer: null })
// Another scan's draft is already in Outreach: it must not count for this scan, and the filter must hide it.
const MSGS = [msg(OTHER, 'hello@elsewhere.example')]
let leadsFail = false
const writes = []
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method()
  if (u.origin !== base) return route.abort()
  if (!u.pathname.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (m !== 'GET') writes.push(`${m} ${u.pathname}`)
  if (u.pathname === '/api/scan/status') return json({ status: 'done', lead_count: LEADS.length, icp: ICP, icp_source: 'user', attempts: 1, max_attempts: 3, query: 'Dental practice owners in Ohio opening a new location' })
  if (u.pathname === '/api/leads' && leadsFail) return json({ error: 'unavailable' }, 503)
  if (u.pathname === '/api/leads' && u.searchParams.get('job_id') === JOB) return json({ job_id: JOB, status: 'done', hidden_count: 0, leads: LEADS })
  if (u.pathname === '/api/scan/jobs') return json({ jobs: [] })
  // A live cold sequence from ANOTHER scan: it must never appear in this scan's view.
  if (u.pathname === '/api/outreach/sequences' && m === 'GET') return json({ sequences: [{ id: 's1', message_id: 'm-other', lead_id: OTHER, to_email: 'seq@elsewhere.example', status: 'active', stop_reason: null, evidence_state: 'machine', currentness_held: false, steps: [{ step: 1, subject: 'Step one', body: 'Hi', status: 'sent', due_at: 1, sent_at: 1 }] }], status: {}, test_addresses: [], campaigns: [] })
  if (u.pathname === '/api/outreach' && m === 'GET') return json({ messages: MSGS })
  if (u.pathname === '/api/outreach' && m === 'POST') {
    const { lead_id } = JSON.parse(req.postData()); const l = LEADS.find(x => x.id === lead_id)
    MSGS.unshift(msg(lead_id, l.contact)); return json({ ok: true, message_id: lead_id.slice(0, 6) + 'm' })
  }
  return json({}, 404)
})
const page = await ctx.newPage()
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
const card = company => page.getByTestId('lead-card').filter({ hasText: company })
try {
  await page.goto(`${base}/app/leads?job_id=${JOB}&passive=1`, { waitUntil: 'networkidle' })
  await page.getByTestId('lead-card').first().waitFor({ timeout: 15000 })
  if (process.env.BEFORE_ONLY) { await card('Bright Dental').getByRole('button', { name: 'Approve' }).click(); await page.waitForTimeout(800); await shot('leads'); console.log('before shot'); process.exit(0) }
  assert.equal(await page.getByTestId('approved-bar').count(), 0, "another scan's draft does not count")
  await card('Bright Dental').getByRole('button', { name: 'Approve' }).click()
  const bar = page.getByTestId('approved-bar')
  await bar.waitFor()
  const BAR2 = '2 drafts from this scan are waiting for your review in Outreach. Nothing is sent until you approve each one there.'
  assert.equal(await bar.textContent().then(t => t.startsWith('1 draft from this scan is waiting for your review in Outreach. Nothing is sent until you approve it there.')), true)
  await card('Grove Dental').getByRole('button', { name: 'Approve' }).click()
  await page.getByText(BAR2).waitFor()
  assert.doesNotMatch(await bar.textContent(), /\bapproved\b/, 'drafts are never called approved')
  await shot('leads')
  // Read back from Outreach: a reload keeps the count.
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByText(BAR2).waitFor()
  // One of them approved in Outreach, not sent yet: the two states are shown apart, no second approval asked.
  MSGS.find(x => x.lead_id === G).status = 'approved'
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByText('1 draft from this scan is waiting for your review in Outreach. Nothing is sent until you approve it there. 1 email from this scan is approved and not sent yet.').waitFor()
  await shot('leads-mixed')
  MSGS.find(x => x.lead_id === A).status = 'approved'
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByText('2 emails from this scan are approved and not sent yet.').waitFor()
  assert.equal(await page.getByTestId('approved-bar').getByRole('link', { name: 'Open in Outreach' }).count(), 1, 'approved-only: no "Review drafts"')
  MSGS.find(x => x.lead_id === A).status = 'draft'; MSGS.find(x => x.lead_id === G).status = 'draft'
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByText(BAR2).waitFor()
  const review = page.getByTestId('approved-bar').getByRole('link', { name: 'Review drafts' })
  assert.equal(await review.getAttribute('href'), `/app/outreach?job_id=${JOB}`)
  await review.click()
  await page.waitForURL(`**/app/outreach?job_id=${JOB}`)
  const filter = page.getByTestId('scan-filter'); await filter.waitFor()
  await page.getByText('hello@brightdental.example').first().waitFor()
  assert.match(await filter.textContent(), /^Showing the 2 emails from one scan\./)
  assert.equal(await page.getByText('hello@grovedental.example').count() > 0, true)
  assert.equal(await page.getByText('hello@elsewhere.example').count(), 0, "the other scan's draft is not listed")
  assert.equal(await filter.getByRole('link', { name: 'Back to its leads' }).getAttribute('href'), `/app/leads?job_id=${JOB}`)
  assert.equal(await page.getByText('seq@elsewhere.example').count(), 0, "another scan's sequence is not shown")
  assert.equal(await page.getByRole('heading', { name: 'Cold sequences' }).count(), 0)
  assert.match(await page.getByTestId('sequences-hidden').textContent(), /not shown in this one-scan view/)
  await shot('outreach-filtered')
  await filter.getByRole('link', { name: 'Show all emails' }).click()
  await page.waitForURL('**/app/outreach')
  await page.getByText('hello@elsewhere.example').first().waitFor()
  assert.equal(await page.getByTestId('scan-filter').count(), 0)
  await page.getByRole('heading', { name: 'Cold sequences' }).waitFor()
  await page.getByText('seq@elsewhere.example').first().waitFor()
  assert.equal(await page.getByTestId('sequences-hidden').count(), 0, 'the full view keeps its sequences')
  // The scan's leads cannot be read: fail closed, never another scan's emails under this scan's link.
  leadsFail = true
  await page.goto(`${base}/app/outreach?job_id=${JOB}`, { waitUntil: 'networkidle' })
  const failed = page.getByTestId('scan-filter'); await failed.waitFor()
  assert.match(await failed.textContent(), /^Could not load that scan's emails\. Reload to retry, or show all emails\./)
  assert.equal(await page.getByText('hello@elsewhere.example').count(), 0, 'no unrelated emails')
  assert.equal(await page.getByText('hello@brightdental.example').count(), 0)
  assert.equal(await page.getByText('seq@elsewhere.example').count(), 0, 'failed lookup: no sequence recipients either')
  assert.equal(await page.getByRole('heading', { name: 'Cold sequences' }).count(), 0)
  await page.getByTestId('sequences-hidden').waitFor()
  await shot('outreach-fail-closed')
  assert.deepEqual(writes, ['POST /api/outreach', 'POST /api/outreach'], 'only the two draft requests: nothing approved for sending or sent')
  console.log('review drafts UI check passed: bar counts drafts and approved apart, this scan only, survives reload, fail-closed filter, Outreach filtered to the scan, only draft writes')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
