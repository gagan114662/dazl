// The website-research review block (#379) in the Leads draft editor ("Fill from my website"). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/leads-research-review.ui.mjs   (SHOTS=<dir> saves screenshots)
// Production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed in the
// browser: no site is fetched, no model is called, no scan runs. It proves:
//   1. the returned research block renders in the draft editor with quotes/URLs and inferred marks;
//   2. Add lands the statement in the matching draft field, Dismiss hides it, the typed answer lands in Who;
//   3. the run's POST /api/scan carries the reviewed draft: rejection and the typed answer WITH ITS WORDS in the
//      research block, plus the play's offer - after the price estimate is shown and confirmed.
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
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? (process.exit(0), '') : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
let chromium
try { ({ chromium } = require('playwright')) } catch (e) { notRun(e.message.split('\n')[0]) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const Database = require('better-sqlite3'); const { createHash, randomBytes } = require('crypto')
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-leads-research-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const SITE = 'https://acme.example/products/booking'
const RESEARCH = { v: 1, site: 'acme.example', q: 'Who buys this?', ans: null,
  offers: [{ i: 'o1', n: 'Acme Booking' }],
  hyps: [
    { i: 'h1', o: 'o1', k: 'persona', t: 'practice managers', s: 'sourced', u: SITE, q: 'lets practice managers fill their appointment book', at: 1800000000 },
    { i: 'h2', o: 'o1', k: 'persona', t: 'front-desk leads', s: 'sourced', u: SITE, q: 'helps front-desk leads cut no-shows', at: 1800000000 },
    { i: 'h3', o: 'o1', k: 'industry', t: 'Dental', s: 'inferred', u: null, q: null, at: null },
    { i: 'h5', o: 'o1', k: 'persona', t: 'scheduling coordinators', s: 'reviewed', u: SITE, q: 'scheduling coordinators fill their book', at: 1800000000 },
  ] }
const READ = { source: 'https://acme.example/', sells: 'Acme Booking',
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
  if (p === '/api/settings/profile') return json({ business_name: 'Acme', sells: null, website: 'acme.example', buyer: null }) // no profile offer: only the read's sells line can fill the play offer
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
  await page.goto(`${base}/app/leads`, { waitUntil: 'networkidle' })
  await page.getByTestId('play-settings').locator('summary').first().click() // the website fill lives under Settings for this play > More sources
  await page.getByTestId('more-sources').locator('summary').first().click()
  await page.getByPlaceholder('Your website - we will fill the profile from it').fill('acme.example')
  await page.getByRole('button', { name: 'Fill from my website' }).click()
  const block = page.getByTestId('research-review')
  await block.waitFor({ timeout: 10000 })
  const card = page.locator('.card', { has: block })
  const who = card.locator('textarea').nth(1) // after the summary textarea: who, then the other fields
  await shot('leads-draft-research-review')

  // 1. Statements render with quotes/URLs; inferred marked.
  const h1 = page.getByTestId('hyp-h1'), h2 = page.getByTestId('hyp-h2'), h3 = page.getByTestId('hyp-h3')
  assert.match(await h1.innerText(), /lets practice managers fill their appointment book/, 'h1 shows the page quote')
  assert.equal(await h1.locator(`a[href="${SITE}"]`).count(), 1, 'h1 links its page')
  assert.match(await h3.innerText(), /inferred - not stated on your site/, 'h3 marked inferred')
  const h5 = page.getByTestId('hyp-h5')
  assert.match(await h5.innerText(), /on your site: .scheduling coordinators fill their book./, 'a CONFIRMED statement keeps its real quote, never the inferred label')
  assert.ok(!/inferred/.test(await h5.innerText()), 'a confirmed statement with a quote is never labelled inferred')
  assert.equal(await h5.locator(`a[href="${SITE}"]`).count(), 1, 'a confirmed statement keeps its page link')

  // 2. Add, Dismiss, typed answer - all land in the visible draft.
  await h1.getByRole('button', { name: 'Add' }).click()
  for (let i = 0; i < 50 && !(await who.inputValue()).includes('practice managers'); i++) await page.waitForTimeout(100)
  assert.match(await who.inputValue(), /practice managers/, 'Add lands the statement in the Who field')
  await h2.getByRole('button', { name: 'Dismiss' }).click()
  assert.equal(await page.getByTestId('hyp-h2').count(), 0, 'dismissed statement hidden')
  const q = page.getByTestId('research-question')
  await q.locator('input').fill('office managers')
  await q.getByRole('button', { name: 'Save' }).click()
  for (let i = 0; i < 50 && !(await who.inputValue()).includes('office managers'); i++) await page.waitForTimeout(100)
  assert.match(await who.inputValue(), /office managers/, 'typed answer lands in the Who field')
  await shot('leads-draft-research-reviewed')

  // 3. Estimate, confirm, run: the POST carries the reviewed draft with the answer's words and the play's offer.
  // #379: the play's offer is prefilled after a site read - request first, then the business profile (null in this
  // fixture), then the read's generated sells line - so the required field is never left empty by a generation.
  // It stays the person's input; here the prefilled default is what runs.
  const offerInput = page.locator('#play-offer')
  for (let i = 0; i < 50 && (await offerInput.inputValue()) !== 'Acme Booking'; i++) await page.waitForTimeout(100)
  assert.equal(await offerInput.inputValue(), 'Acme Booking', 'the play offer is prefilled from the site read sells line, not left empty')
  await offerInput.scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  await shot('leads-draft-offer-prefilled')
  await page.getByRole('button', { name: 'Run scan with this profile' }).last().click()
  await page.getByTestId('estimate-confirm').waitFor()
  await page.getByTestId('estimate-confirm-run').click()
  for (let i = 0; i < 50 && scanBodies.length === 0; i++) await page.waitForTimeout(100)
  assert.equal(scanBodies.length, 1, 'exactly one scan started')
  const sent = scanBodies[0]
  assert.equal(sent.estimate_ack, 'ack1', 'the run carries the confirmed estimate')
  assert.equal(sent.offer, 'Acme Booking', 'the play offer goes with the run')
  assert.deepEqual(sent.icp.who, ['practice managers', 'office managers'], 'Who is exactly the reviewed draft')
  const hyps = Object.fromEntries(sent.icp.research.hyps.map(h => [h.i, h]))
  assert.equal(hyps.h2.s, 'rejected', 'the dismissal is an explicit rejection')
  assert.equal(hyps.h1.s, 'sourced', 'un-acted statement keeps its truth status')
  assert.deepEqual(sent.icp.research.ans, { q: 'Who buys this?', o: 'o1', t: 'office managers' }, 'the typed answer goes WITH ITS WORDS')
  console.log('PASS leads-research-review: render, add, dismiss, answer, prefilled play offer, estimated run carries the reviewed draft')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
