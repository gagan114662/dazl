// End-to-end first-customer journey, every screen in order, following only what the pages offer. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/journey.ui.mjs   (SHOTS=<dir> saves a screenshot per step)
// Real production build, throwaway database (the real profile route writes to it), server under
// test/helpers/net-fence.ts, and every other /api/* call answered from a stub in the browser: no scan, no model call, no
// key check, no draft is really created and no email is sent. The Gmail grant is simulated by answering
// GET /api/gmail/connect with the same redirect Google's callback ends in (/app/settings?gmail=connected).
// The page is opened ONCE at /app; after that every step is a click on something the page shows. It fails on a dead end:
//   - a step whose next button or link is missing (the next click times out);
//   - a step that needs a typed URL (there is no page.goto after the first);
//   - an empty or blocked state with no next step;
//   - a chunk-load error or the app error screen at any point.
// Steps: website -> profile (brain) -> one-sentence play from 3 suggestions -> Find leads -> live progress (queued,
// running, done) -> lead cards (Approve one, Reject one with a reason) -> Review drafts -> Outreach draft -> Approve
// -> sender details inline -> Connect Gmail (Settings) -> back to Outreach -> Send now -> sent.
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
let chromium
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? ' (allowed by SMOKE_ALLOW_SKIP=1)' : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
try { ({ chromium } = require('playwright')) } catch (e) { notRun(e.message.split('\n')[0]) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const Database = require('better-sqlite3'); const { createHash, randomBytes } = require('crypto')
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-journey-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'),'u1',Math.floor(Date.now()/1000)+3600)
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'),'start','-p',String(port),'-H','127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED:'0', NEWS_SEARCH_ENABLED:'0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i=0;i<100;i++){ try { await fetch(base+'/sign-in'); break } catch { await new Promise(r=>setTimeout(r,200)) } }

const JOB = 'b'.repeat(24), A = 'a'.repeat(24), C = 'c'.repeat(24)
const ICP = { summary: 'Independent dental practices with 2-10 chairs that are growing.', who: ['Practice owners', 'Office managers'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['Opened a new location', 'Hiring front-desk staff', 'Switched practice software'], exclude: [] }
const lead = (id, company, over = {}) => ({ id, name: '', company, contact: null, signal: `${company} opened a second office`, source_url: `https://www.news.example/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} opened a second office`, event_date: '2026-10-01', date_status: 'unverified', confidence: 80, review_reason: null, company_domain: null, human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 3, action: 3, why: `${company} is a two-location practice that matches your dental owner profile.`, signals: null, icp_match: null, enrichments: [], events: [], ...over })
const LEADS = [lead(A, 'Bright Dental', { contact: 'hello@brightdental.example' }), lead(C, 'Lakeside Smiles', { contact: 'hi@lakeside.example' })]
const msg = (lead_id, to_email) => ({ id: 'm1', lead_id, to_email, subject: 'Your second Ohio office', body: 'Hi,\n\nCongrats on the new office...', status: 'draft', error: null, created_at: 1, sent_at: null, test: 0, evidence_state: 'machine', currentness_held: false, provenance: null, send_footer: null })
const state = { polls: 0, startedAt: 0, msgs: [], sender: null, gmail: null, quarantined: {} }
const writes = []; const problems = []
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
  if (u.origin !== base) return route.abort()
  if (!p.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (p === '/api/settings/profile') return route.continue() // the real route and its temporary database
  if (m !== 'GET') writes.push(`${m} ${p}`)
  // Simulated Google grant: the real callback ends in this redirect.
  if (p === '/api/gmail/connect') { state.gmail = { email: 'dana@brightsmile.example', status: 'active', read_granted: true }; return route.fulfill({ status: 302, headers: { location: `${base}/app/settings?gmail=connected` } }) }
  if (p === '/api/usage') return json({ plan: 'free', scans_used: 0, scan_limit: 10, has_key: false, trial: { funded: true, remaining: 3, cap: 3 } })
  if (p === '/api/scan/jobs') return json({ jobs: state.polls ? [{ id: JOB, status: Date.now() - state.startedAt > 7000 ? 'done' : 'running', error: null, query: 'Practice owners in Ohio - opened a new location', business_name: '', csv_domain: null, created_at: 1761500000, candidates: 3, verified: 2, needs_review: 0, dropped: 1, lead_count: 2, test_only: false, funded_by: 'trial' }] : [] })
  if (p === '/api/scan/icp-from-url') return json({ icp: ICP, source: 'https://brightsmile.example/', sells: 'Online booking and reminders for dental practices' })
  if (p === '/api/scan' && m === 'POST') { state.startedAt = Date.now(); return json({ job_id: JOB }, 202) }
  if (p === '/api/scan/status') {
    // Queued for 3 s, running until 7 s, then done: long enough to see each state.
    state.polls++
    const t = Date.now() - state.startedAt
    const s = t < 3000 ? 'pending' : t < 7000 ? 'running' : 'done'
    return json({ job_id: JOB, status: s, created_at: Math.floor(Date.now() / 1000) - 30, claimed_at: s === 'pending' ? null : Math.floor(Date.now() / 1000) - 10, attempts: 1, max_attempts: 3, lead_count: s === 'done' ? 2 : 0, quality: s === 'done' ? { candidates: 3, passed: 2, needs_review: 0, dropped: 1, drop_reasons: { stale: 1 } } : null, error: null, icp: ICP, icp_source: 'user', query: 'Practice owners in Ohio - opened a new location', enrichment: { state: 'none' } })
  }
  if (p === '/api/leads' && m === 'GET') return json({ job_id: JOB, status: 'done', hidden_count: 0, leads: LEADS.map(l => state.quarantined[l.id] ? { ...l, quarantined_at: 1, quarantine_reason: state.quarantined[l.id] } : l) })
  const q = /^\/api\/leads\/([a-f0-9]{24})\/quarantine$/.exec(p)
  if (q) { if (m === 'POST') state.quarantined[q[1]] = JSON.parse(req.postData()).reason; else delete state.quarantined[q[1]]; return json({ quarantined: m === 'POST' }) }
  if (p === '/api/outreach' && m === 'POST') { const { lead_id } = JSON.parse(req.postData()); state.msgs = [msg(lead_id, LEADS.find(l => l.id === lead_id).contact)]; return json({ ok: true, message_id: 'm1' }) }
  // Like the real listMessages: the send footer is recomputed from the current sender settings on every GET.
  if (p === '/api/outreach' && m === 'GET') return json({ messages: state.msgs.map(x => ({ ...x, send_footer: state.sender ? `${state.sender.sender_name}\n${state.sender.postal_address}\nUnsubscribe: https://dazl.ai/u/...` : null })) })
  if (p === '/api/outreach/m1' && m === 'POST') {
    const { action } = JSON.parse(req.postData())
    if (action === 'approve') state.msgs[0].status = 'approved'
    if (action === 'send') { if (state.gmail?.status !== 'active' || !state.sender) return json({ error: 'gmail_not_connected' }, 409); state.msgs[0].status = 'sent'; state.msgs[0].sent_at = Math.floor(Date.now() / 1000) }
    return json({ ok: true })
  }
  if (p === `/api/campaigns/${JOB}`) return json({ job: { id: JOB }, leads: [], messages: state.msgs })
  if (p === '/api/outreach/sequences') return json({ sequences: [], test_addresses: [], status: {}, campaigns: [] })
  if (p === '/api/outreach/settings' && m === 'GET') return json({ gmail: state.gmail, sender: state.sender, daily_cap: 20, sent_24h: 0, account_sent_24h: 0, read_notice: [] })
  if (p === '/api/outreach/settings' && m === 'PUT') { state.sender = JSON.parse(req.postData()); return json({ ok: true }) }
  if (p === '/api/scan/sources') return json({ web_index: true, news: true, websites: true })
  return json({}, 404)
})
const page = await ctx.newPage()
page.on('pageerror', e => problems.push(`page error: ${e.message}`))
page.on('console', c => { if (c.type() === 'error' && /ChunkLoadError|Loading chunk|Failed to load chunk|Loading CSS chunk/i.test(c.text())) problems.push(`chunk: ${c.text()}`) })
let n = 0
const step = async (name, fn) => {
  try { await fn() } catch (e) { await shot(`FAIL-${name}`); throw new Error(`dead end at "${name}" (${page.url().replace(base, '')}): ${e.message.split('\n')[0]}`) }
  if (await page.getByText('This page could not be shown').count()) throw new Error(`app error screen at "${name}"`)
  assert.deepEqual(problems, [], `no page or chunk-load errors by "${name}"`)
  await shot(`${String(++n).padStart(2, '0')}-${name}`)
}
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
const T = { timeout: 15000 }
const card = company => page.getByTestId('lead-card').filter({ hasText: company })
try {
  await page.goto(base + '/app', { waitUntil: 'networkidle' }) // the only typed URL
  await step('website', async () => {
    await page.getByLabel('Your website').fill('brightsmile.example')
    await page.getByRole('button', { name: 'Read my site' }).click()
  })
  await step('brain', async () => {
    await page.getByText("Here's what we think you sell").waitFor(T)
    assert.equal(await page.getByLabel('What you sell').inputValue(), 'Online booking and reminders for dental practices')
    await page.getByRole('button', { name: 'Looks right, continue' }).click()
  })
  await step('play', async () => {
    const plays = page.getByRole('group', { name: 'Suggested plays' }).getByRole('button')
    await plays.first().waitFor(T)
    assert.equal(await plays.count(), 3, 'three suggested plays')
    await plays.nth(0).click()
    assert.equal(await page.getByLabel('Who do you want to reach').inputValue(), 'Practice owners in Ohio - opened a new location')
    await page.getByRole('button', { name: 'Find leads' }).click()
    await page.waitForURL(/\/app\/leads\?job_id=/, T)
  })
  await step('progress', async () => {
    await page.getByText('Queued - waiting to start.').waitFor(T)
    await page.getByText('Scanning - this can take a few minutes.').waitFor(T)
    assert.ok(await page.getByRole('button', { name: 'Stop this scan' }).count(), 'a running scan offers Stop')
  })
  await step('lead-cards', async () => {
    await card('Bright Dental').waitFor({ timeout: 30000 })
    assert.equal(await page.getByTestId('lead-card').count(), 2)
    for (const c of ['Bright Dental', 'Lakeside Smiles']) {
      await card(c).getByRole('button', { name: 'Approve' }).waitFor(T)
      await card(c).getByRole('button', { name: 'Reject' }).waitFor(T)
    }
  })
  await step('reject', async () => {
    await card('Lakeside Smiles').getByRole('button', { name: 'Reject' }).click()
    await card('Lakeside Smiles').getByRole('button', { name: 'Not a fit' }).click()
    await card('Lakeside Smiles').getByRole('button', { name: 'Confirm reject' }).click()
    await card('Lakeside Smiles').getByText(/^Rejected: Not a fit\. Kept with its evidence/).waitFor(T)
    await card('Lakeside Smiles').getByRole('button', { name: 'Undo' }).waitFor(T)
  })
  await step('approve', async () => {
    await card('Bright Dental').getByRole('button', { name: 'Approve' }).click()
    await page.getByTestId('approved-bar').getByRole('link', { name: 'Review drafts' }).waitFor(T)
  })
  await step('review-drafts', async () => {
    await page.getByTestId('approved-bar').getByRole('link', { name: 'Review drafts' }).click()
    await page.waitForURL(/\/app\/outreach\?job_id=/, T)
    await page.getByText('To hello@brightdental.example').waitFor(T)
  })
  await step('approve-draft', async () => {
    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    await page.getByRole('button', { name: 'Send now' }).waitFor(T)
  })
  await step('sender', async () => {
    await page.getByText('Not ready to send yet').waitFor(T)
    await page.getByPlaceholder('Your name, as recipients will see it').fill('Dana Smith')
    await page.getByPlaceholder(/Mailing address/).fill('1 Main St, Columbus, OH 43004, USA')
    await page.getByRole('button', { name: 'Save sender details' }).click()
    await page.getByRole('link', { name: 'Connect Gmail in Settings' }).waitFor(T)
  })
  await step('connect-gmail', async () => {
    await page.getByRole('link', { name: 'Connect Gmail in Settings' }).click()
    await page.waitForURL(/\/app\/settings#gmail/, T)
    await page.getByRole('link', { name: 'Connect Gmail', exact: true }).click() // simulated Google grant
    await page.waitForURL(/\/app\/settings\?gmail=connected/, T)
    await page.getByText('Gmail connected.').waitFor(T)
    assert.ok(await page.getByText('Gmail connected.').isVisible() && await page.locator('#gmail').evaluate(e => e.getBoundingClientRect().top < window.innerHeight), 'the confirmation is on screen, not below the fold')
  })
  await step('back-to-outreach', async () => {
    // The next step after connecting must be on the page itself, not only in the sidebar.
    await page.locator('main').getByRole('link', { name: /send your approved emails/i }).click()
    await page.waitForURL(/\/app\/outreach/, T)
    await page.getByText(/^Ready to send from dana@brightsmile\.example/).waitFor(T)
    // The card shows the footer that will be added, with the saved sender, and no stale missing-sender claim.
    await page.getByLabel('Added automatically when sent').filter({ hasText: 'Dana Smith' }).waitFor(T)
    assert.equal(await page.getByText(/Sending needs your name and mailing address/).count(), 0, 'no contradictory missing-sender note')
  })
  await step('send', async () => {
    await page.getByRole('button', { name: 'Send now' }).click()
    await page.getByText(/^sent/).first().waitFor(T)
  })
  assert.deepEqual(writes.filter(w => !w.startsWith('GET')), [
    'POST /api/scan/icp-from-url', 'POST /api/scan', `POST /api/leads/${C}/quarantine`, 'POST /api/outreach', 'POST /api/outreach/m1', 'PUT /api/outreach/settings', 'POST /api/outreach/m1',
  ], 'exactly the writes a user makes on this path (all stubbed)')
  console.log(`journey UI check passed: ${n} steps from website to sent, every step reached by a click on the page, no dead end, no chunk-load or page error`)
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
