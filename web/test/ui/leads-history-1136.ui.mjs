// #1136 rendered check, on the REAL production build with the REAL /api/scan/jobs and /api/campaigns over a seeded store:
// the Leads history ("Past scans") pill, result line and next step of a scan say what its Campaigns card says, counted from
// the leads as they stand now - never the scan-time "need your review" for leads no check can make ready. Two shapes from
// #683: the NYC run (2 review leads, both research only: no usable date, someone else's customer; recorded "needs review 2")
// and the London Test B run (a source-checked lead a required check never passed - DEFAULT-DENY; recorded "verified 1").
// Also: when /api/campaigns fails, the history says its cards are as recorded. At 1280 and 390 px, no horizontal scroll.
// NOT part of `npm test`. Run:  cd web && npm run build && node test/ui/leads-history-1136.ui.mjs
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-history1136-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
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

try {
  const b = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {})
  const out = []
  try {
    const cookie = { name: 'dazl_session', value: token, url: base }
    // one signed-in read first: the server creates its tables, then the scans are seeded into the same store
    const first = await fetch(base + '/api/scan/jobs', { headers: { cookie: `dazl_session=${token}` } })
    assert.equal(first.status, 200, `signed-in history read: ${first.status}`)
    const s = new Database(DB)
    const tenant = 'u1'   // a member's default workspace is their own (lib/auth-db.ts resolveMembership)
    const recent = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10)
    const NYC = 'Dental practices in New York hiring front desk staff', LONDON = 'Find London UK companies hiring sales account executives.'
    const J1 = 'a'.repeat(24), J2 = 'b'.repeat(24)
    const job = (id, q, icp, verified, review, at) => {
      s.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, candidates, created_at) VALUES (?, ?, 'x', '(from request)', '-', ?, ?, 'running', 5, ?)").run(id, tenant, q, icp, at)
    }
    // leads are added while the scan runs (a trigger), then it finishes with its scan-time counts
    const finish = (id, at, verified, review) => s.prepare("UPDATE scan_jobs SET status = 'done', finished_at = ?, verified = ?, needs_review = ?, dropped = 0 WHERE id = ?").run(at + 60, verified, review, id)
    const lead = (jobId, id, o) => s.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason, event_date) VALUES (?, ?, ?, 'hiring a receptionist', 'https://news.example/a', ?, ?, ?, ?)")
      .run(id, jobId, `Co ${id}`, o.machine ? 80 : null, o.machine ? `Co ${id} is hiring a receptionist` : null, o.review ?? null, o.date ?? null)
    const now = Math.floor(Date.now() / 1000)
    job(J1, NYC, JSON.stringify({ window_days: 90 }), 0, 2, now - 7200)
    lead(J1, 'n1', { review: 'outside_window_undated' }); lead(J1, 'n2', { review: 'counterparty_signal', date: recent }); finish(J1, now - 7200, 0, 2)
    job(J2, LONDON, null, 1, 0, now - 3600)
    lead(J2, 'l1', { machine: true, date: recent }); finish(J2, now - 3600, 1, 0)
    s.close()

    // the Campaigns card for each scan: what the history must say too
    const camps = await (await fetch(base + '/api/campaigns?limit=20', { headers: { cookie: `dazl_session=${token}` } })).json()
    const card = Object.fromEntries(camps.campaigns.map(c => [c.id, c]))
    assert.equal(card[J1]?.run?.tag, 'Research only', `NYC card: ${JSON.stringify(card[J1]?.run)}`)
    assert.equal(card[J2]?.run?.tag, 'Research only', `London card: ${JSON.stringify(card[J2]?.run)}`)

    for (const width of [1280, 390]) {
      const ctx = await b.newContext({ viewport: { width, height: 900 } }); await ctx.addCookies([cookie])
      const page = await ctx.newPage()
      await page.goto(base + '/app/leads', { waitUntil: 'networkidle' })
      for (const [id, name] of [[J1, 'NYC'], [J2, 'London']]) {
        const c = page.getByTestId('past-scan').filter({ has: page.locator(`a[href="/app/leads?job_id=${id}"]`) })
        await c.first().waitFor({ timeout: 20000 })
        const text = await c.first().textContent()
        assert.ok(text.includes(card[id].run.tag), `${width} ${name}: pill "${card[id].run.tag}" in ${text}`)
        assert.doesNotMatch(text, /[1-9] needs? your review/i, `${width} ${name}: never "N need your review": ${text}`)
        const result = await c.first().getByTestId('past-scan-result').textContent()   // the label, then its info tip's detail
        assert.ok(result.startsWith(card[id].run.label), `${width} ${name}: the result line is the card's (${card[id].run.label}): ${result}`)
        assert.equal(await c.first().getByTestId('next-step').textContent(), card[id].next.label, `${width} ${name}: the next step is the card's`)
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}: no horizontal scroll`)
      if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `leads-history-${width}.png`), fullPage: true })
      out.push(`${width}: NYC and London history cards = their Campaigns cards (Research only, Change the search)`)
      await ctx.close()
    }
    // the campaigns read fails: the cards say they are as recorded (never a silent mix)
    { const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await ctx.addCookies([cookie])
      await ctx.route('**/api/campaigns**', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"x"}' }))
      const page = await ctx.newPage(); await page.goto(base + '/app/leads', { waitUntil: 'networkidle' })
      await page.getByTestId('history-recorded').waitFor({ timeout: 20000 })
      out.push('campaigns read failed: the history says it shows each scan as recorded'); await ctx.close() }
  } finally { await b.close() }
  console.log(`leads history UI check passed (real build, real routes): ${out.join('; ')}`)
} finally {
  srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
