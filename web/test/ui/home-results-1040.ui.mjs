// #1040 rendered check: Home's "Last 30 days" on the REAL production build and CSS, with a session and every /api/* call
// answered from a stub. It proves, at 1280 and 390 px: the four tiles show the counts and link to Leads / Outreach / Inbox;
// the by-signal table's replied column adds up to the Replied tile; the latest leads and replies are listed; a new
// workspace sees zeros and one next step ("Run your first play"); a failed read says so (never a row of zeros); no
// horizontal scroll. NOT part of `npm test`. Run:  cd web && npm run build && node test/ui/home-results-1040.ui.mjs
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pickUiPort } from '../helpers/ui-port.mjs'
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(dir, 'package.json'))
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? ' (allowed by SMOKE_ALLOW_SKIP=1)' : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
let chromium
try { ({ chromium } = require('playwright')) } catch (e) { notRun(e.message.split('\n')[0]) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const Database = require('better-sqlite3'); const { createHash, randomBytes } = require('crypto')
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-homeresults-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), email_verified_at INTEGER); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt,email_verified_at) VALUES ('u1','s@example.test','x','y',1)").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
// a port nothing else is listening on (a random one can land on a server an earlier CI step is still shutting down)
const { createServer } = await import('node:net')
const free = p => new Promise(ok => { const t = createServer().once('error', () => ok(false)).once('listening', () => t.close(() => ok(true))); t.listen(p, '127.0.0.1') })
let port = pickUiPort(); for (let i = 0; i < 50 && !(await free(port)); i++) port = pickUiPort()
const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
// wait until OUR server answers (and has not exited); fail with the reason instead of a refused page load
let up = false
for (let i = 0; i < 300 && srv.exitCode === null; i++) { try { await fetch(base + '/sign-in'); up = srv.exitCode === null; if (up) break } catch { /* not up yet */ } await new Promise(r => setTimeout(r, 200)) }
if (!up) { srv.kill(); rmSync(tmp, { recursive: true, force: true }); throw new Error(`the production server on ${base} did not come up (exit code ${srv.exitCode})`) }


const NOW = Math.floor(Date.now() / 1000)
const FULL = { window_days: 30, since: NOW - 30 * 86400, tiles: { leads: 4, contacted: 4, replied: 2, interested: 1 },
  by_signal: [{ signal: 'hiring', leads: 2, contacted: 2, replied: 1 }, { signal: 'raised_funding', leads: 1, contacted: 2, replied: 1 }, { signal: 'unknown', leads: 1, contacted: 0, replied: 0 }],
  latest_leads: [{ id: 'l1', company: 'Bright Smile Dental', signal: 'hiring', job_id: 'a'.repeat(24), created_at: NOW - 86400 }],
  latest_replies: [{ thread_id: 't1', company: 'Lakeview Dental Group', classification: 'positive', received_at: NOW - 3600 }] }
const ZERO = { window_days: 30, since: NOW - 30 * 86400, tiles: { leads: 0, contacted: 0, replied: 0, interested: 0 }, by_signal: [], latest_leads: [], latest_replies: [] }
const b = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {})
const out = []
async function open(width, results) {
  const ctx = await b.newContext({ viewport: { width, height: 900 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const writes = []
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    if (req.method() !== 'GET') writes.push(p)
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/api/home/results') return results === 'fail' ? json({ error: 'unavailable' }, 503) : json(results)
    if (p === '/api/scan/jobs') return json({ jobs: [] })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(base + '/app', { waitUntil: 'networkidle' })
  return { ctx, page, writes }
}
try {
  for (const width of [1280, 390]) {
    const { ctx, page, writes } = await open(width, FULL)
    const sec = page.getByTestId('home-results'); await sec.waitFor({ timeout: 20000 })
    const tile = async id => (await page.getByTestId(`tile-${id}`).textContent()).replace(/\s+/g, ' ').trim()
    assert.equal(await tile('leads'), '4New leads'); assert.equal(await tile('contacted'), '4Contacted'); assert.equal(await tile('replied'), '2Replied'); assert.equal(await tile('interested'), '1Interested')
    assert.equal(await page.getByTestId('tile-replied').getAttribute('href'), '/app/inbox?status=all')
    assert.equal(await page.getByTestId('tile-contacted').getAttribute('href'), '/app/outreach')
    assert.equal(await page.getByTestId('tile-leads').getAttribute('href'), '/app/leads?latest=1')
    const rows = await page.getByTestId('by-signal').locator('tbody tr').evaluateAll(trs => trs.map(tr => [...tr.children].map(td => td.textContent.trim())))
    assert.deepEqual(rows, [['Hiring', '2', '2', '1'], ['Raised funding', '1', '2', '1'], ['No signal type', '1', '0', '0']])
    assert.equal(rows.reduce((n, r) => n + Number(r[3]), 0), 2, 'the replied column adds up to the Replied tile')
    assert.match(await page.getByTestId('latest-leads').textContent(), /Bright Smile Dental/)
    assert.match(await page.getByTestId('latest-replies').textContent(), /Lakeview Dental Group Interested/)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}: no horizontal scroll`)
    assert.deepEqual(writes, [], 'Home writes nothing')
    if (process.env.SHOTS) await sec.screenshot({ path: path.join(process.env.SHOTS, `home-results-${width}.png`) })
    out.push(`${width}: tiles 4/4/2/1, by signal adds up`)
    await ctx.close()
  }
  { const { ctx, page } = await open(1280, ZERO)
    await page.getByTestId('results-empty').waitFor({ timeout: 20000 })
    assert.match(await page.getByTestId('results-empty').textContent(), /Run your first play/)
    assert.equal(await page.getByTestId('results-empty').getByRole('link', { name: 'Run your first play' }).getAttribute('href'), '/app/leads')
    out.push('new workspace: zeros + Run your first play'); await ctx.close() }
  { const { ctx, page } = await open(1280, 'fail')
    await page.getByTestId('results-unread').waitFor({ timeout: 20000 })
    assert.equal(await page.getByTestId('home-results').count(), 0, 'a failed read shows no tiles (never zeros)')
    out.push('failed read: says so'); await ctx.close() }
  console.log(`home results UI check passed (real build): ${out.join('; ')}`)
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
