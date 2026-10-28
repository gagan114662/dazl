// Rendered check for the Home readiness rows that report AI key validity and lead source availability truthfully.
// NOT part of `npm test`. Run:  cd web && npm run build && node test/ui/readiness-truth.ui.mjs   (SHOTS=<dir> saves
// screenshots; BEFORE_ONLY=1 only takes them, for a build without this change).
// Real production build, throwaway database, server under test/helpers/net-fence.ts, and EVERY /api/* CALL ANSWERED
// FROM A STUB in the browser: no scan, no key check against a provider, nothing saved. It proves:
//   1. a saved key whose latest scan (after it was saved) stopped with key_rejected reads as a to-do with "Replace key",
//      which opens the key form in place; it is not shown as fine just because a key is saved;
//   2. the Lead sources row names only usable sources as usable and lists every other offered source as not available
//      with its reason (server switch off, consent needed), with a one-click "Set up" link for the one a user can fix;
//   3. while the key is refused no source is called usable; a platform this server does not offer is not listed;
//      loading writes nothing.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-readinesstruth-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const now = Math.floor(Date.now() / 1000)
const job = (id, created_at, o) => ({ id: id.repeat(24), query: 'Dentists in Ohio opening a second location', business_name: '', csv_domain: null, created_at, finished_at: created_at, candidates: 5, verified: 2, needs_review: 1, dropped: 2, lead_count: 3, test_only: false, status: 'done', error: null, ...o })
const JOBS = [job('a', now - 9000, {}), job('b', now - 100, { status: 'failed', error: 'key_rejected', candidates: null, verified: null, needs_review: null, dropped: null, lead_count: 0 })]
const ADV = { available: true, version: 1, platforms: [
  { platform: 'x', allowed: true, consent: true, connected: false, enabled: false, operator_index: true },
  { platform: 'linkedin', allowed: true, consent: false, connected: false, enabled: false, operator_index: false },
  { platform: 'reddit', allowed: false, consent: false, connected: false, enabled: false, operator_index: false },
] }
const writes = []
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 1100 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
  if (u.origin !== base) return route.abort()
  if (!p.startsWith('/api/')) return route.continue()
  if (m !== 'GET') writes.push(`${m} ${p}`)
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (p === '/api/settings/profile') return json({ business_name: 'Brightsmile Supply', sells: 'Dental chairs', website: 'https://brightsmile.example', buyer: { summary: 'Independent dental practices', who: ['Practice owner'] } })
  if (p === '/api/scan/jobs') return json({ jobs: JOBS })
  if (p === '/api/usage') return json({ plan: 'free', scans_used: 2, scan_limit: 10, has_key: true, trial: null })
  if (p === '/api/settings/llm-key') return json({ keys: [{ vendor: 'anthropic', last4: 'Ab12', validated_at: now - 5000 }] })
  if (p === '/api/settings/advanced') return json(ADV)
  if (p === '/api/scan/sources') return json({ web_index: false, news: true, websites: true })
  if (p === '/api/outreach/settings') return json({ gmail: null, sender: null, daily_cap: 20, sent_24h: 0, account_sent_24h: 0 })
  return json({}, 404)
})
const page = await ctx.newPage()
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
const row = id => page.getByTestId(`ready-${id}`)
try {
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  await row('key').waitFor({ timeout: 15000 })
  await row('key').scrollIntoViewIfNeeded()
  await shot('readiness')
  if (process.env.BEFORE_ONLY !== '1') {
    assert.match(await row('key').textContent(), /AI key - saved \(ending Ab12\), but your AI provider refused it on your latest scan/)
    assert.equal(await row('key').getByText('✓').count(), 0, 'a refused key is not shown as fine')
    // While the latest scan says the key was refused, no source is called usable: the fix is the key.
    assert.equal(await row('sources').textContent().then(t => t.replace(/^.*?Lead sources - /, '').replace(/Replace key$/, '')),
      'a scan cannot run until you replace your AI key. Not available: Web search index (not set up on this server), LinkedIn (consent needed)')
    assert.equal(await row('sources').getByRole('link', { name: 'Replace key' }).getAttribute('href'), '/app/settings#model-key')
    assert.doesNotMatch(await row('sources').textContent(), /Reddit/)
    await row('key').getByRole('button', { name: 'Replace key' }).click()
    await row('key').locator('input').first().waitFor()
    await shot('replace-key-open')
    // A later scan finished: the key works, so the sources row names what a scan can use and lists the rest with reasons.
    JOBS.push(job('c', now - 10, {}))
    await page.reload({ waitUntil: 'networkidle' })
    await row('sources').getByText('✓').waitFor({ timeout: 15000 })
    assert.equal(await row('key').getByText('✓').count(), 1)
    assert.equal(await row('sources').textContent().then(t => t.replace(/^.*?Lead sources - /, '').replace(/Set up$/, '')),
      'a scan can use Web research with your AI key, News articles, Company websites, X posts. Not available: Web search index (not set up on this server), LinkedIn (consent needed)')
    assert.equal(await row('sources').getByRole('link', { name: 'Set up' }).getAttribute('href'), '/app/settings#social')
    await row('sources').scrollIntoViewIfNeeded()
    await shot('sources-available')
  }
  assert.deepEqual(writes, [], 'loading and opening the key form write nothing')
  console.log(process.env.BEFORE_ONLY === '1' ? 'screenshots taken (BEFORE_ONLY)' : 'readiness truth UI check passed: a refused key is a to-do with Replace key; only usable sources are named usable, the rest listed with reasons and a Set up link; no writes')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
