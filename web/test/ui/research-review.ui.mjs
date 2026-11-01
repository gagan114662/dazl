// The website-research review block (#379) on the first-run brain step. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/research-review.ui.mjs   (SHOTS=<dir> saves screenshots)
// Production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed in the
// browser: no site is fetched, no model is called, no scan runs. It proves:
//   1. the read's research block renders on the brain step: each statement with its kind, quote and page URL,
//      inferred hypotheses marked as inferred;
//   2. "Add" puts the statement into the matching visible profile field (the person's edit, in their words);
//   3. "Dismiss" hides the statement and records an explicit rejection that is SAVED with the profile;
//   4. the targeting question takes a typed answer into the Buyer roles field, and the saved profile carries the
//      answer and the reviewed research block (rejection + answer survive the save POST).
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-research-review-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
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
    { i: 'h4', o: 'o1', k: 'persona', t: 'clinic owners', s: 'sourced', u: SITE, q: 'clinic owners fill their book', at: 1800000000 },
  ] }
const READ = { source: 'https://acme.example/', sells: 'Acme Booking',
  icp: { summary: 'Dental practices that need booking software.', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [], research: RESEARCH } }

const b = await chromium.launch()
const profileBodies = []
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
  if (u.origin !== base) return route.abort()
  if (!p.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (p === '/api/scan/icp-from-url') return json(READ)
  if (p === '/api/settings/profile' && m === 'POST') { profileBodies.push(JSON.parse(req.postData())); return json({ ok: true }) }
  if (p === '/api/settings/profile') return json({ business_name: '', sells: '', website: '', buyer: null })
  if (p === '/api/scan/jobs') return json({ jobs: [] })
  if (p === '/api/usage') return json({ plan: 'free', scans_used: 0, scan_limit: 10, has_key: true, trial: null })
  return json({}, 404)
})
const page = await ctx.newPage()
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) }
try {
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  // Site step -> read -> ready, then open the editor where the research block lives.
  await page.getByTestId('site-step').waitFor({ timeout: 15000 })
  await page.getByLabel('Your website').fill('acme.example')
  await page.getByRole('button', { name: 'Read my site' }).click()
  await page.getByTestId('ready-step').waitFor({ timeout: 20000 })
  await page.getByRole('button', { name: 'Edit what dazl inferred' }).click()
  const block = page.getByTestId('research-review')
  await block.waitFor({ timeout: 10000 })
  await shot('research-review-brain-step')

  // 1. Every statement renders with its kind; sourced ones carry quote and page URL, inferred ones are marked.
  const h1 = page.getByTestId('hyp-h1'), h2 = page.getByTestId('hyp-h2'), h3 = page.getByTestId('hyp-h3')
  assert.ok(await h1.isVisible(), 'sourced persona h1 renders')
  assert.match(await h1.innerText(), /buyer: practice managers/, 'h1 shows its kind and text')
  assert.match(await h1.innerText(), /lets practice managers fill their appointment book/, 'h1 shows the page quote')
  assert.equal(await h1.locator(`a[href="${SITE}"]`).count(), 1, 'h1 links the page it came from')
  assert.match(await h3.innerText(), /inferred - not stated on your site/, 'h3 is marked inferred, with no invented source')
  const h5 = page.getByTestId('hyp-h5')
  assert.match(await h5.innerText(), /on your site: .scheduling coordinators fill their book./, 'a CONFIRMED statement keeps its real quote, never the inferred label')
  assert.ok(!/inferred/.test(await h5.innerText()), 'a confirmed statement with a quote is never labelled inferred')
  assert.equal(await h5.locator(`a[href="${SITE}"]`).count(), 1, 'a confirmed statement keeps its page link')

  // 2. Add puts the statement into the visible profile field.
  const who = page.getByLabel(/Buyer roles/)
  await h1.getByRole('button', { name: 'Add' }).click()
  await page.waitForFunction(() => document.querySelector('input.field[maxlength="400"], label:has(> input)') && [...document.querySelectorAll('label')].find(l => l.textContent.includes('Buyer roles'))?.querySelector('input')?.value.includes('practice managers'), null, { timeout: 5000 })
  assert.match(await who.inputValue(), /practice managers/, 'Add lands the statement in Buyer roles')

  // 2b. Add then Dismiss: the text leaves the visible field in the same action (no hidden contradiction to resurrect).
  const h4 = page.getByTestId('hyp-h4')
  await h4.getByRole('button', { name: 'Add' }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('label')].find(l => l.textContent.includes('Buyer roles'))?.querySelector('input')?.value.includes('clinic owners'), null, { timeout: 5000 })
  await h4.getByRole('button', { name: 'Dismiss' }).click()
  await page.waitForFunction(() => ![...document.querySelectorAll('label')].find(l => l.textContent.includes('Buyer roles'))?.querySelector('input')?.value.includes('clinic owners'), null, { timeout: 5000 })
  assert.equal(await page.getByTestId('hyp-h4').count(), 0, 'dismissed statement is hidden')

  // 3. Dismiss hides the statement.
  await h2.getByRole('button', { name: 'Dismiss' }).click()
  assert.equal(await page.getByTestId('hyp-h2').count(), 0, 'dismissed statement is hidden')

  // 4. The targeting question takes a typed answer into Buyer roles.
  const q = page.getByTestId('research-question')
  assert.match(await q.innerText(), /Who buys this\?/, 'the question renders')
  await q.locator('input').fill('office managers')
  await q.getByRole('button', { name: 'Save' }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('label')].find(l => l.textContent.includes('Buyer roles'))?.querySelector('input')?.value.includes('office managers'), null, { timeout: 5000 })
  assert.match(await who.inputValue(), /office managers/, 'the typed answer lands in Buyer roles')
  assert.match(await block.innerText(), /Answered: Who buys this\? - office managers/, 'the answered line shows the typed words')

  // Save: the reviewed block (rejection + answer) and the edited profile go in one POST.
  await page.getByRole('button', { name: 'Looks right, continue' }).click()
  await page.locator('#ask').waitFor({ timeout: 10000 })
  const saved = profileBodies.at(-1)
  assert.ok(saved?.buyer, 'a profile was saved')
  assert.deepEqual(saved.buyer.who, ['practice managers', 'office managers'], 'saved who is exactly the edited field')
  assert.ok(!saved.buyer.who.includes('clinic owners'), 'the add-then-dismissed text is not in the saved field')
  const hyps = Object.fromEntries(saved.buyer.research.hyps.map(h => [h.i, h]))
  assert.equal(hyps.h2.s, 'rejected', 'the dismissal is saved as an explicit rejection')
  assert.equal(hyps.h4.s, 'rejected', 'the add-then-dismissal is saved as an explicit rejection')
  assert.equal(hyps.h1.s, 'sourced', 'an un-acted statement keeps its truth status')
  assert.deepEqual(saved.buyer.research.ans, { q: 'Who buys this?', o: 'o1', t: 'office managers' }, 'the answer is saved with its WORDS, recrawl-durable')
  console.log('PASS research-review: render, add, dismiss, answer, and saved reviewed block')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
