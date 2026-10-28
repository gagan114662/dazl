// Rendered check for the Home readiness card on a brand-new account and on a finished one. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/readiness-new.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, every /api/* call stubbed in the
// browser (no scan, no key check, no email). It proves:
//   1. a new account (no searches, nothing set up) sees the card at the top of /app, above the setup steps, with every
//      step open: website and business details, buyer profile (brain), first play, AI key, lead sources, Gmail, sender;
//      each with its fix; only the daily limit (a fixed server cap) is reported as set; no empty "Your plays";
//   2. a finished account (all of it done, one search) sees no card at all;
//   3. loading Home writes nothing.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-ready-new-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const NEW = { profile: { business_name: '', sells: '', website: '', buyer: null }, usage: { plan: 'free', scans_used: 0, scan_limit: 10, has_key: false, trial: null }, jobs: [], outreach: { gmail: null, sender: null, daily_cap: 20, sent_24h: 0, account_sent_24h: 0 }, sources: { web_index: false, news: true, websites: true }, messages: [], campaigns: [] }
const DONE = { profile: { business_name: 'Bright Smile', sells: 'Online booking for dental practices', website: 'https://brightsmile.example', buyer: { summary: 'Independent dental practices', who: ['Practice owner'], industries: [], sizes: [], where: [], signals: [], exclude: [] } }, usage: { plan: 'free', scans_used: 1, scan_limit: 10, has_key: true, trial: null }, jobs: [{ id: 'a'.repeat(24), status: 'done', error: null, query: 'Dental practice owners in Ohio', business_name: '', csv_domain: null, created_at: 1761500000, finished_at: 1761500100, candidates: 5, verified: 2, needs_review: 1, dropped: 2, lead_count: 3, test_only: false }], outreach: { gmail: { email: 'dana@brightsmile.example', status: 'active' }, sender: { sender_name: 'Dana', postal_address: '1 Main St, Columbus, OH 43004, USA' }, daily_cap: 20, sent_24h: 0, account_sent_24h: 0 }, sources: { web_index: false, news: true, websites: true }, messages: [{ id: 'm1', lead_id: 'l1', status: 'sent' }], campaigns: [{ id: 'a'.repeat(24), qualification: { rejected: 1 } }] }
const b = await chromium.launch()
async function open(st) {
  const writes = []
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1100 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (m !== 'GET') writes.push(`${m} ${p}`)
    if (p === '/api/settings/profile') return json(st.profile)
    if (p === '/api/usage') return json(st.usage)
    if (p === '/api/scan/jobs') return json({ jobs: st.jobs })
    if (p === '/api/outreach/settings') return json(st.outreach)
    if (p === '/api/scan/sources') return json(st.sources)
    if (p === '/api/outreach') return json({ messages: st.messages })
    if (p === '/api/campaigns') return json({ campaigns: st.campaigns })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(base + '/app', { waitUntil: 'networkidle' })
  return { ctx, page, writes }
}
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
try {
  const n = await open(NEW)
  const row = id => n.page.getByTestId(`ready-${id}`)
  await row('site').waitFor({ timeout: 15000 })
  await n.page.getByText("What's your website?").waitFor()
  // The card is above the setup steps.
  const cardY = (await n.page.getByTestId('readiness-checklist').boundingBox()).y, setupY = (await n.page.getByText("What's your website?").boundingBox()).y
  assert.ok(cardY < setupY, 'the checklist is at the top, above the setup steps')
  const states = await n.page.locator('li[data-testid^="ready-"]').evaluateAll(e => e.map(x => [x.dataset.testid.slice(6), x.textContent.includes('✓') ? 'done' : 'open']))
  assert.deepEqual(states, [['site', 'open'], ['brain', 'open'], ['key', 'open'], ['sources', 'open'], ['play', 'open'], ['scan', 'open'], ['review', 'open'], ['gmail', 'open'], ['sender', 'open'], ['approved', 'open'], ['limit', 'done']])
  assert.equal(await n.page.getByTestId('ready-progress').textContent(), '1 of 11 done')
  // One next step: the first to-do, marked and with the only primary button.
  assert.deepEqual(await n.page.locator('li[data-next="true"]').evaluateAll(e => e.map(x => x.dataset.testid)), ['ready-site'])
  assert.equal(await row('site').getByTestId('next-step-tag').textContent(), 'Next step')
  assert.equal(await n.page.getByTestId('readiness-checklist').locator('.btn-primary').count(), 1)
  assert.equal(await row('brain').getByRole('link', { name: 'Build' }).getAttribute('href'), '/app?setup=brain')
  assert.equal(await row('play').getByRole('link', { name: 'Write a play' }).getAttribute('href'), '/app/leads')
  assert.equal(await row('gmail').getByRole('link', { name: 'Connect' }).getAttribute('href'), '/app/settings#gmail')
  assert.equal(await row('sources').getByRole('link', { name: 'Add key' }).getAttribute('href'), '/app/settings#model-key')
  assert.equal(await row('site').getByRole('button', { name: 'Add' }).count(), 1)
  assert.equal(await n.page.getByText('Your plays').count(), 0, 'no empty plays list')
  assert.deepEqual(n.writes, [], 'loading Home writes nothing')
  await shot(n.page, 'new-account')
  await n.ctx.close()

  const d = await open(DONE)
  await d.page.getByRole('list', { name: 'Your plays' }).waitFor({ timeout: 15000 })
  assert.equal(await d.page.getByTestId('readiness-checklist').count(), 0, 'finished account: no card')
  assert.equal(await d.page.getByText('Before your first scan and send').count(), 0)
  assert.equal(await d.page.getByText("What's your website?").count(), 0, 'not the setup steps')
  // Hidden, not lost: one line says all steps are done, and Show it reopens the finished checklist.
  assert.equal(await d.page.getByTestId('ready-all-done').textContent(), 'Setup checklist: all 11 steps done. Show it')
  await d.page.getByTestId('ready-all-done').getByRole('button', { name: 'Show it' }).click()
  await d.page.getByTestId('readiness-checklist').waitFor()
  assert.equal(await d.page.getByTestId('ready-progress').textContent(), '11 of 11 done')
  assert.equal(await d.page.locator('li[data-next="true"]').count(), 0)
  assert.deepEqual(d.writes, [])
  await shot(d.page, 'finished-account')
  await d.ctx.close()
  console.log('readiness new/finished UI check passed: new account sees every step open at the top; finished account sees no card; no writes')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
