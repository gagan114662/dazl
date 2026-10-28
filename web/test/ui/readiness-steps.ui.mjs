// Rendered check for the Home checklist's Pancake path: first scan, leads reviewed, first email approved in Outreach,
// one highlighted next step, and "?" with the reason when a read fails. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/readiness-steps.ui.mjs   (SHOTS=<dir> saves screenshots; BEFORE_ONLY=1
// only takes them). Real production build, throwaway database, server under test/helpers/net-fence.ts, and EVERY /api/*
// CALL ANSWERED FROM A STUB in the browser: nothing is scanned, drafted or sent. It proves, for an account whose setup is
// done:
//   1. a running scan: First scan is the next step with "See progress";
//   2. a finished scan, nothing reviewed: First scan is done with its outcome, Leads reviewed is the next step with one
//      primary "Review leads" button linking to that scan;
//   3. a draft made: Leads reviewed done, "First email approved in Outreach" is next ("a draft is waiting"), Open Outreach;
//   4. the emails read fails: those rows show "?" with "your emails did not load", never a check, and are not "next";
//   5. the newest-200 email list is not treated as complete history: a full list without evidence is "?";
//   6. 20 recent failed scans hiding an older finished scan and play: both read done from the complete totals;
//   7. nothing is written.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-readysteps-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const JOB = 'b'.repeat(24)
const st = { jobStatus: 'running', messages: [], emailsFail: false, campaignsFail: false, boundary: false }
const profile = { business_name: 'Bright Smile', sells: 'Online booking for dental practices', website: 'https://brightsmile.example', buyer: { summary: 'Independent dental practices', who: ['Practice owner'], industries: [], sizes: [], where: [], signals: [], exclude: [] } }
const writes = []
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 1300 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
  if (u.origin !== base) return route.abort()
  if (!p.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (m !== 'GET') writes.push(`${m} ${p}`)
  if (p === '/api/settings/profile') return json(profile)
  if (p === '/api/usage') return json({ plan: 'free', scans_used: 1, scan_limit: 10, has_key: true, trial: null })
  if (p === '/api/settings/llm-key') return json({ keys: [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1 }], rejection: null })
  if (p === '/api/scan/sources') return json({ web_index: true, news: true, websites: true })
  // Instinct #288 boundary: the newest-20 list holds 20 failed scans; an older play finished. Only totals know it.
  if (p === '/api/scan/jobs' && st.boundary) return json({ jobs: Array.from({ length: 20 }, (_, k) => ({ id: String(k).padStart(24, 'f'), status: 'failed', error: 'upstream 502', query: `Failed search ${k}`, business_name: '', csv_domain: null, created_at: 1761600000 + k, finished_at: 1761600001 + k, candidates: null, verified: null, needs_review: null, dropped: null, lead_count: 0, test_only: false })), totals: { searches: 21, finished: 1 } })
  if (p === '/api/scan/jobs') return json({ jobs: [{ id: JOB, status: st.jobStatus, error: null, query: 'Dental practice owners in Ohio', business_name: '', csv_domain: null, created_at: 1761500000, finished_at: 1761500100, candidates: 5, verified: 2, needs_review: 1, dropped: 2, lead_count: 3, test_only: false }] })
  if (p === '/api/outreach/settings') return json({ gmail: { email: 'dana@brightsmile.example', status: 'active' }, sender: { sender_name: 'Dana', postal_address: '1 Main St, Columbus, OH 43004, USA' }, daily_cap: 20, sent_24h: 0, account_sent_24h: 0 })
  if (p === '/api/outreach') return st.emailsFail ? json({ error: 'unavailable' }, 503) : json({ messages: st.messages })
  if (p === '/api/campaigns') return st.campaignsFail ? json({ error: 'unavailable' }, 503) : json({ campaigns: [{ id: JOB, qualification: { rejected: 0 } }] })
  return json({}, 404)
})
const page = await ctx.newPage()
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
const row = id => page.getByTestId(`ready-${id}`)
const nextIds = () => page.locator('li[data-next="true"]').evaluateAll(e => e.map(x => x.dataset.testid))
const load = async () => { await page.goto(base + '/app', { waitUntil: 'networkidle' }); await page.getByTestId('setup-details').evaluate(d => { d.open = true }, null, { timeout: 15000 }); await page.getByTestId('readiness-checklist').waitFor({ timeout: 15000 }) }
const before = process.env.BEFORE_ONLY === '1'
try {
  await load(); await shot('1-running')
  if (!before) {
    assert.deepEqual(await nextIds(), ['ready-scan'])
    assert.match(await row('scan').textContent(), /First scan - running now/)
    assert.equal(await row('scan').getByRole('link', { name: 'See progress' }).getAttribute('href'), '/app/leads')
  }
  st.jobStatus = 'done'; await load(); await shot('2-review-next')
  if (!before) {
    assert.match(await row('scan').textContent(), /✓First scan - 1 finished; latest: 2 source-checked, 1 needs your review/)
    assert.deepEqual(await nextIds(), ['ready-review'])
    assert.equal(await row('review').getByTestId('next-step-tag').textContent(), 'Next step')
    const btn = row('review').getByRole('link', { name: 'Review leads' })
    assert.equal(await btn.getAttribute('href'), `/app/leads?job_id=${JOB}`)
    assert.match(await btn.getAttribute('class'), /btn-primary/)
    assert.equal(await page.getByTestId('readiness-checklist').locator('.btn-primary').count(), 1, 'one primary button: the next step')
  }
  st.messages = [{ id: 'm1', lead_id: 'l1', status: 'draft' }]; await load(); await shot('3-approve-next')
  if (!before) {
    assert.match(await row('review').textContent(), /✓Leads reviewed - leads approved into drafts/)
    assert.deepEqual(await nextIds(), ['ready-approved'])
    assert.match(await row('approved').textContent(), /First email approved in Outreach - a draft is waiting for your review/)
    assert.equal(await row('approved').getByRole('link', { name: 'Open Outreach' }).getAttribute('href'), '/app/outreach')
  }
  st.emailsFail = true; await load(); await shot('4-emails-failed')
  if (!before) {
    for (const id of ['review', 'approved']) {
      assert.match(await row(id).textContent(), /^\?.* - could not check - your emails did not load/, `${id}: "?" with the reason`)
      assert.equal(await row(id).getByText('✓').count(), 0, `${id}: never a check when the read failed`)
    }
    assert.deepEqual(await nextIds(), [], 'nothing to press: no next step is invented')
  }
  // Instinct #285: the email list is capped at the newest 200. A full list without any approved email proves nothing.
  st.emailsFail = false; st.messages = Array.from({ length: 200 }, (_, k) => ({ id: `m${k}`, lead_id: `l${k}`, status: 'skipped' }))
  await load(); await shot('5-capped-list')
  if (!before) {
    for (const id of ['review', 'approved']) assert.match(await row(id).textContent(), /^\?.* - could not check - only your latest 200 emails could be checked/, `${id}: a capped list is not complete history`)
    assert.deepEqual(await nextIds(), [])
  }
  // Instinct #288: 20 recent failed scans hide an older finished one. Home must not say "no scan has finished yet".
  st.emailsFail = false; st.messages = []; st.boundary = true
  await load(); await shot('6-twenty-failures')
  if (!before) {
    assert.match(await row('scan').textContent(), /^✓First scan - 1 finished$/)
    assert.doesNotMatch(await page.getByTestId('readiness-checklist').textContent(), /no scan has finished yet/)
    assert.match(await row('play').textContent(), /^✓First play - 21 searches written$/)
  }
  assert.deepEqual(writes, [], 'loading Home writes nothing')
  console.log(before ? 'screenshots taken (BEFORE_ONLY)' : 'readiness steps UI check passed: running scan, review and approve steps each become the single next step; failed reads show "?" with the reason; no writes')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
