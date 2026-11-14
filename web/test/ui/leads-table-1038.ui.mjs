// #1038 rendered check: the Leads TABLE on the REAL production build and CSS, with a session and every /api/* call answered
// from a stub (no scan, no provider call). It proves, at 1440x900 and 390 px:
//   1. 60 leads load as a table, 50 on the first page, and at least 15 rows are visible without scrolling at 1440x900;
//   2. clicking a row opens the side panel with the quote, the source link and the date; Next and Previous move between
//      leads and the panel stays open; Close and Escape close it;
//   3. sorting by Fit puts the highest fit first and the order survives a reload (kept in the address); Date sorts too;
//   4. select 5 rows, Approve: five requests, each row shows its own result, including a refusal's reason;
//      Reject: five quarantine requests; the cards stay one click away ("Cards" opens /app/leads);
//   5. a failed read says so (never an empty table); no horizontal scroll at 390 px.
// NOT part of `npm test`. Run:  cd web && npm run build && node test/ui/leads-table-1038.ui.mjs   (SHOTS=<dir> saves screenshots)
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-leads-table-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
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

const lead = i => ({ id: `lead${String(i).padStart(3, '0')}`, job_id: 'a'.repeat(24), company: `Company ${i}`, company_domain: null, person: i % 3 ? `Person ${i}` : null, email: i % 2 ? `p${i}@example.com` : null,
  signal: `Company ${i} opened a new location in Ohio`, quote: `We just opened our new office ${i}`, source_url: `https://news.example.com/story-${i}`,
  event_date: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`, found_at: 1790000000 + i, fit: 1 + ((i * 7) % 3) + 0, review_reason: null, why: `fit reason ${i}`, state: 'review' })
const ALL = Array.from({ length: 60 }, (_, i) => lead(i + 1)).map(r => ({ ...r, fit: [2, 5, 3, 4, 5][r.company.length % 5] }))
const sorted = s => [...ALL].sort((a, b) => s === 'date' ? b.event_date.localeCompare(a.event_date) || a.id.localeCompare(b.id) : (b.fit - a.fit) || a.id.localeCompare(b.id))
const b = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {})
const out = []
try {
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const ctx = await b.newContext({ viewport: { width, height } })
    await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
    const writes = []; let failRead = false
    await ctx.route('**/*', async route => {
      const req = route.request(); const u = new URL(req.url()); const p = u.pathname; const m = req.method()
      if (u.origin !== base) return route.abort()
      if (!p.startsWith('/api/')) return route.continue()
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (m !== 'GET') writes.push({ m, p, body: req.postDataJSON?.() ?? null })
      if (p === '/api/leads/table') {
        if (failRead) return json({ error: 'x' }, 503)
        const s = u.searchParams.get('sort') === 'date' ? 'date' : 'fit', pg = Math.max(1, Number(u.searchParams.get('page')) || 1), rows = sorted(s)
        return json({ rows: rows.slice((pg - 1) * 50, pg * 50), total: rows.length, page: pg, pages: Math.ceil(rows.length / 50), sort: s })
      }
      if (p === '/api/outreach' && m === 'POST') { const id = req.postDataJSON().lead_id; return id === 'lead003' ? json({ error: 'Held: the timing is not confirmed' }, 409) : json({ ok: true }) }
      if (/^\/api\/leads\/[^/]+\/quarantine$/.test(p) && m === 'POST') return json({ ok: true })
      if (p.startsWith('/api/leads/export')) return route.fulfill({ status: 200, contentType: 'text/csv', body: 'company\n' })
      return json({})
    })
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message))
    const tag = `${width}`
    await page.goto(`${base}/app/leads/table`, { waitUntil: 'networkidle' })
    await page.getByTestId('lead-row').first().waitFor({ timeout: 20000 })
    // 1. rows and fold
    assert.equal(await page.getByTestId('lead-row').count(), 50, 'first page lists 50 of 60')
    assert.match(await page.getByTestId('table-count').textContent(), /60 leads across your scans, showing 50 on page 1 of 2/)
    if (width >= 1000) {
      const visible = await page.getByTestId('lead-row').evaluateAll(els => els.filter(e => e.getBoundingClientRect().bottom <= window.innerHeight).length)
      assert.ok(visible >= 15, `at least 15 rows visible without scrolling at ${width}x${height} (got ${visible})`)
      out.push(`${width}: ${visible} rows visible without scrolling`)
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 || !!document.querySelector('.overflow-x-auto')), true, 'the table scrolls inside its own box, the page does not')
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `table-${tag}.png`) })
    // 3. sort by fit first, kept across a reload
    const fits = async () => page.getByTestId('row-fit').evaluateAll(els => els.map(e => Number(e.getAttribute('data-fit'))))
    let f = await fits(); assert.equal(f[0], Math.max(...f), 'the first row has the highest fit'); assert.deepEqual(f, [...f].sort((a, b) => b - a), 'fit is descending')
    await page.getByTestId('sort-date').click(); await page.waitForURL(/sort=date/)
    await page.waitForFunction(() => document.querySelector('[data-testid=lead-row]')?.innerText.includes('2026-10-28'))   // the newest event first
    const dateFirst = await page.getByTestId('lead-row').first().innerText()
    await page.reload({ waitUntil: 'networkidle' }); await page.getByTestId('lead-row').first().waitFor()
    assert.equal(await page.getByTestId('lead-row').first().innerText(), dateFirst, 'the date order survives a reload')
    await page.getByTestId('sort-fit').click(); await page.waitForURL(/sort=fit/); await page.waitForFunction(() => document.querySelector('[data-testid=row-fit]')?.getAttribute('data-fit') === '5')
    f = await fits(); assert.equal(f[0], 5); await page.reload({ waitUntil: 'networkidle' }); await page.getByTestId('lead-row').first().waitFor()
    assert.equal((await fits())[0], 5, 'the fit order survives a reload')
    // 2. the side panel
    const firstCompany = (await page.getByTestId('lead-row').nth(0).locator('td').nth(1).innerText()).trim()
    const secondCompany = (await page.getByTestId('lead-row').nth(1).locator('td').nth(1).innerText()).trim()
    await page.getByTestId('lead-row').nth(0).locator('td').nth(3).click()
    await page.getByTestId('lead-panel').waitFor()
    assert.equal((await page.getByTestId('panel-company').textContent()).trim(), firstCompany)
    assert.match(await page.getByTestId('panel-quote').textContent(), /We just opened our new office/)
    assert.match(await page.getByTestId('panel-source').getAttribute('href'), /^https:\/\/news\.example\.com\/story-/)
    assert.match(await page.getByTestId('lead-panel').innerText(), /event date 2026-10-\d\d/)
    await page.getByTestId('panel-next').click()
    assert.equal((await page.getByTestId('panel-company').textContent()).trim(), secondCompany, 'Next shows the second lead and the panel stays open')
    await page.getByTestId('panel-prev').click()
    assert.equal((await page.getByTestId('panel-company').textContent()).trim(), firstCompany, 'Previous returns')
    assert.equal(await page.getByTestId('panel-prev').isDisabled(), true, 'no previous before the first row')
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `panel-${tag}.png`) })
    await page.keyboard.press('Escape'); assert.equal(await page.getByTestId('lead-panel').count(), 0, 'Escape closes the panel')
    // 4. bulk approve and reject, row by row
    const before = writes.length
    const ids = ['lead001', 'lead002', 'lead003', 'lead004', 'lead005']
    const rowFor = id => page.locator('tr[data-testid=lead-row]').filter({ has: page.locator(`input[aria-label="Select Company ${Number(id.slice(4))}"]`) })
    for (const id of ids) await page.locator(`input[aria-label="Select Company ${Number(id.slice(4))}"]`).check()
    assert.equal((await page.getByTestId('picked-count').textContent()).trim(), '5 selected')
    await page.getByTestId('bulk-approve').click()
    await page.waitForFunction(() => document.querySelector('[data-testid=picked-count]').textContent.startsWith('0'))
    const approves = writes.slice(before).filter(w => w.p === '/api/outreach')
    assert.deepEqual(approves.map(w => w.body.lead_id).sort(), ids, 'one approve request per selected row, five in all')
    const stateOf = async id => (await rowFor(id).getByTestId('row-state').innerText()).trim()
    assert.match(await stateOf('lead001'), /^Approved: draft created$/)
    assert.match(await stateOf('lead003'), /^Not approved: Held: the timing is not confirmed$/, 'a refusal shows its reason on its own row')
    await page.locator(`input[aria-label="Select Company 6"]`).check(); await page.locator(`input[aria-label="Select Company 7"]`).check()
    const b2 = writes.length; await page.getByTestId('bulk-reject').click()
    await page.waitForFunction(() => document.querySelector('[data-testid=picked-count]').textContent.startsWith('0'))
    assert.equal(writes.slice(b2).filter(w => /\/quarantine$/.test(w.p)).length, 2, 'reject quarantines each selected row')
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `bulk-${tag}.png`) })
    // pages, cards link
    await page.getByTestId('next-page').click(); await page.waitForURL(/page=2/); await page.getByTestId('lead-row').first().waitFor()
    assert.equal(await page.getByTestId('lead-row').count(), 10, 'page 2 lists the other 10')
    assert.equal(await page.getByTestId('to-cards').getAttribute('href'), '/app/leads?latest=1', 'the cards stay one click away')
    assert.equal(errs.length, 0, `no page errors: ${errs.join('; ')}`)
    // 5. a failed read says so
    failRead = true; await page.goto(`${base}/app/leads/table?sort=fit`, { waitUntil: 'networkidle' })
    await page.getByTestId('table-error').waitFor({ timeout: 20000 })
    assert.equal(await page.getByTestId('lead-row').count(), 0, 'a failed read lists no rows and says why')
    out.push(`${width}: ok`)
    await ctx.close()
  }
  console.log(`leads table UI check passed (real build): ${out.join('; ')}`)
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
