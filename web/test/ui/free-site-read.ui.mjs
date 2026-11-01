// First-run "Read my site" free path (#409): a keyless account that enters its website gets the page's own extracted
// facts with their sources and the reviewable manual profile - no key demand up front, no inferred draft, no auto-save,
// no false free-search promise. A keyed account keeps the AI fill + auto-save unchanged; a failed read offers the manual
// path truthfully. NOT part of `npm test`. Run:  cd web && npm run build && node test/ui/free-site-read.ui.mjs
// (SHOTS=<dir> saves desktop and 390px screenshots). Production build, throwaway database, server under
// test/helpers/net-fence.ts, EVERY /api/* call stubbed in the browser: no fetch, no model, no key, no spend.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-freesite-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const FREE = { free: true, site: 'acme.example', source: 'https://acme.example/', facts: [
  { kind: 'title', text: 'Acme Inc', source: 'https://acme.example/' },
  { kind: 'description', text: 'CRM cleanup for sales teams.', source: 'https://acme.example/' },
] }
const KEYED = { sells: 'CRM cleanup for sales teams', source: 'https://acme.example/', icp: { summary: 'Sales ops teams at B2B SaaS companies.', who: ['Sales ops managers'], industries: ['B2B SaaS'], sizes: [], where: [], signals: [], exclude: [] } }
const usage = hasKey => ({ plan: 'free', scans_used: 0, scan_limit: 50, has_key: hasKey, billing_status: null, trial: null })

const b = await chromium.launch()
try {
  for (const [width, height, tag] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
    const run = async (name, icpResponse, hasKey, check) => {
      const ctx = await b.newContext({ viewport: { width, height } })
      await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
      const writes = []
      await ctx.route('**/*', async route => {
        const req = route.request(); const u = new URL(req.url())
        if (u.origin !== base) return route.abort()
        if (!u.pathname.startsWith('/api/')) return route.continue()
        if (req.method() !== 'GET') writes.push(`${req.method()} ${u.pathname} ${req.postData() ?? ''}`)
        if (u.pathname === '/api/usage') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(usage(hasKey)) })
        if (u.pathname === '/api/scan/jobs') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"jobs":[]}' })
        if (u.pathname === '/api/settings/profile') {
          if (req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
        }
        if (u.pathname === '/api/scan/icp-from-url') return route.fulfill(icpResponse)
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
      })
      const page = await ctx.newPage()
      await page.goto(`${base}/app?setup=site`, { waitUntil: 'networkidle' })
      await page.getByTestId('site-step').waitFor({ timeout: 15000 })
      await page.getByLabel('Your website').fill('acme.example')
      await page.getByRole('button', { name: 'Read my site' }).click()
      await check(page, writes)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll at ${width}px`)
      if (process.env.SHOTS) await page.locator('main, [data-testid=onboarding-screen]').first().screenshot({ path: path.join(process.env.SHOTS, `${name}-${tag}.png`) })
      await ctx.close()
    }

    await run('keyless-free', { status: 200, contentType: 'application/json', body: JSON.stringify(FREE) }, false, async (page, writes) => {
      const card = page.getByTestId('free-site-read')
      await card.waitFor({ timeout: 15000 })
      const text = await card.innerText()
      assert.match(text, /Acme Inc/, 'title fact shown')
      assert.match(text, /CRM cleanup for sales teams\./, 'description fact shown')
      assert.equal(await card.getByRole('link', { name: 'source' }).count(), 2, 'each fact carries its source')
      assert.match(await page.locator('form', { has: page.getByTestId('free-site-read') }).innerText(), /No AI was used for this read/, 'honest no-AI copy')
      assert.equal(await page.getByLabel('What you sell').inputValue(), '', 'nothing inferred into the profile')
      assert.ok(await page.getByText('The full automatic read runs on your own Anthropic or OpenAI key.').isVisible(), 'key offered as an option, not a demand')
      assert.deepEqual(writes.filter(w => !w.startsWith('POST /api/scan/icp-from-url')), [], 'the free read never auto-saves (its own read POST aside)')
    })

    await run('keyed-ai-fill', { status: 200, contentType: 'application/json', body: JSON.stringify(KEYED) }, true, async (page, writes) => {
      await page.getByTestId('ready-step').waitFor({ timeout: 30000 })
      assert.equal(await page.getByTestId('free-site-read').count(), 0, 'keyed path never shows the free card')
      assert.equal(writes.filter(w => w.startsWith('POST /api/settings/profile')).length, 1, 'keyed path auto-saves the AI draft as before')
    })

    await run('read-failed', { status: 502, contentType: 'application/json', body: '{"error":"not_public"}' }, false, async (page, writes) => {
      await page.getByTestId('site-step').waitFor({ timeout: 15000 })
      assert.match(await page.locator('p[role=alert]').innerText(), /not a public website/i, 'failed read says the true reason')
      assert.ok(await page.getByRole('button', { name: /describe your business yourself/i }).isVisible(), 'failed read leaves the manual path right there')
      assert.ok(await page.getByRole('button', { name: 'No website? Describe your business yourself' }).isVisible(), 'manual alternative present')
      assert.deepEqual(writes.filter(w => !w.startsWith('POST /api/scan/icp-from-url')), [], 'a failed read writes nothing (its own read POST aside)')
    })
  }
  console.log('free site read UI check passed: keyless gets source-labeled facts + manual profile with no inference/auto-save/key demand, keyed keeps the AI fill, a failed read offers the manual path; desktop + 390px')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
