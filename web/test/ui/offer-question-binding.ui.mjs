// #379 offer-selection mapping: when the research block asks "Which of your offers is this play for?", clicking an
// offer must bind THIS play's offer - the field the run sends and the server binds corrections with - not only record
// the answer in the block. Proven on both surfaces that show the question:
//   A) first-run wizard: the pick lands in the visible "What you sell" field;
//   B) Leads draft editor: the pick lands in #play-offer and the confirmed run POSTs it with the answer in the block.
// NOT part of `npm test`. Run:  cd web && npm run build && node test/ui/offer-question-binding.ui.mjs
// (SHOTS=<dir> saves screenshots). Production build, throwaway database, server under test/helpers/net-fence.ts,
// EVERY /api/* call stubbed in the browser. Exit 1 on a failed expectation; exit 2 when it cannot run
// (SMOKE_ALLOW_SKIP=1 makes that exit 0).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import path from 'node:path'
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(dir, 'package.json'))
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? (process.exit(0), '') : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
let chromium
try { ({ chromium } = require('playwright')) } catch (e) { notRun(e.message.split('\n')[0]) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const Database = require('better-sqlite3'); const { createHash, randomBytes } = require('crypto')
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-offerbind-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const SITE = 'https://acme.example/products/booking'
const RESEARCH = { v: 1, site: 'acme.example', q: 'Which of your offers is this play for?', ans: null,
  offers: [{ i: 'booking', n: 'Acme Booking' }, { i: 'reminders', n: 'Acme Reminders' }],
  hyps: [
    { i: 'h1', o: 'booking', k: 'persona', t: 'practice managers', s: 'sourced', u: SITE, q: 'lets practice managers fill their appointment book', at: 1800000000 },
    { i: 'h2', o: 'reminders', k: 'persona', t: 'front-desk leads', s: 'sourced', u: SITE, q: 'helps front-desk leads cut no-shows', at: 1800000000 },
  ] }
const READ = { source: 'https://acme.example/', sells: 'Acme Booking and Acme Reminders',
  icp: { summary: 'Dental practices that need booking software.', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [], research: RESEARCH } }
const row = (id, label, provider, unit_usd, note, usd, capped = false) => ({ id, label, provider, kind: capped ? 'model' : 'search', unit: 'u', unit_usd, units: { min: 1, max: 1 }, usd, capped, note })
const EST = { estimate: { rows: [row('extraction', 'Candidate extraction', 'AI model', '$3.00 in / $15.00 out per 1M tokens (claude-sonnet-4-5)', '1-3 call(s)', { min: 0.05, max: 0.4 }, true)],
  total: { min: 0.05, max: 0.4 }, unpriced: [], assumptions: ['Model: claude-sonnet-4-5.'], payer: 'you',
  cap: { max_usd: 0.5, reserved_usd: 0, remaining_usd: 0.5, binding: 'daily', month_cap_usd: null, month_reserved_usd: 0, unknown: false, capped_total: { min: 0.05, max: 0.4 } },
  verdict: { ok: true, reason: null, message: 'Within your limit.', change: [], warning: null }, ack: 'ack1' } }

const b = await chromium.launch()
const scanBodies = []
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
  if (u.origin !== base) return route.abort()
  if (!p.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (p === '/api/usage') return json({ plan: 'pro', scans_used: 1, scan_limit: 10, has_key: true, trial: null })
  if (p === '/api/settings/advanced') return json({ available: true, platforms: [] })
  if (p === '/api/settings/profile') return json({ business_name: '', sells: '', website: '', buyer: null })
  if (p === '/api/scan/jobs') return json({ jobs: [] })
  if (p === '/api/scan/icp-from-url') return json(READ)
  if (p === '/api/scan/estimate' && m === 'POST') return json(EST)
  if (p === '/api/scan' && m === 'POST') { scanBodies.push(JSON.parse(req.postData())); return json({ job_id: 'b'.repeat(24) }, 202) }
  if (p === '/api/scan/status') return json({ status: 'pending', lead_count: 0, attempts: 0, max_attempts: 3 })
  return json({}, 404)
})
const page = await ctx.newPage()
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) }
try {
  // A) first-run wizard: the pick lands in the visible "What you sell" field.
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  await page.getByTestId('site-step').waitFor({ timeout: 15000 })
  await page.getByLabel('Your website').fill('acme.example')
  await page.getByRole('button', { name: 'Read my site' }).click()
  await page.getByTestId('ready-step').waitFor({ timeout: 20000 })
  await page.getByRole('button', { name: 'Edit what dazl inferred' }).click()
  const wizBlock = page.getByTestId('research-review')
  await wizBlock.waitFor({ timeout: 10000 })
  await wizBlock.getByTestId('research-offer-pick-reminders').click()
  const sells = page.getByLabel('What you sell')
  for (let i = 0; i < 50 && (await sells.inputValue()) !== 'Acme Reminders'; i++) await page.waitForTimeout(100)
  assert.equal(await sells.inputValue(), 'Acme Reminders', 'first-run: the offer pick lands in the visible What you sell field')
  await sells.scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  await shot('offer-question-first-run')

  // B) Leads draft editor: the pick lands in #play-offer and the confirmed run POSTs it, with the answer in the block.
  await page.goto(`${base}/app/leads`, { waitUntil: 'networkidle' })
  await page.getByTestId('play-settings').locator('summary').first().click()
  await page.getByTestId('more-sources').locator('summary').first().click()
  await page.getByPlaceholder('Your website - we will fill the profile from it').fill('acme.example')
  await page.getByRole('button', { name: 'Fill from my website' }).click()
  const block = page.getByTestId('research-review')
  await block.waitFor({ timeout: 10000 })
  await block.getByTestId('research-offer-pick-reminders').click()
  const offerInput = page.locator('#play-offer')
  for (let i = 0; i < 50 && (await offerInput.inputValue()) !== 'Acme Reminders'; i++) await page.waitForTimeout(100)
  assert.equal(await offerInput.inputValue(), 'Acme Reminders', 'leads: the offer pick lands in the play offer field')
  await offerInput.scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  await shot('offer-question-leads')
  await page.getByRole('button', { name: 'Run scan with this profile' }).last().click()
  await page.getByTestId('estimate-confirm').waitFor()
  await page.getByTestId('estimate-confirm-run').click()
  for (let i = 0; i < 50 && scanBodies.length === 0; i++) await page.waitForTimeout(100)
  assert.equal(scanBodies.length, 1, 'exactly one scan started')
  assert.equal(scanBodies[0].offer, 'Acme Reminders', 'the run carries the picked offer as the play offer')
  assert.deepEqual(scanBodies[0].icp.research.ans, { q: 'Which of your offers is this play for?', o: 'reminders' }, 'the answer persists in the block with the picked offer id')
  console.log('PASS offer-question-binding: the offer pick binds the play offer on both surfaces and the run carries it')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
