// Rendered check for the play step on Leads: one sentence box ("Who do you want to reach?") with three suggestions.
// NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/play-step.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call answered from a
// stub in the browser: no model call, no scan runs, nothing is saved. Off-host requests are aborted. It proves:
//   1. the entry is one labelled sentence box with three suggestions written from the saved business details;
//   2. an empty brain gets the three static examples, labelled "Examples:"; a sparse profile shows only its own
//      suggestion under "From your business details:" and the top-up examples in a separate "Examples:" group;
//   3. clicking a suggestion only fills the box (no request is sent);
//   4. submitting runs the existing flow unchanged: Find leads -> profile review -> one POST /api/scan carrying the
//      suggestion as the query -> the live progress view, where the suggestions are no longer shown.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-playstep-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const PROFILE = { business_name: 'Bright Smile Software', sells: 'Online booking for dental practices', website: 'https://brightsmile.example',
  buyer: { summary: 'Dental practices', who: ['Dental practice owners', 'Clinic administrators'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['opened a new location', 'hiring front-desk staff', 'switching practice software'], exclude: [] } }
const EMPTY = { business_name: '', sells: '', website: '', buyer: null }
const SPARSE = { business_name: '', sells: '', website: '', buyer: { summary: 'UK schools', who: ['UK school principals'], industries: ['education'], sizes: [], where: ['London'], signals: [], exclude: [] } }
const ICP = { summary: 'Clinic administrators in Ohio hiring front-desk staff', who: ['Clinic administrators'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['hiring front-desk staff'], exclude: [] }
const b = await chromium.launch()
async function open(profile) {
  const writes = []; const scanBodies = []
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (m !== 'GET') writes.push(`${m} ${p}`)
    if (p === '/api/settings/profile' && m === 'GET') return json(profile)
    if (p === '/api/usage') return json({ plan: 'free', scans_used: 1, scan_limit: 10, has_key: true, trial: null })
    if (p === '/api/settings/advanced') return json({ available: false, platforms: [] })
    if (p === '/api/scan/jobs') return json({ jobs: [] })
    if (p === '/api/scan/latest') return json({})
    if (p === '/api/scan/icp' && m === 'POST') return json({ icp: ICP, inferred: true })
    if (p === '/api/scan' && m === 'POST') { scanBodies.push(JSON.parse(req.postData())); return json({ job_id: 'b'.repeat(24) }, 202) }
    if (p === '/api/scan/status') return json({ status: 'pending', lead_count: 0, attempts: 0, max_attempts: 3 })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/app/leads`, { waitUntil: 'networkidle' })
  return { ctx, page, writes, scanBodies }
}
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) }
try {
  if (process.env.BEFORE_ONLY) { const { page } = await open(PROFILE); await page.waitForTimeout(800); await shot(page, 'leads'); console.log('before shot'); process.exit(0) }
  const { ctx, page, writes, scanBodies } = await open(PROFILE)
  const box = page.getByLabel('Who do you want to reach?')
  await box.waitFor()
  const chips = page.getByTestId('play-suggestion')
  await chips.first().waitFor()
  assert.match(await page.getByTestId('play-suggestions-business').textContent(), /^From your business details:/)
  assert.equal(await page.getByTestId('play-suggestions-examples').count(), 0, 'a full profile needs no examples')
  assert.deepEqual(await chips.allTextContents(), [
    'Dental practice owners in Ohio - opened a new location',
    'Clinic administrators in Ohio - hiring front-desk staff',
    'Dental practice owners in Ohio - switching practice software',
  ])
  await shot(page, 'leads')
  await chips.nth(1).click()
  assert.equal(await box.inputValue(), 'Clinic administrators in Ohio - hiring front-desk staff')
  assert.deepEqual(writes, [], 'a suggestion only fills the box')
  await shot(page, 'filled')
  // The existing flow: profile review first, then the one scan request, then live progress.
  await page.getByRole('button', { name: 'Find leads' }).click()
  await page.getByRole('button', { name: 'Run scan with this profile' }).first().click()
  await page.getByText('Queued - waiting to start.').waitFor()
  assert.deepEqual(writes, ['POST /api/scan/icp', 'POST /api/scan'])
  assert.equal(scanBodies.length, 1)
  assert.equal(scanBodies[0].query, 'Clinic administrators in Ohio - hiring front-desk staff')
  assert.equal(scanBodies[0].icp.summary, ICP.summary)
  assert.equal(await page.getByText('Stop this scan').isVisible(), true)
  assert.equal(await page.getByTestId('play-suggestions').count(), 0, 'no suggestions over a running scan')
  await shot(page, 'progress')
  await ctx.close()
  // Empty brain: three static examples, labelled as examples.
  const empty = await open(EMPTY)
  const ex = empty.page.getByTestId('play-suggestion'); await ex.first().waitFor()
  assert.match(await empty.page.getByTestId('play-suggestions').textContent(), /^Examples:/)
  assert.equal(await empty.page.getByTestId('play-suggestions-business').count(), 0)
  assert.equal(await ex.count(), 3)
  await ex.first().click()
  assert.equal(await empty.page.getByLabel('Who do you want to reach?').inputValue(), 'Dental practice owners in Ohio - opened a new location')
  assert.deepEqual(empty.writes, [])
  await shot(empty.page, 'examples')
  await empty.ctx.close()
  // Sparse profile (one role, no signals, nothing sold): its own suggestion and the examples are labelled apart.
  const sparse = await open(SPARSE)
  const own = sparse.page.getByTestId('play-suggestions-business'); await own.waitFor()
  assert.deepEqual(await own.getByTestId('play-suggestion').allTextContents(), ['UK school principals in London'])
  assert.deepEqual(await sparse.page.getByTestId('play-suggestions-examples').getByTestId('play-suggestion').allTextContents(), ['Dental practice owners in Ohio - opened a new location', 'B2B SaaS founders in the US - hiring their first sales rep'])
  assert.match(await sparse.page.getByTestId('play-suggestions-examples').textContent(), /^Examples:/)
  await shot(sparse.page, 'sparse')
  await sparse.ctx.close()
  console.log('play step UI check passed: suggestions from the business details (examples labelled apart), click fills only, one scan, live progress')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
