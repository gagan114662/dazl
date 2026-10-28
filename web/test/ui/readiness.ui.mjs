// Rendered check for the Home readiness checklist. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/readiness.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts. /api/settings/profile goes to the
// REAL route; every other /api/* call is answered from a stub in the browser (no key check, no Gmail, no scan, no email).
// It proves:
//   1. an account that has searched sees the checklist (not the first-run flow): website and business brain, first play,
//      AI key, lead sources, Gmail, sender, daily sending limit, with "n of 7 done"; lead sources reads the server's
//      source switches (GET /api/scan/sources) and the key (capability wording: what a scan can use, never "searched";
//      without a key it says a scan cannot start), and turns done once a key makes web research usable;
//   2. each missing item has its fix in place: business and sender save inline, the key is one inline field, and Gmail
//      links to Settings (where its consent text is) - Home never starts the Google grant itself;
//   3. after each inline fix the row turns done from re-read server state;
//   4. "Your plays" lists own searches newest first with their outcome, linked to their leads: source-checked and
//      needs-review counts separately (a done search with 0 verified / 5 needing review never reads "5 leads"), old
//      records without counts say "counts unavailable" (never leads), cancelled runs say "cancelled";
//   5. once every step is done (Gmail connected, from the stubbed status) the checklist is hidden and the plays stay;
//   7. if the source check fails, that row says "could not check" and the checklist stays up (never counted as done);
//   6. all steps done but the daily limit used up: the checklist stays hidden and Home still says why sending stopped.
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import path from 'node:path'
const dir = process.env.WEB_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(dir, 'package.json'))
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? ' (allowed by SMOKE_ALLOW_SKIP=1)' : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
let chromium
try { ({ chromium } = require('playwright')) } catch (e) { notRun(e.message.split('\n')[0]) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const Database = require('better-sqlite3'); const { createHash, randomBytes } = require('crypto')
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-ready-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const now = Math.floor(Date.now() / 1000)
const job = (id, query, created_at, o = {}) => ({ id: id.repeat(24), status: 'done', error: null, query, business_name: '', csv_domain: null, created_at, finished_at: created_at, candidates: 5, verified: 2, needs_review: 1, dropped: 2, lead_count: 3, test_only: false, ...o })
const JOBS = [
  job('a', 'Dental practice owners in Ohio - opened a new location', now - 3000, { verified: 2, needs_review: 1 }),
  // The real NYC shape from Instinct's review: done, five leads, none source-checked.
  job('b', 'Clinic administrators in NYC - hiring front-desk staff', now - 1000, { lead_count: 5, verified: 0, needs_review: 5 }),
  job('c', 'Orthodontists in Austin', now - 500, { status: 'failed', error: 'no_candidates', lead_count: 0 }),
  job('e', 'Old search from before the counts', now - 4000, { verified: null, needs_review: null, candidates: null, dropped: null }),
  job('f', 'Cancelled search', now - 200, { status: 'failed', error: 'cancelled', lead_count: 0 }),
  job('d', null, now - 100, { csv_domain: 'acme.com' }),
]
const state = { hasKey: false, sender: null, gmail: null, sent: 0, sourcesFail: false }
const writes = []
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
  if (u.origin !== base) return route.abort()
  if (!p.startsWith('/api/')) return route.continue()
  if (m !== 'GET') writes.push(`${m} ${p}`)
  if (p === '/api/settings/profile') return route.continue() // the real route and its temporary database
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (p === '/api/scan/jobs') return json({ jobs: JOBS })
  if (p === '/api/usage') return json({ plan: 'free', scans_used: 3, scan_limit: 10, has_key: state.hasKey, trial: state.hasKey ? null : { funded: true, remaining: 0, cap: 3 } })
  if (p === '/api/settings/llm-key' && m === 'PUT') { state.hasKey = true; return json({ ok: true, vendor: 'anthropic', last4: 'abcd' }) }
  // This server has no search index, news or website reads switched on: only web research with a key is possible.
  if (p === '/api/scan/sources') return state.sourcesFail ? json({ error: 'unavailable' }, 503) : json({ web_index: false, news: false, websites: false })
  if (p === '/api/outreach/settings' && m === 'GET') return json({ gmail: state.gmail, sender: state.sender, daily_cap: 20, sent_24h: Math.min(state.sent, 12), account_sent_24h: state.sent })
  if (p === '/api/outreach/settings' && m === 'PUT') { state.sender = JSON.parse(req.postData()); return json({ ok: true }) }
  return json({}, 404)
})
const page = await ctx.newPage()
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
const row = id => page.getByTestId(`ready-${id}`)
try {
  await page.goto(base + '/app', { waitUntil: 'networkidle' })
  if (process.env.BEFORE_ONLY) { await page.waitForTimeout(800); await shot('home'); console.log('before shot'); process.exit(0) }
  await row('site').waitFor({ timeout: 15000 })
  await shot('home')
  assert.equal(await page.getByText("What's your website?").count(), 0, 'not the first-run flow')
  assert.deepEqual(await page.locator('li[data-testid^="ready-"]').evaluateAll(e => e.map(x => x.dataset.testid)), ['ready-site', 'ready-brain', 'ready-play', 'ready-key', 'ready-sources', 'ready-gmail', 'ready-sender', 'ready-limit'])
  assert.equal(await page.getByTestId('ready-progress').textContent(), '2 of 8 done')
  assert.match(await row('site').textContent(), /Website and business details - missing business name, what you sell, website/)
  assert.match(await row('brain').textContent(), /Buyer profile \(who buys from you\) - not built yet/)
  assert.equal(await row('brain').getByRole('link', { name: 'Build' }).getAttribute('href'), '/app?setup=brain')
  assert.match(await row('play').textContent(), /First play - 5 searches written/)
  assert.match(await row('key').textContent(), /AI key - needed for searches/)
  assert.match(await row('sources').textContent(), /Lead sources - a scan cannot start until you add an AI key/)
  assert.equal(await row('sources').getByRole('link', { name: 'Add key' }).getAttribute('href'), '/app/settings#model-key')
  assert.match(await row('gmail').textContent(), /Gmail - not connected/)
  assert.equal(await row('gmail').getByRole('link', { name: 'Connect' }).getAttribute('href'), '/app/settings#gmail')
  assert.match(await row('sender').textContent(), /Sender name and mailing address - added to every email; required before sending/)
  assert.match(await row('limit').textContent(), /Daily sending limit - up to 20 emails a day; 0 sent in the last 24 hours/)
  assert.deepEqual(writes, [], 'nothing written by loading Home')

  // Plays: own searches newest first with their outcome; the CSV import is not a play.
  const plays = page.getByRole('list', { name: 'Your plays' }).getByRole('listitem')
  assert.deepEqual(await plays.allTextContents(), [
    'Cancelled searchcancelled',
    'Orthodontists in Austinfailed',
    'Clinic administrators in NYC - hiring front-desk staff0 source-checked, 5 need your review',
    'Dental practice owners in Ohio - opened a new location2 source-checked, 1 needs your review',
    'Old search from before the counts' + 'counts unavailable',
  ])
  assert.doesNotMatch(await page.getByRole('list', { name: 'Your plays' }).textContent(), /\bleads?\b/, 'no play is reported as leads: only checked / to-review counts, or counts unavailable')
  assert.equal(await plays.nth(2).getByRole('link').getAttribute('href'), `/app/leads?job_id=${'b'.repeat(24)}`)

  // Inline fixes; each row turns done from re-read state.
  await row('site').getByRole('button', { name: 'Add' }).click()
  await page.getByLabel('Business name').fill('Bright Smile Software')
  await page.getByLabel('Your website').fill('brightsmile.example')
  await page.getByLabel('What you sell').fill('Online booking for dental practices')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await row('site').getByText('✓').waitFor()
  assert.match(await row('site').textContent(), /Bright Smile Software - Online booking for dental practices \(brightsmile\.example\)/)
  await row('key').getByRole('button', { name: 'Add key' }).click()
  await page.getByLabel('Your AI key').fill('sk-ant-api03-' + 'x'.repeat(30)); await page.getByRole('button', { name: 'Save key' }).click()
  await row('key').getByText('✓').waitFor()
  await row('sources').getByText('✓').waitFor()
  assert.match(await row('sources').textContent(), /Lead sources - a scan can use Web research with your AI key/)
  await row('sender').getByRole('button', { name: 'Add' }).click()
  await page.getByPlaceholder('Your name, as recipients will see it').fill('Dana Smith'); await page.getByPlaceholder(/Mailing address/).fill('1 Main St, Columbus, OH 43004, USA')
  await page.getByRole('button', { name: 'Save sender details' }).click()
  await row('sender').getByText('✓').waitFor()
  // Brain: Build reopens the Home setup steps at the buyer profile; saving there (real profile route) turns the row done.
  await row('brain').getByRole('link', { name: 'Build' }).click()
  await page.waitForURL('**/app?setup=brain')
  await page.getByText("Here's what we think you sell and who buys it").waitFor()
  await page.getByLabel('Who buys it').fill('Independent dental practices with 2-10 chairs')
  await page.getByRole('button', { name: 'Looks right, continue' }).click()
  await row('brain').getByText('✓').waitFor()
  assert.match(await row('brain').textContent(), /Independent dental practices with 2-10 chairs/)
  await page.goto(base + '/app', { waitUntil: 'networkidle' })
  await row('brain').getByText('✓').waitFor()
  await shot('after-fixes')
  assert.equal(await row('gmail').getByText('✓').count(), 0, 'Gmail stays a to-do until connected in Settings')
  assert.deepEqual(writes, ['POST /api/settings/profile', 'PUT /api/settings/llm-key', 'PUT /api/outreach/settings', 'POST /api/settings/profile'])
  assert.equal(await page.getByTestId('ready-progress').textContent(), '7 of 8 done')

  // Gmail connected (in Settings; here the stubbed status says so): everything is done, so the checklist goes away.
  state.gmail = { email: 'dana@brightsmile.example', status: 'active' }
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('list', { name: 'Your plays' }).waitFor()
  assert.equal(await page.getByTestId('readiness-checklist').count(), 0, 'all done: checklist hidden')
  assert.equal(await page.getByText('Before your first scan and send').count(), 0)
  assert.equal(await page.getByTestId('cap-notice').count(), 0, 'no limit notice under the cap')
  await shot('all-done')

  // Same finished setup, but today's sends (first touches plus follow-ups) reached the cap: Home says so.
  state.sent = 20
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByTestId('cap-notice').waitFor()
  assert.equal(await page.getByTestId('readiness-checklist').count(), 0, 'checklist still hidden: every step is done')
  assert.match(await page.getByTestId('cap-notice').textContent(), /^Today's 20-email limit is used up \(20 sent in the last 24 hours\)\. Sending resumes as those sends pass 24 hours old\./)
  assert.equal(await page.getByTestId('cap-notice').getByRole('link', { name: 'Outreach' }).getAttribute('href'), '/app/outreach')
  await shot('cap-used-up')

  // The source check fails: that row is "could not check", so the checklist comes back instead of reading complete.
  state.sent = 0; state.sourcesFail = true
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByTestId('readiness-checklist').waitFor()
  assert.match(await row('sources').textContent(), /Lead sources - could not check/)
  assert.equal(await row('sources').getByText('✓').count(), 0)
  assert.equal(await page.getByTestId('ready-progress').textContent(), '7 of 8 done')
  await shot('sources-unknown')
  console.log('readiness UI check passed:', writes.join(', '))
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
