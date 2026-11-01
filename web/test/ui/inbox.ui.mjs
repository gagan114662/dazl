import { READ_CONSENT_TEXT, READ_CONSENT_VERSION } from '../../lib/outreach/read-consent.ts'
// Inbox list on the production build: one row per thread, filters, totals and "Show older" paging all come from the
// server (lib/outreach/inbox.ts, #369). Every /api/* call is stubbed (throwaway database, server under
// test/helpers/net-fence.ts; no Gmail, no email, no spend). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/inbox.ui.mjs   (SHOTS=<dir> saves the screenshots)
// Proves: the page asks the server for each filter and page (never one account-wide capped list); paging appends with no
// duplicates and stops at the end; the filter totals are the server's; ?job_id&status=needs_owner (the Outcomes link)
// scopes the list to that play; opening an unread thread marks it read once (POST) and the unread total drops by one.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-inbox-ui-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const now = Math.floor(Date.now() / 1000)
const OLD = 'a'.repeat(24), BUSY = 'b'.repeat(24), BOUNCE = 'c'.repeat(24)
// 120 newer threads in a busy play, then one older interested reply in another play.
const THREADS = [
  ...Array.from({ length: 120 }, (_, i) => ({ thread_id: `t${String(i).padStart(3, '0')}`, gmail_id: `g${i}`, lead_id: `l${i}`, job_id: BUSY, from_email: `p${i}@busy.example`, excerpt: `Busy reply ${i}`, classification: i % 3 === 0 ? 'negative' : 'positive', received_at: now - i * 60, replies: 1, company: `Busy ${i}`, lead_name: null, followups_sent: 0, stopped: null, unread: i % 2 === 0 })),
  { thread_id: 'old', gmail_id: 'gold', lead_id: 'lold', job_id: OLD, from_email: 'ceo@older.example', excerpt: 'Yes - send details', classification: 'positive', received_at: now - 40 * 86400, replies: 2, company: 'Older Co', lead_name: 'Sam', followups_sent: 1, stopped: null, unread: true },
  // #415: a reply that looked like a bounce but did not verify - it must surface as its own amber badge, under Needs you.
  { thread_id: 'bounce', gmail_id: 'gbounce', lead_id: 'lbounce', job_id: BOUNCE, from_email: 'ops@wobble.example', excerpt: 'delivery status notification', classification: 'bounce_review', received_at: now - 3600, replies: 1, company: 'Wobble Works', lead_name: 'Rae', followups_sent: 0, stopped: null, unread: false },
].map(t => ({ ...t, needs_owner: ['positive', 'other', 'bounce_review'].includes(t.classification) && !t.stopped }))

function serve(u, reads) {
  const st = u.searchParams.get('status') ?? 'all', job = u.searchParams.get('job_id'), cursor = u.searchParams.get('cursor')
  const limit = 50
  const scoped = THREADS.map(t => ({ ...t, unread: t.unread && !reads.has(t.thread_id) })).filter(t => !job || t.job_id === job)
  const rows = scoped.filter(t => st === 'all' || (st === 'needs_owner' ? t.needs_owner : t.unread)).sort((a, b) => b.received_at - a.received_at)
  const start = cursor ? rows.findIndex(t => t.thread_id === cursor) + 1 : 0
  const page = rows.slice(start, start + limit)
  return {
    available: true, consent_accepted: true, read_granted: true, account: 'me@x.example', booking_url: null,
    threads: page, next_cursor: start + limit < rows.length ? page.at(-1).thread_id : null,
    counts: { threads: scoped.length, needs_owner: scoped.filter(t => t.needs_owner).length, unread: scoped.filter(t => t.unread).length, unread_needs_owner: scoped.filter(t => t.unread && t.needs_owner).length },
  }
}

