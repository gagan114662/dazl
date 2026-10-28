// Rendered check for truthful source availability on Leads (play entry and live progress). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/source-availability.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call answered from a
// stub in the browser: no scan runs, no key check. Off-host requests are aborted. It proves:
//   1. the play entry lists only the sources a scan here CAN use (capability wording, never "every scan searches");
//      a usable opt-in social source is not listed; with no key it says a scan cannot start until a key is added;
//   2. each unavailable source is marked with its reason, and a link to fix it when the user can (no key -> Add key,
//      social not connected / no consent -> Set up); operator-off sources say "not set up on this server", no link;
//   3. the progress view names only usable sources plus the extras this run asked for, never an unavailable one, and
//      no longer says "Searching sources...";
//   4. when the availability checks fail, the page says it could not check (it never lists sources as usable).
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-sources-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const ADV = { available: true, platforms: [
  { platform: 'x', allowed: true, consent: true, connected: true, enabled: true },
  { platform: 'linkedin', allowed: true, consent: true, connected: false, enabled: false },
  { platform: 'reddit', allowed: true, consent: false, connected: false, enabled: false },
] }
const b = await chromium.launch()
async function open({ server = { web_index: false, news: true, websites: true }, usage = { plan: 'free', scans_used: 1, scan_limit: 10, has_key: true, trial: null }, sourcesFail = false } = {}) {
  const writes = []; const scanBodies = []
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (m !== 'GET') writes.push(`${m} ${p}`)
    if (p === '/api/scan/sources') return sourcesFail ? json({ error: 'unavailable' }, 503) : json(server)
    if (p === '/api/usage') return json(usage)
    if (p === '/api/settings/advanced') return json(ADV)
    if (p === '/api/settings/profile') return json({ business_name: '', sells: '', website: '', buyer: null })
    if (p === '/api/scan/jobs') return json({ jobs: [] })
    if (p === '/api/scan' && m === 'POST') { scanBodies.push(JSON.parse(req.postData())); return json({ job_id: 'b'.repeat(24) }, 202) }
    if (p === '/api/scan/status') return json({ status: 'running', lead_count: 0, attempts: 1, max_attempts: 3 })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/app/leads`, { waitUntil: 'networkidle' })
  return { ctx, page, writes, scanBodies }
}
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) }
try {
  if (process.env.BEFORE_ONLY) { const { page } = await open(); await page.waitForTimeout(800); await shot(page, 'leads'); console.log('before shot'); process.exit(0) }
  const { ctx, page, writes, scanBodies } = await open()
  const box = page.getByTestId('source-availability'); await page.getByTestId('sources-usable').waitFor()
  assert.equal(await page.getByTestId('sources-usable').textContent(), 'Sources a scan here can use: Web research with your AI key, News articles, Company websites. Extra sources are optional, under More sources.')
  assert.equal(await page.getByTestId('source-off-web_index').textContent(), 'Web search index (not set up on this server)')
  assert.equal(await page.getByTestId('source-off-web_index').getByRole('link').count(), 0, 'operator switch: no user link')
  assert.match(await page.getByTestId('source-off-social:linkedin').textContent(), /LinkedIn \(not connected, Set up\)/)
  assert.equal(await page.getByTestId('source-off-social:linkedin').getByRole('link', { name: 'Set up' }).getAttribute('href'), '/app/settings#social')
  assert.match(await page.getByTestId('source-off-social:reddit').textContent(), /Reddit \(consent needed, Set up\)/)
  assert.doesNotMatch(await page.getByTestId('sources-usable').textContent(), /Web search index|LinkedIn|Reddit|X posts/, 'opt-in X is not claimed as searched')
  // Instinct #255: enabled sources are capabilities, never a promise that a scan searches them.
  assert.equal(await page.getByText(/every scan searches|searches:/i).count(), 0, 'no "every scan searches" claim')
  await shot(page, 'leads')
  // Run with GitHub ticked: progress names usable sources and that extra only.
  await page.getByLabel('Who do you want to reach?').fill('Dental practice owners in Ohio - opened a new location')
  await page.getByTestId('more-sources').locator('summary').first().click()
  await page.getByText('Also search public GitHub repositories').click()
  await page.getByTestId('more-sources').locator('summary').first().click()
  await page.getByRole('button', { name: 'Find leads' }).click()
  const run = page.getByTestId('run-sources'); await run.waitFor()
  assert.equal(await run.textContent(), 'Sources this scan can use: Web research with your AI key, News articles, Company websites, GitHub.')
  assert.doesNotMatch(await run.textContent(), /X posts|Web search index/, 'unticked and unavailable sources are not named')
  assert.equal(await page.getByText('Searching sources...').count(), 0)
  assert.equal(await box.count(), 0, 'the entry list is not shown over a running scan')
  assert.deepEqual(scanBodies[0].sources?.adapters, ['github'])
  assert.deepEqual(writes, ['POST /api/scan'])
  await shot(page, 'progress')
  await ctx.close()
  // No key and the free searches used up: research is unavailable, with Add key.
  const nokey = await open({ server: { web_index: true, news: true, websites: true }, usage: { plan: 'free', scans_used: 3, scan_limit: 10, has_key: false, trial: { funded: true, remaining: 0, cap: 3 } } })
  await nokey.page.getByTestId('sources-usable').waitFor()
  assert.equal(await nokey.page.getByTestId('sources-usable').textContent(), 'A scan cannot start until you add an AI key. Then it can use: Web search index, News articles, Company websites.')
  assert.equal(await nokey.page.getByText(/every scan searches|searches:/i).count(), 0, 'no-key: nothing is claimed as searched')
  assert.match(await nokey.page.getByTestId('source-off-research').textContent(), /Web research with your AI key \(free searches used up; no key, Add key\)/)
  assert.equal(await nokey.page.getByTestId('source-off-research').getByRole('link', { name: 'Add key' }).getAttribute('href'), '/app/settings#model-key')
  await shot(nokey.page, 'no-key')
  await nokey.ctx.close()
  // The checks could not load: say so, list nothing as usable.
  const failed = await open({ sourcesFail: true })
  await failed.page.getByText('Could not check which sources are available. Reload to retry.').waitFor()
  assert.equal(await failed.page.getByTestId('sources-usable').count(), 0)
  await failed.ctx.close()
  console.log('source availability UI check passed: only usable sources listed, unavailable ones with reason and fix, progress truthful, failed check says so')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
