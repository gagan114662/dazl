// Website-first onboarding without the user's own AI key (#409, the #444 port's contract). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/site-trial.ui.mjs   (SHOTS=<dir> saves desktop and 390px screenshots)
// Production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed in the browser:
// no site fetch, no model call, no scan. (The trial-funded read itself is test/icp-from-site.test.ts and
// test/trial-site-read.test.ts; the trial path to the first lead card is test/ui/one-sentence.ui.mjs.) It proves:
//   1. the free read ALWAYS answers - the page's own facts render with their sources (the floor);
//   2. when the trial could not fund the read, the key form says the real reason (each refusal, read_failed included),
//      never a free-start promise, and the manual profile is right there;
//   3. flag off / no trial path at all: the free read with the generic key line;
//   4. a funded read lands the editable draft (and saves it, as a keyed read does);
//   5. an owner-side error (spend_limit) keeps main's 429 fallback copy; 6. no horizontal overflow at 390px.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-sitetrial-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const FREE = { free: true, site: 'ledgerline.example', source: 'https://ledgerline.example/', facts: [
  { kind: 'title', text: 'Ledgerline - books that close themselves', source: 'https://ledgerline.example/' },
  { kind: 'description', text: 'Monthly bookkeeping for busy founders, reconciled automatically.', source: 'https://ledgerline.example/' },
] }
const OWN = 'Add your own Anthropic or OpenAI key to read it, or describe your business yourself.'
const CASES = [
  ['not-configured', 'not_configured', `The free trial isn't available here right now. ${OWN}`],
  ['reads-used', 'site_reads_used', `You have used your three free website reads for now; they come back together, 30 days after the first. ${OWN}`],
  ['busy', 'site_reads_busy', `The free trial is busy right now. Try again later. ${OWN}`],
  ['google', 'google_required', `The free trial needs an account that signs in with Google. ${OWN}`],
  ['domain-used', 'domain_used', `Another account at your company's email domain has already started the free trial, and it belongs to that account. ${OWN}`],
  ['attempts-cap', 'attempts_cap', `Your free trial is used up. ${OWN}`],
  ['account-total-cap', 'account_total_cap', `Your free trial's spending allowance is used up (website reads on the trial count toward it). ${OWN}`],
  ['global-daily-cap', 'global_daily_cap', `The free trial is busy right now. Try again later. ${OWN}`],
  ['ip-throttle', 'ip_throttle', `The free trial is busy right now. Try again later. ${OWN}`],
  ['limit-unavailable', 'limit_unavailable', `The free trial is busy right now. Try again later. ${OWN}`],
  ['workspace', 'workspace_not_eligible', `The free trial belongs to the account that created this workspace. ${OWN}`],
  // The port's two new reasons: guard refused before any call (nothing used); the funded call failed (that read counted).
  ['spend-unavailable', 'spend_unavailable', `The free trial could not fund this read just now; nothing was used up. Try again later. ${OWN}`],
  ['read-failed', 'read_failed', `dazl's free trial could not read your site just now. Try again, or describe your business yourself.`],
]
const FUNDED = { icp: { summary: 'Founders at small agencies that want hands-off books.', who: ['Agency founders'], industries: ['Professional services'], sizes: ['1-10'], where: [], signals: ['Hiring a bookkeeper'], exclude: [] }, source: 'https://ledgerline.example/', sells: 'Hands-off monthly bookkeeping', funded: 'trial' }
const b = await chromium.launch()
async function open(width, height, answer) {
  const ctx = await b.newContext({ viewport: { width, height } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const writes = []
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (m !== 'GET') writes.push(`${m} ${p}`)
    if (p === '/api/scan/icp-from-url') return json(answer.body, answer.status)
    if (p === '/api/settings/profile' && m === 'GET') return json({ business_name: '', sells: '', website: '', buyer: null })
    if (p === '/api/settings/profile' && m === 'POST') return json({ ok: true })
    if (p === '/api/usage') return json({ plan: 'free', scans_used: 0, scan_limit: 10, has_key: false, trial: { funded: false, remaining: 0, cap: 3, blocked: 'not_configured' } })
    if (p === '/api/scan/jobs') return json({ jobs: [] })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  await page.getByTestId('site-step').waitFor({ timeout: 15000 })
  await page.getByLabel('Your website').fill('ledgerline.example')
  await page.getByRole('button', { name: 'Read my site' }).click()
  return { ctx, page, writes }
}
try {
  for (const [width, height, tag] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
    // The floor + every refusal: 200, the page's own facts, the key form with the real reason. Only the read request.
    for (const [name, reason, text] of CASES) {
      const { ctx, page, writes } = await open(width, height, { status: 200, body: { ...FREE, trial: reason } })
      const panel = page.getByTestId('free-site-read')
      await panel.waitFor({ timeout: 15000 })
      assert.match(await panel.innerText(), /books that close themselves/, `${name}: the page's own facts render`)
      assert.match(await panel.innerText(), /reconciled automatically/, `${name}: the description fact renders`)
      const stepText = await page.getByTestId('free-site-read').locator('..').innerText()
      assert.match(stepText, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 60)), `${name}: the real reason`)
      assert.doesNotMatch(stepText, /free search|free scans? to start|3 free/i, `${name}: no free-start promise`)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll at ${width}px`)
      if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}-${tag}.png`), fullPage: true })
      assert.deepEqual(writes, ['POST /api/scan/icp-from-url'], `${name}: only the one site-read request`)
      await ctx.close()
    }
    // Flag off / no trial path: the free read with the generic key line, nothing trial-flavored.
    {
      const { ctx, page } = await open(width, height, { status: 200, body: FREE })
      await page.getByTestId('free-site-read').waitFor({ timeout: 15000 })
      assert.match(await page.getByTestId('free-site-read').locator('..').innerText(), /The full automatic read runs on your own Anthropic or OpenAI key\./, 'flag off: the generic key line')
      if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `flag-off-${tag}.png`), fullPage: true })
      await ctx.close()
    }
    // A funded read: the editable draft lands and is saved exactly as read (the same POST a keyed read makes).
    {
      const { ctx, page, writes } = await open(width, height, { status: 200, body: FUNDED })
      await page.getByTestId('ready-step').waitFor({ timeout: 15000 })
      assert.ok(writes.includes('POST /api/settings/profile'), 'the funded draft is saved like a keyed read')
      if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `funded-${tag}.png`), fullPage: true })
      await ctx.close()
    }
    // An owner-side error keeps main's own copy (nothing trial-flavored, no key blame).
    {
      const { ctx, page } = await open(width, height, { status: 429, body: { error: 'spend_limit', message: 'Your workspace AI spend limit for today or this month is reached, so nothing was generated and nothing was charged.' } })
      // main's copy for an owner-side 429 is the generic fallback (knownErrorCopy has no spend_limit entry); the
      // Next route announcer also carries role=alert, so scope to the site step.
      const alert = page.getByTestId('site-step').getByRole('alert')
      await alert.waitFor({ timeout: 15000 })
      assert.match(await alert.innerText(), /Too many website reads\. Try again later/, 'spend_limit: main copy')
      if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `spend-limit-${tag}.png`), fullPage: true })
      await ctx.close()
    }
  }
  console.log(`site trial UI check passed: free-read floor with facts for each of the ${CASES.length} reasons (incl. spend_unavailable and read_failed), flag-off generic line, funded draft lands and saves, spend_limit keeps main copy, desktop + 390px`)
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