const b = await chromium.launch()
// delay(u, method) -> ms: hold that response back (the body is computed when the request arrives, as a server would)
async function open(url, width = 1280, height = 900, delay = () => 0, connected = true) {
  const ctx = await b.newContext({ viewport: { width, height } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const reads = new Set(), calls = [], posts = []
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const wait = ms => new Promise(r => setTimeout(r, ms))
    if (p === '/api/outreach/inbox' && req.method() === 'POST') { const body = JSON.parse(req.postData() || '{}'); posts.push(body); reads.add(body.thread_id); await wait(delay(u, 'POST')); return json({ ok: true }) }
    if (p === '/api/outreach/inbox') {
      if (!connected) return json({ available: false, consent_accepted: false, read_granted: false, account: null, threads: [], counts: { threads: 0, needs_owner: 0, unread: 0, unread_needs_owner: 0 } })
      if (u.searchParams.get('thread_id')) return json({ messages: [{ dir: 'in', kind: 'reply', subject: null, body: 'Yes - send details', at: now, classification: 'positive' }] })
      calls.push(u.search); const body = serve(u, reads); await wait(delay(u, 'GET')); return json(body)
    }
    if (p === '/api/outreach/replies') return json({ available: true, gmail_connected: true, read_granted: false, consent: { version: READ_CONSENT_VERSION, text: READ_CONSENT_TEXT, accepted: false }, followups_enabled: false, autopilot_on: false, inbound: [] })
    if (p === '/api/outreach/settings') return json({ gmail: { email: 'me@x.example', status: 'active', read_granted: true }, sender: { sender_name: 'Sam', postal_address: 'Synthetic test address' }, daily_cap: 5, sent_24h: 0, read_notice: READ_CONSENT_TEXT })
    if (p === '/api/outreach/conversion') return json({ rows: [] })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(base + url, { waitUntil: 'networkidle' })
  return { ctx, page, calls, posts }
}
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
const ids = async page => page.getByTestId('inbox-thread').evaluateAll(els => els.map(e => e.textContent))
try {
  {
    const { ctx, page } = await open('/app/settings', 390, 844)
    const panel = page.locator('#gmail')
    await panel.getByText('Reply reading: on. Replies in dazl outreach threads and delivery-failure notices for its sends are checked.', { exact: true }).waitFor()
    await panel.getByRole('button', { name: 'More information' }).first().click()
    await panel.getByText(/To find separate-thread delivery failures, dazl searches mailer-daemon and postmaster notices/).waitFor()
    // Consent text must never be clipped: the whole popover stays inside the viewport, even on a 390px phone.
    const tip = panel.getByTestId('infotip-text').first()
    const bb = await tip.boundingBox()
    const vw = page.viewportSize().width
    assert.ok(bb, 'popover has a box')
    assert.ok(bb.x >= 0 && bb.x + bb.width <= vw, `popover ${Math.round(bb.x)}..${Math.round(bb.x + bb.width)} inside 0..${vw}`)
    const tipText = await tip.innerText()
    for (const clause of ['searches mailer-daemon and postmaster notices in a bounded time window', 'Unmatched notice content is not kept as a reply', 'untick the read access and still connect send-only'])
      assert.ok(tipText.includes(clause), `popover keeps the clause: ${clause}`)
    await panel.scrollIntoViewIfNeeded()
    await shot(page, 'gmail-settings-scope-mobile')
    assert.equal(await panel.getByText(/Only threads dazl started are read|never lists, searches, or reads anything else/).count(), 0)
    await ctx.close()
  }
  {
    const { ctx, page } = await open('/app/inbox', 390, 844, () => 0, false)
    await page.getByText(/With your consent, dazl reads replies in its outreach threads and checks delivery-failure notices for its sends/).waitFor()
    assert.equal(await page.getByText(/Only replies to outreach threads|nothing else in your mailbox|Nothing else in (?:your|the) mailbox is read/).count(), 0)
    for (const text of READ_CONSENT_TEXT) await page.getByText(text, { exact: true }).waitFor()
    // The page's main pane scrolls inside a fixed-height layout: bring the whole consent card on screen so the
    // capture (and the person) reaches the last clauses, not just the first.
    await page.getByText(READ_CONSENT_TEXT[READ_CONSENT_TEXT.length - 1], { exact: true }).scrollIntoViewIfNeeded()
    await page.getByText(/untick the read access and still connect send-only/).scrollIntoViewIfNeeded()
    await shot(page, 'inbox-disconnected-mobile')
    await ctx.close()
  }
  {
    const { ctx, page, calls } = await open('/app/inbox')
    await page.getByTestId('inbox-filters').waitFor({ timeout: 15000 })
    await page.getByText('Replies in the email threads dazl started for you, plus delivery-failure notices checked for those sends.', { exact: true }).waitFor()
    assert.equal(await page.getByText(/Nothing else in (?:your|the) mailbox is read/).count(), 0, 'scope disclosure includes the delivery-notice search')
    assert.match(await page.getByTestId('inbox-filter-all').textContent(), /All\s*122/)
    assert.match(await page.getByTestId('inbox-filter-needs_owner').textContent(), /Needs you\s*82/)
    assert.match(await page.getByTestId('inbox-filter-unread').textContent(), /Unread\s*61/)
    assert.equal(await page.getByTestId('inbox-thread').count(), 50)
    await page.getByTestId('inbox-more').click(); await page.waitForFunction(() => document.querySelectorAll('[data-testid=inbox-thread]').length === 100)
    await page.getByTestId('inbox-more').click(); await page.waitForFunction(() => document.querySelectorAll('[data-testid=inbox-thread]').length === 122)
    assert.equal(await page.getByTestId('inbox-more').count(), 0, 'no more pages at the end')
    const rows = await ids(page)
    assert.equal(new Set(rows).size, 122, 'no duplicates across pages')
    assert.match(rows.at(-1), /Older Co/, 'the oldest conversation is reachable')
    assert.ok(calls.every(c => /status=all/.test(c)) && calls.length === 3, 'each page is its own server call')
    await page.getByTestId('inbox-filter-needs_owner').click(); await page.waitForFunction(() => document.querySelectorAll('[data-testid=inbox-thread]').length === 50)
    assert.ok(calls.at(-1).includes('status=needs_owner'))
    await shot(page, 'inbox-desktop')
    await ctx.close()
  }
  {
    // The Outcomes link: this play only, needing the owner. The older conversation is the first row, not hidden behind 120 newer ones.
    const { ctx, page, posts } = await open(`/app/inbox?status=needs_owner&job_id=${OLD}`, 390, 844)
    await page.getByTestId('inbox-filters').waitFor({ timeout: 15000 })
    const rows = await ids(page)
    assert.equal(rows.length, 1); assert.match(rows[0], /Older Co/); assert.match(rows[0], /2 replies/)
    assert.match(await page.getByTestId('inbox-filters').textContent(), /This play only/)
    assert.match(await page.getByTestId('inbox-filter-unread').textContent(), /Unread\s*1/)
    await page.getByRole('button', { name: 'View thread' }).click()
    await page.waitForFunction(() => /Unread\s*0/.test(document.querySelector('[data-testid=inbox-filter-unread]')?.textContent ?? ''))
    assert.deepEqual(posts, [{ thread_id: 'old', action: 'read' }])
    await page.getByRole('button', { name: 'Hide thread' }).click(); await page.getByRole('button', { name: 'View thread' }).click()
    assert.equal(posts.length, 1, 'a read thread is not marked again')
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth)
    assert.ok(scrollW <= 390, `no horizontal scroll at 390px (${scrollW})`)
    await shot(page, 'inbox-play-mobile')
    await ctx.close()
  }
  // Stale responses (Instinct #425 review): a response to an earlier query never shows under, or changes, a later one.
  const pressed = async (page, st) => (await page.getByTestId(`inbox-filter-${st}`).getAttribute('aria-pressed')) === 'true'
  const settle = ms => new Promise(r => setTimeout(r, ms))
  {
    // Slow first, fast second: Needs you is held back 1.2 s; Unread is clicked right after and answers at once.
    const { ctx, page } = await open('/app/inbox', 1280, 900, u => u.searchParams.get('status') === 'needs_owner' ? 1200 : 0)
    await page.getByTestId('inbox-filters').waitFor({ timeout: 15000 })
    await page.getByTestId('inbox-filter-needs_owner').click()
    await page.getByTestId('inbox-filter-unread').click()
    await settle(1800)
    assert.ok(await pressed(page, 'unread'))
    const rows = await ids(page)
    assert.equal(rows.length, 50)
    const unreadIds = new Set(THREADS.filter(t => t.unread).map(t => t.company))
    assert.equal(rows.filter(r => ![...unreadIds].some(c => r.includes(c + ' ') || r.includes(c + '('))).length, 0, 'no read row from the late Needs you response under Unread')
    assert.equal(await page.locator('[data-testid=inbox-thread] [aria-label=Unread]').count(), 50, 'every row shown under Unread is unread')
    assert.match(await page.getByTestId('inbox-filter-unread').textContent(), /Unread\s*61/, 'Unread total from its own response')
    await ctx.close()
  }
  {
    // Load more, then switch: the older page is held back; Needs you is clicked meanwhile. The late page must not be
    // appended to the Needs you list.
    const { ctx, page } = await open('/app/inbox', 1280, 900, u => u.searchParams.get('cursor') ? 1200 : 0)
    await page.getByTestId('inbox-filters').waitFor({ timeout: 15000 })
    await page.getByTestId('inbox-more').click()
    await page.getByTestId('inbox-filter-needs_owner').click()
    await settle(1800)
    assert.ok(await pressed(page, 'needs_owner'))
    const rows = await ids(page)
    assert.equal(rows.length, 50, 'only the Needs you first page')
    assert.equal(rows.filter(r => /not interested/.test(r)).length, 0, 'no row of the All list (not interested) appended')
    await ctx.close()
  }
  {
    // Play scope: start in one play, pick Unread for it (held back), then Show every play (fast). The late play-scoped
    // page must not replace the every-play list.
    const { ctx, page } = await open(`/app/inbox?job_id=${OLD}`, 1280, 900, u => u.searchParams.get('job_id') && u.searchParams.get('status') === 'unread' ? 1200 : 0)
    await page.getByTestId('inbox-filters').waitFor({ timeout: 15000 })
    await page.getByTestId('inbox-filter-unread').click()
    await page.getByRole('button', { name: 'Show every play' }).click()
    await settle(1800)
    assert.equal(await page.getByTestId('inbox-play-scope').count(), 0)
    const rows = await ids(page)
    assert.equal(rows.length, 50, 'the every-play Unread page, not the one-thread play page')
    assert.match(await page.getByTestId('inbox-filter-unread').textContent(), /Unread\s*61/)
    await ctx.close()
  }
  {
    // A late mark-read: open an unread thread under All (its POST held back), switch to Needs you before it answers.
    // The Needs you counts are the server's; the late success does not decrement them again.
    const { ctx, page, posts } = await open('/app/inbox', 1280, 900, (u, m) => m === 'POST' ? 1200 : 0)
    await page.getByTestId('inbox-filters').waitFor({ timeout: 15000 })
    await page.getByTestId('inbox-thread').first().getByRole('button', { name: 'View thread' }).click()
    await page.getByTestId('inbox-filter-needs_owner').click()
    await settle(1800)
    assert.equal(posts.length, 1)
    assert.ok(await pressed(page, 'needs_owner'))
    // The server counted the read when the POST arrived (before the Needs you page was computed): 60 unread, once.
    assert.match(await page.getByTestId('inbox-filter-unread').textContent(), /Unread\s*60/, 'not decremented a second time by the late response')
    await ctx.close()
  }
  {
    // #415: the bounce_review badge - amber "possible bounce - unverified" on the right company, under Needs you.
    const { ctx, page } = await open(`/app/inbox?status=needs_owner&job_id=${BOUNCE}`)
    await page.getByTestId('inbox-filters').waitFor({ timeout: 15000 })
    const rows = await page.getByTestId('inbox-thread').all()
    assert.equal(rows.length, 1, 'the play scopes to its one bounce_review thread')
    assert.match(await rows[0].textContent(), /Wobble Works/)
    const badge = rows[0].getByText('possible bounce - unverified', { exact: true })
    assert.equal(await badge.count(), 1, 'the bounce badge renders its own label (not "needs your review")')
    const cls = await badge.getAttribute('class')
    assert.ok(cls?.includes('text-[#8a5a00]') && cls?.includes('border-[#e8b04a]'), `the bounce badge is amber (${cls})`)
    await shot(page, 'inbox-bounce-review')
    await ctx.close()
  }
  console.log('inbox UI check passed: server-side filters and totals, paging to the end with no duplicates, play-scoped Outcomes link finds the older conversation, opening marks read once; stale responses (slow first filter, load-more then switch, play-scope change, late mark-read) never reach a later query')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
