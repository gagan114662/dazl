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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-reqfail-ui-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }
// #902 request-lifecycle failures, rendered on the production build at phone (390x844) and desktop (1280x900).
// Every /api/* call is stubbed per test (throwaway database, net-fenced server; no Gmail, no posting, no sends, no
// provider calls). Proves: rejected fetch, 401/403/500 and malformed responses each reach a visible error with a deliberate
// retry (never an endless Loading or a silently missing panel); retry recovers; a successful-empty thread read has its own
// terminal state; failed mutations (reject, posted, monitor delete) are reported and never auto-reissued.
// NOT part of `npm test`. Run:  cd web && npm run build && node test/ui/request-failures.ui.mjs   (SHOTS=<dir> for screenshots)
const now = Math.floor(Date.now() / 1000)
const b = await chromium.launch()
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
// handler(u, req, json) -> response | undefined (undefined = 404 {}); 'abort' = rejected fetch
async function open(url, [width, height], handler) {
  const ctx = await b.newContext({ viewport: { width, height } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const hits = []
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    hits.push(`${req.method()} ${p}${u.search}`)
    const res = handler(u, req)
    if (res === 'abort') return route.abort('failed')
    if (res && res.raw !== undefined) return route.fulfill({ status: res.status ?? 200, contentType: 'application/json', body: res.raw })
    if (res) return route.fulfill({ status: res.status ?? 200, contentType: 'application/json', body: JSON.stringify(res.body ?? {}) })
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  })
  const page = await ctx.newPage()
  await page.goto(base + url, { waitUntil: 'networkidle' })
  return { ctx, page, hits }
}
const count = (hits, s) => hits.filter(h => h.startsWith(s)).length
const SETTINGS = { gmail: { email: 'me@x.example', status: 'active', read_granted: true }, sender: { sender_name: 'Sam', postal_address: 'Synthetic test address' } }
const THREAD = { id: 't1', platform: 'reddit', url: 'https://reddit.example/t1', title: 'Which outbound tool?', quote: 'Looking for a tool', query: 'outbound tool', date: null, created_at: now, buyer_intent: null, draft: 'Try a reviewed approach.', draft_status: 'draft' }
const REPLIES = { queries: ['outbound tool'], threads: [THREAD], platforms: { reddit: true, x: false }, consent: true, has_key: true }
const ROW = { gmail_id: 'g1', thread_id: 'th1', from_email: 'a@b.example', excerpt: 'Sounds good', classification: 'other', received_at: now, replies: 1, company: 'Acme', lead_name: null, followups_sent: 0, stopped: null, unread: false, needs_owner: false }
const INBOX = { available: true, consent_accepted: true, read_granted: true, account: 'me@x.example', booking_url: null, threads: [ROW, { ...ROW, gmail_id: 'g2', thread_id: 'th2', company: 'Empty Co' }], next_cursor: 'th2', counts: { threads: 3, needs_owner: 0, unread: 0, unread_needs_owner: 0 } }
const SIZES = { phone: [390, 844], desktop: [1280, 900] }
try {
  for (const [size, vp] of Object.entries(SIZES)) {
    // Send readiness: each failure mode shows "readiness unknown" with Try again; retry recovers.
    for (const [mode, fail] of [['reject', () => 'abort'], ['401', () => ({ status: 401, body: { error: 'unauthorized' } })], ['500', () => ({ status: 500 })], ['malformed', () => ({ raw: '<html>' })]]) {
      let ok = false
      const { ctx, page } = await open('/app/outreach', vp, u => u.pathname === '/api/outreach/settings' ? (ok ? { body: SETTINGS } : fail()) : undefined)
      await page.getByTestId('send-readiness-error').waitFor({ timeout: 15000 })
      if (mode === '401') assert.match(await page.getByTestId('send-readiness-error').textContent(), /session may have expired/)
      await shot(page, `send-readiness-${mode}-${size}`)
      ok = true
      await page.getByTestId('send-readiness-error').getByRole('button', { name: 'Try again' }).click()
      await page.getByText('Ready to send from me@x.example', { exact: false }).waitFor()
      await ctx.close()
    }
    // Social: failed first read is an error (not endless Loading); retry recovers; failed reject/posted are reported.
    {
      let ok = false, mut = 0
      const { ctx, page, hits } = await open('/app/social', vp, (u, req) => {
        if (u.pathname === '/api/replies' && req.method() === 'GET') return ok ? { body: REPLIES } : { status: 500 }
        if (u.pathname.startsWith('/api/replies') && req.method() === 'POST') { mut++; return mut === 1 ? { status: 500, body: { error: 'server error' } } : 'abort' }
        if (u.pathname.startsWith('/api/replies/metrics') || u.pathname.includes('metrics')) return { body: {} }
      })
      await page.getByTestId('social-load-error').waitFor({ timeout: 15000 })
      await shot(page, `social-load-error-${size}`)
      ok = true
      await page.getByRole('button', { name: 'Try again' }).click()
      await page.getByTestId('thread-card').waitFor()
      await page.getByRole('button', { name: 'Reject' }).click()
      await page.getByTestId('card-error').filter({ hasText: 'Not rejected' }).waitFor()
      assert.equal(await page.getByTestId('thread-card').count(), 1, 'a failed reject keeps the thread')
      await page.getByRole('button', { name: 'I posted it' }).click()
      await page.getByTestId('card-error').filter({ hasText: 'Not marked as posted' }).waitFor()
      assert.equal(count(hits, 'POST /api/replies'), 2, 'each failed mutation was sent once, never auto-reissued')
      await shot(page, `social-mutation-error-${size}`)
      await ctx.close()
    }
    // Social copy: a denied clipboard never shows "Copied" or records the copied status.
    {
      const { ctx, page, hits } = await open('/app/social', vp, (u, req) => u.pathname === '/api/replies' && req.method() === 'GET' ? { body: REPLIES } : undefined)
      await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } }); window.open = () => null })
      await page.getByTestId('thread-card').getByRole('button', { name: 'Approve' }).click()
      await page.getByTestId('card-error').filter({ hasText: 'Copy failed' }).waitFor()
      assert.equal(await page.getByText('Copied - paste it in the thread').count(), 0)
      assert.equal(hits.filter(h => h.startsWith('POST /api/replies/t1')).length, 0, 'no copied status recorded')
      await ctx.close()
    }
    // SEO: a rejected brief POST clears busy and keeps the topic; the indexing panel says it failed instead of vanishing.
    {
      let idxOk = false
      const { ctx, page } = await open('/app/seo', vp, (u, req) => {
        if (u.pathname === '/api/seo/brief') return req.method() === 'POST' ? 'abort' : { body: { briefs: [] } }
        if (u.pathname === '/api/seo/indexing') return idxOk ? { body: { config: null, keywords: [], results: [], allowance: { used: 0, limit: 10 } } } : { status: 403, body: { error: 'forbidden' } }
        if (u.pathname === '/api/seo/newsjack') return { raw: 'not json' }
        if (u.pathname === '/api/seo/audit') return { body: { audits: [] } }
      })
      await page.getByTestId('indexing-load-error').waitFor({ timeout: 15000 })
      await page.getByTestId('newsjack-load-error').waitFor()
      const topic = page.getByPlaceholder('e.g. how to find b2b leads without cold email')
      await topic.fill('cold email alternatives')
      await page.getByRole('button', { name: 'Draft brief' }).click()
      await page.getByTestId('brief-error').waitFor()
      assert.equal(await topic.inputValue(), 'cold email alternatives', 'topic kept')
      assert.equal(await page.getByRole('button', { name: 'Draft brief' }).isEnabled(), true, 'busy cleared after a rejected fetch')
      await shot(page, `seo-errors-${size}`)
      idxOk = true
      await page.getByTestId('indexing-load-error').getByRole('button', { name: 'Try again' }).click()
      await page.getByRole('button', { name: 'Save domain' }).waitFor()
      await ctx.close()
    }
    // Inbox: a failed thread read and a successful-empty read each get a terminal state; failed load-more is reported.
    {
      let th1 = 0
      const { ctx, page } = await open('/app/inbox', vp, u => {
        if (u.pathname !== '/api/outreach/inbox') return u.pathname === '/api/outreach/conversion' ? { body: { rows: [] } } : u.pathname === '/api/outreach/settings' ? { body: SETTINGS } : undefined
        const t = u.searchParams.get('thread_id')
        if (t === 'th1') return ++th1 === 1 ? { status: 500 } : { body: { messages: [{ dir: 'in', kind: 'reply', subject: null, body: 'Sounds good', at: now, classification: 'other' }] } }
        if (t === 'th2') return { body: { messages: [] } }
        if (u.searchParams.get('cursor')) return 'abort'
        return { body: INBOX }
      })
      await page.getByTestId('inbox-thread').first().waitFor({ timeout: 15000 })
      await page.getByTestId('inbox-thread').nth(0).getByRole('button', { name: 'View thread' }).click()
      await page.getByTestId('thread-error').waitFor()
      await page.getByTestId('thread-error').getByRole('button', { name: 'Try again' }).click()
      await page.getByTestId('inbox-thread').nth(0).getByText('Sounds good').nth(1).waitFor()
      await page.getByTestId('inbox-thread').nth(1).getByRole('button', { name: 'View thread' }).click()
      await page.getByTestId('thread-empty').waitFor()
      await page.getByTestId('inbox-more').click()
      await page.getByTestId('inbox-more-error').waitFor()
      assert.equal(await page.getByTestId('inbox-thread').count(), 2, 'failed load-more keeps the list')
      await shot(page, `inbox-errors-${size}`)
      await ctx.close()
    }
    // Leads monitors: a failed delete is reported and the monitor stays; not reissued.
    {
      const { ctx, page, hits } = await open('/app/leads', vp, (u, req) => {
        if (u.pathname === '/api/monitors') return { body: { monitors: [{ id: 'm1', query: 'saas founders', enabled: true, run_count: 2, last_new_count: null }] } }
        if (u.pathname === '/api/monitors/m1' && req.method() === 'DELETE') return { status: 500, body: { error: 'server error' } }
      })
      await page.getByText('saas founders').waitFor({ timeout: 15000 })
      await page.getByRole('button', { name: 'Delete' }).click()
      await page.getByTestId('monitor-error').filter({ hasText: 'Could not delete the monitor' }).waitFor()
      assert.equal(count(hits, 'DELETE /api/monitors/m1'), 1)
      await shot(page, `leads-monitor-error-${size}`)
      await ctx.close()
    }
  }
  console.log('request-failures UI check passed (#902): send readiness, social, SEO, inbox and lead monitors show truthful error/empty states with retry at phone and desktop; failed mutations are reported once and not reissued')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
