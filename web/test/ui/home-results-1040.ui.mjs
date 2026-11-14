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
const FULL = { window_days: 30, since: NOW - 30 * 86400, reply_reading: true, tiles: { leads: 4, contacted: 4, replied: 2, interested: 1 },
  by_signal: [{ signal: 'hiring', leads: 2, contacted: 2, replied: 1 }, { signal: 'raised_funding', leads: 1, contacted: 2, replied: 1 }, { signal: 'unknown', leads: 1, contacted: 0, replied: 0 }],
  latest_leads: [{ id: 'l1', company: 'Bright Smile Dental', signal: 'hiring', job_id: 'a'.repeat(24), created_at: NOW - 86400 }],
  latest_replies: [{ thread_id: 't1', company: 'Lakeview Dental Group', classification: 'positive', received_at: NOW - 3600 }] }
const ZERO = { window_days: 30, since: NOW - 30 * 86400, reply_reading: true, tiles: { leads: 0, contacted: 0, replied: 0, interested: 0 }, by_signal: [], latest_leads: [], latest_replies: [] }
// reply reading off (the API's null): unknown, never 0
const OFF = { ...FULL, reply_reading: false, tiles: { ...FULL.tiles, replied: null, interested: null }, by_signal: FULL.by_signal.map(s => ({ ...s, replied: s.contacted > 0 ? null : 0 })) }
const b = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {})
const out = []
// what GET /api/home/ready answers: the counts, and the companies behind them (one row each on /app/leads/checked)
const JA = 'a'.repeat(24), JB = 'b'.repeat(24), JC = 'c'.repeat(24)
const co = (n, job, reason) => Array.from({ length: n }, (_, i) => ({ lead_id: `${reason || 'ready'}-${job.slice(0, 2)}-${i}`, company: `${reason ? 'Held' : 'Ready'} Co ${job.slice(0, 1)}${i}`, job_id: job, ready: !reason, reason }))
const mk = (o) => ({ window_days: 30, capped: false, ...o, judged: o.companies.length, ready: o.companies.filter(c => c.ready).length, leads_checked: o.leads_checked ?? o.companies.length, leads_in_window: o.leads_in_window ?? o.companies.length })
const READY = mk({ scans_checked: 3, scans_in_window: 3, scans: [{ job_id: JA, ready: 3 }],
  held: [{ reason: 'needs your review', count: 12, job_id: null, scans: 2 }, { reason: 'a required check has not passed', count: 9, job_id: JB, scans: 1 }, { reason: 'no verified date', count: 1, job_id: JB, scans: 1 }],
  companies: [...co(3, JA, ''), ...co(7, JA, 'needs your review'), ...co(5, JC, 'needs your review'), ...co(9, JB, 'a required check has not passed'), ...co(1, JB, 'no verified date')] })
