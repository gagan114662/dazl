// Website-first onboarding without the user's own AI key (#409). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/site-trial.ui.mjs   (SHOTS=<dir> saves desktop and 390px screenshots)
// Production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed in the browser:
// no site fetch, no model call, no scan. (The trial-funded read itself is test/icp-from-site.test.ts and
// test/trial-site-read.test.ts; the trial path to the first lead card is test/ui/one-sentence.ui.mjs.) It proves:
//   1. when the free trial cannot read the site, the page says the real reason (not available here, reads used, busy,
//      Google required), never a free-start promise, and offers the key AND the manual profile right there;
//   2. "Describe your business yourself instead" opens the profile form with nothing paid and nothing saved;
//   3. a trial-side read failure is not reported as the user's key; 4. no horizontal overflow at 390px.
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

const CASES = [
  ['not-configured', 400, { error: 'no_api_key', trial: 'not_configured' }, "The free trial isn't available here right now. Add your own Anthropic or OpenAI key to read it, or describe your business yourself."],
  ['reads-used', 400, { error: 'no_api_key', trial: 'site_reads_used' }, 'You have used your 3 free website reads for now; they come back 30 days after each read. Add your own Anthropic or OpenAI key to read it, or describe your business yourself.'],
  ['busy', 400, { error: 'no_api_key', trial: 'site_reads_busy' }, 'The free trial is busy right now. Try again later. Add your own Anthropic or OpenAI key to read it, or describe your business yourself.'],
  ['google', 400, { error: 'no_api_key', trial: 'google_required' }, 'The free trial needs an account that signs in with Google. Add your own Anthropic or OpenAI key to read it, or describe your business yourself.'],
]
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
    for (const [name, status, body, text] of CASES) {
      const { ctx, page, writes } = await open(width, height, { status, body })
      const box = page.getByTestId('site-key')
      await box.waitFor({ timeout: 15000 })
      assert.match(await box.innerText(), new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), name)
      assert.doesNotMatch(await page.getByTestId('site-step').innerText(), /free search|free scans? to start|3 free/i, `${name}: no free-start promise`)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll at ${width}px`)
      if (process.env.SHOTS && (name === 'not-configured' || name === 'busy')) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}-${tag}.png`) })
      if (name === 'not-configured') {
        // The manual path, right there: the profile form opens; nothing is paid for or saved by the click.
        await page.getByTestId('site-manual').click()
        await page.getByText("Here's what we think you sell and who buys it").waitFor({ timeout: 10000 })
        assert.equal(await page.getByRole('button', { name: 'Looks right, continue' }).count(), 1)
        assert.equal(await page.getByTestId('site-key').count(), 0)
        if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `manual-${tag}.png`) })
      }
      assert.deepEqual(writes, ['POST /api/scan/icp-from-url'], `${name}: only the one site-read request`)
      await ctx.close()
    }
    // A failure on the trial side is dazl's, not the user's key.
    const { ctx, page } = await open(width, height, { status: 502, body: { error: 'trial_read_failed' } })
    await page.getByTestId('site-step').getByRole('alert').waitFor({ timeout: 15000 })
    assert.equal(await page.getByTestId('site-step').getByRole('alert').textContent(), "dazl's free trial could not read your site just now. Try again, or describe your business yourself.")
    assert.doesNotMatch(await page.getByTestId('site-step').innerText(), /your key/i)
    await ctx.close()
  }
  console.log('site trial UI check passed: real reason when the trial cannot read the site (not available, reads used, busy, Google), key + manual profile offered, trial failure not blamed on a key, desktop + 390px')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