async function open(width, results, ready = READY) {
  const ctx = await b.newContext({ viewport: { width, height: 900 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const writes = [], inboxUrls = []
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    if (req.method() !== 'GET') writes.push(p)
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/api/home/results') return results === 'fail' ? json({ error: 'unavailable' }, 503) : json(results)
    if (p === '/api/home/ready') return ready === 'fail' ? json({ error: 'unavailable' }, 503) : json(ready)
    if (p === '/api/scan/jobs') return json({ jobs: [] })
    // a workspace that has its business details (a brand-new one sees the onboarding wizard, not Home's results)
    if (p === '/api/settings/profile') return json({ business_name: 'Bright Smile', sells: 'Online booking for dental practices', website: 'https://brightsmile.example', buyer: { summary: 'Independent dental practices', who: ['Practice owner'], industries: [], sizes: [], where: ['Ohio'], signals: ['opened a new location'], exclude: [] }, new_play_offer: null })
    // the workspace HAS a thread (an older reply); Home's filters (?sent_since, ?class) match nothing
    if (p === '/api/outreach/inbox') { inboxUrls.push(u.search); const filtered = /sent_since=|class=/.test(u.search)
      const thread = { thread_id: 't-old', gmail_id: 'g-old', lead_id: null, job_id: null, from_email: 'pat@older.example', excerpt: 'Thanks, not now.', classification: 'other', received_at: NOW - 50 * 86400, replies: 1, company: 'Older Co', lead_name: null, followups_sent: null, stopped: null, unread: false, needs_owner: false }
      return json({ threads: filtered ? [] : [thread], counts: { threads: filtered ? 0 : 1, needs_owner: 0, unread: 0, unread_needs_owner: 0 }, next_cursor: null, read_granted: true, consent_accepted: true, account: 'dana@brightsmile.example' }) }
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(base + '/app', { waitUntil: 'networkidle' })
  return { ctx, page, writes, inboxUrls }
}
try {
  for (const width of [1280, 390]) {
    const { ctx, page, writes, inboxUrls } = await open(width, FULL)
    const sec = page.getByTestId('home-results'); await sec.waitFor({ timeout: 20000 })
    const tile = async id => (await page.getByTestId(`tile-${id}`).textContent()).replace(/\s+/g, ' ').trim()
    await page.waitForFunction(() => !/\.\.\./.test(document.querySelector('[data-testid=tile-ready]')?.textContent ?? '...'), null, { timeout: 20000 })
    assert.equal(await tile('ready'), '3Ready leads', 'the Leads page\'s ready count (acceptance 1)'); assert.match(await page.getByTestId('new-leads').textContent(), /\(4 new\)/); assert.equal(await tile('contacted'), '4Contacted'); assert.equal(await tile('replied'), '2Replied'); assert.equal(await tile('interested'), '1Interested')
    assert.equal(await page.getByTestId('tile-replied').getAttribute('href'), `/app/inbox?status=all&sent_since=${FULL.since}`)
    assert.equal(await page.getByTestId('tile-contacted').getAttribute('href'), '/app/outreach')
    // the hold breakdown under the tiles: counts in plain words, adding up, each line opening where its leads are
    assert.equal((await page.getByTestId('ready-held').textContent()).replace(/\s+/g, ' ').trim(), 'Not ready yet (22 of 25 companies checked): 12 need your review (in 2 scans), 9 held by a required check, 1 no verified date')
    assert.deepEqual(await page.getByTestId('held-line').evaluateAll(a => a.map(x => x.getAttribute('href'))), ['/app/leads/checked?why=needs%20your%20review', '/app/leads/checked?why=a%20required%20check%20has%20not%20passed', '/app/leads/checked?why=no%20verified%20date'], 'every line opens the list of the leads it counts')
    assert.equal(await page.getByTestId('tile-ready').getAttribute('href'), '/app/leads/checked?why=ready', 'the tile opens the list of its 3 ready leads')
    assert.equal(await page.getByTestId('tile-interested').getAttribute('href'), `/app/inbox?status=all&class=positive&sent_since=${FULL.since}`)
    const rows = await page.getByTestId('by-signal').locator('tbody tr').evaluateAll(trs => trs.map(tr => [...tr.children].map(td => td.textContent.trim())))
    assert.deepEqual(rows, [['Hiring', '2', '2', '1'], ['Raised funding', '1', '2', '1'], ['No signal type', '1', '0', '0']])
    assert.equal(rows.reduce((n, r) => n + Number(r[3]), 0), 2, 'the replied column adds up to the Replied tile')
    assert.match(await page.getByTestId('latest-leads').textContent(), /Bright Smile Dental/)
    assert.match(await page.getByTestId('latest-replies').textContent(), /Lakeview Dental Group Interested/)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}: no horizontal scroll`)
    assert.deepEqual(writes, [], 'Home writes nothing')
    if (process.env.SHOTS) await sec.screenshot({ path: path.join(process.env.SHOTS, `home-results-${width}.png`) })
    out.push(`${width}: tiles 4/4/2/1, by signal adds up`)
    if (width === 1280) {   // Interested opens Inbox filtered to interested replies (the API's class filter), with a way back to all
      await page.getByTestId('tile-interested').click()
      await page.getByTestId('class-filter').waitFor({ timeout: 20000 })
      assert.ok(inboxUrls.some(q => /class=positive/.test(q) && q.includes(`sent_since=${FULL.since}`)), `Inbox asked for the tile's threads (interested, sent in the window): ${JSON.stringify(inboxUrls)}`)
      assert.match(await page.getByTestId('class-filter').textContent(), /reply from a person to an email sent since .* whose latest reply is interested, as counted on Home/, 'the Inbox says it lists what the tile counts')
      // Hermes review of #1156 (1): an empty FILTERED list is the filter's, never "No replies yet" (this workspace has one)
      assert.equal(await page.getByTestId('inbox-empty').textContent(), 'No conversations match this filter.')
      const before = inboxUrls.length
      await page.getByRole('button', { name: 'Show all replies' }).click()
      await page.getByTestId('class-filter').waitFor({ state: 'detached', timeout: 20000 })
      assert.ok(!new URL(page.url()).searchParams.has('class') && !new URL(page.url()).searchParams.has('sent_since'), `Show all replies drops ?class and ?sent_since from the URL: ${page.url()}`)
      for (let i = 0; i < 100 && !inboxUrls.slice(before).some(q => !/class=|sent_since=/.test(q)); i++) await page.waitForTimeout(100)
      assert.ok(inboxUrls.slice(before).some(q => !/class=|sent_since=/.test(q)), `Inbox asked again without either filter: ${JSON.stringify(inboxUrls.slice(before))}`)
      await page.getByText('pat@older.example').first().waitFor({ timeout: 20000 })   // unfiltered: the older thread is listed
      assert.equal(await page.getByTestId('inbox-empty').count(), 0)
      out.push('Interested opens Inbox filtered (empty filter says so, not "No replies yet"); Show all replies clears the filter and the URL and lists the older thread')
      // a hand-edited date filter is said, never silently widened
      await page.goto(base + '/app/inbox?status=all&sent_since=yesterday', { waitUntil: 'networkidle' })
      await page.getByTestId('since-bad').waitFor({ timeout: 20000 })
      assert.match(await page.getByTestId('since-bad').textContent(), /date filter is not valid, so every thread is shown/)
      out.push('a malformed sent_since is said')
    }
    await ctx.close()
  }
  { const { ctx, page } = await open(1280, ZERO)
    await page.getByTestId('results-empty').waitFor({ timeout: 20000 })
    assert.match(await page.getByTestId('results-empty').textContent(), /Run your first play/)
    assert.equal(await page.getByTestId('results-empty').getByRole('link', { name: 'Run your first play' }).getAttribute('href'), '/app/leads')
    out.push('nothing in 30 days (business saved, no plays): zeros + Run your first play'); await ctx.close() }
  { const { ctx, page } = await open(390, OFF)
    await page.getByTestId('reading-off').waitFor({ timeout: 20000 })
    assert.match(await page.getByTestId('reading-off').textContent(), /unknown, not zero/)
    assert.equal(await page.getByTestId('reading-off').getByRole('link').getAttribute('href'), '/app/settings#gmail')
    for (const id of ['replied', 'interested']) assert.match(await page.getByTestId(`tile-${id}`).textContent(), /unknown/, `${id}: unknown, not a number`)
    assert.equal(await page.getByTestId('tile-contacted').textContent(), '4Contacted')
    assert.match(await page.getByTestId('by-signal').textContent(), /unknown/)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '390: no horizontal scroll')
    out.push('reply reading off: Replied and Interested unknown, with the way to turn it on'); await ctx.close() }
  // Review (Hermes-PC) at 14037ed4, finding 1: a line whose leads are in several scans opens a LIST of exactly those leads
  for (const width of [1280, 390]) { const { ctx, page } = await open(width, FULL)
    await page.getByTestId('ready-held').waitFor({ timeout: 20000 })
    // a line whose leads are all in ONE scan opens the list too: 9 rows for "9", not that scan's 10 leads
    await page.getByTestId('held-line').nth(1).click(); await page.getByTestId('checked-list').waitFor({ timeout: 20000 })
    assert.equal(await page.getByTestId('checked-title').textContent(), '9 leads: held by a required check'); assert.equal(await page.getByTestId('checked-row').count(), 9)
    await page.goto(base + '/app', { waitUntil: 'networkidle' }); await page.getByTestId('ready-held').waitFor({ timeout: 20000 })
    await page.getByTestId('held-line').first().click()
    await page.getByTestId('checked-list').waitFor({ timeout: 20000 })
    assert.equal(await page.getByTestId('checked-title').textContent(), '12 leads: need your review')
    assert.equal(await page.getByTestId('checked-row').count(), 12, 'as many rows as the line said')
    assert.deepEqual([...new Set(await page.getByTestId('checked-row').locator('a').evaluateAll(a => a.map(x => x.getAttribute('href'))))].sort(), [`/app/leads?job_id=${JA}`, `/app/leads?job_id=${JC}`], 'each row opens its own scan')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}: no horizontal scroll on the list`)
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `checked-review-${width}.png`) })
    await ctx.close() }
  out.push('a line spanning scans opens a list with as many rows as its number')
  // ready leads in two scans: the tile opens the list of ready leads; 7 rows for "7"
  { const two = mk({ scans_checked: 2, scans_in_window: 2, scans: [{ job_id: JA, ready: 4 }, { job_id: JB, ready: 3 }], held: [], companies: [...co(4, JA, ''), ...co(3, JB, '')] })
    const { ctx, page } = await open(390, FULL, two)
    await page.getByTestId('ready-scans').waitFor({ timeout: 20000 })
    assert.match(await page.getByTestId('tile-ready').textContent(), /^7Ready leadsIn 2 scans$/)
    assert.equal(await page.getByTestId('tile-ready').getAttribute('href'), '/app/leads/checked?why=ready')
    await page.getByTestId('tile-ready').click(); await page.getByTestId('checked-list').waitFor({ timeout: 20000 })
    assert.equal(await page.getByTestId('checked-title').textContent(), '7 ready leads'); assert.equal(await page.getByTestId('checked-row').count(), 7)
    out.push('ready in two scans: the tile opens 7 rows'); await ctx.close() }
  // finding 2: a limit cut the count: "or more", and how many leads were checked - never a total that is not one
  { const cut = mk({ capped: true, leads_checked: 600, leads_in_window: 1000, scans_checked: 3, scans_in_window: 5, scans: [{ job_id: JA, ready: 2 }], held: [{ reason: 'needs your review', count: 3, job_id: JB, scans: 1 }], companies: [...co(2, JA, ''), ...co(3, JB, 'needs your review')] })
    const { ctx, page } = await open(1280, FULL, cut)
    await page.getByTestId('ready-partial').waitFor({ timeout: 20000 })
    assert.equal((await page.getByTestId('tile-ready').textContent()).replace(/\s+/g, ' '), '2 or moreReady leadsFirst 600 of 1000 leads checked, newest scans first')
    assert.equal((await page.getByTestId('ready-held').textContent()).replace(/\s+/g, ' ').trim(), 'Not ready so far (3 of the 5 companies in the first 600 of 1000 leads checked): 3 need your review', 'held counts under a limit are never called "or more": one may still turn out ready')
    out.push('limit reached: ready "or more", held "so far", "First 600 of 1000 leads checked"'); await ctx.close() }
  // the real state on prod today: 0 ready, and the breakdown says why; the tile opens every checked lead
  { const zero = mk({ scans_checked: 3, scans_in_window: 3, scans: [], held: [{ reason: 'needs your review', count: 12, job_id: null, scans: 3 }, { reason: 'a required check has not passed', count: 1, job_id: JC, scans: 1 }], companies: [...co(6, JA, 'needs your review'), ...co(6, JB, 'needs your review'), ...co(1, JC, 'a required check has not passed')] })
    const { ctx, page } = await open(390, FULL, zero)
    await page.getByTestId('ready-held').waitFor({ timeout: 20000 })
    assert.match(await page.getByTestId('tile-ready').textContent(), /^0Ready leads$/)
    assert.equal((await page.getByTestId('ready-held').textContent()).replace(/\s+/g, ' ').trim(), 'Not ready yet (13 of 13 companies checked): 12 need your review (in 3 scans), 1 held by a required check')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '390: no horizontal scroll with the breakdown')
    if (process.env.SHOTS) await page.getByTestId('home-results').screenshot({ path: path.join(process.env.SHOTS, 'home-ready-zero-390.png') })
    assert.equal(await page.getByTestId('tile-ready').getAttribute('href'), '/app/leads/checked')
    await page.getByTestId('tile-ready').click(); await page.getByTestId('checked-list').waitFor({ timeout: 20000 })
    assert.equal(await page.getByTestId('checked-title').textContent(), '13 leads checked'); assert.equal(await page.getByTestId('checked-row').count(), 13)
    out.push('0 ready: the breakdown says why, and the tile opens the 13 checked leads'); await ctx.close() }
  { const { ctx, page } = await open(1280, FULL, 'fail')
    await page.getByTestId('ready-unread').waitFor({ timeout: 20000 })
    assert.equal(await page.getByTestId('ready-held').count(), 0, 'no breakdown when the check failed')
    assert.match(await page.getByTestId('tile-ready').textContent(), /could not be checked.*Could not check/)
    assert.equal(await page.getByTestId('tile-contacted').textContent(), '4Contacted', 'the other tiles still show')
    out.push('ready check failed: says so, never 0'); await ctx.close() }
  { const { ctx, page } = await open(1280, 'fail')
    await page.getByTestId('results-unread').waitFor({ timeout: 20000 })
    assert.equal(await page.getByTestId('home-results').count(), 0, 'a failed read shows no tiles (never zeros)')
    out.push('failed read: says so'); await ctx.close() }
  console.log(`home results UI check passed (real build): ${out.join('; ')}`)
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
