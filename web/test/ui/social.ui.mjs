// Rendered check for "Social opportunities" (was "Replies" / "Thread replies"). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/social.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, every /api/* call stubbed in the
// browser. It proves: the nav says "Social opportunities" (no "Replies" entry) and links to /app/social; the old URL
// /app/replies redirects there,
// its heading matches, it points email replies to Inbox, and the Inbox nav entry is unchanged. And availability:
// with Reddit/X not enabled, only a "Coming soon on this workspace" notice shows (no search box, no Add/Check buttons,
// no key prompt, no metrics); with it enabled, the searches card is there and the notice is not. Thread cards: one
// primary action per card, Approve, with Edit draft and Reject beside it (Approve / Reject before a draft); Approve
// writes a draft on the AI key, or with a draft copies it and opens the thread (dazl never posts); Edit draft opens the
// text with Save / Cancel; each card has a one-line "what happens" hint; without a key Approve is disabled with the
// reason. Clicks reach only the existing stubbed /api/replies routes. Desktop and 390px (no horizontal scroll).
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-social-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }
const b = await chromium.launch()
try {
  let enabled = false, hasKey = false, failSave = false
  const writes = [], offHost = []
  const THREADS = [
    { id: 't1', platform: 'reddit', url: 'https://www.reddit.com/r/dentistry/comments/abc', title: 'Which booking tool do you use?', quote: 'Looking for an online booking tool for a two-chair practice.', date: '2026-10-20', query: 'booking tool', buyer_intent: 'uncertain', draft: null, draft_status: null },
    { id: 't2', platform: 'x', url: 'https://x.com/someone/status/1', title: 'Need a scheduling app', quote: 'Any recommendations for dental scheduling?', date: '2026-10-21', query: 'booking tool', buyer_intent: null, draft: 'We built a booking tool for small practices - happy to share how it works.', draft_status: 'copied' },
    { id: 't3', platform: 'reddit', url: 'https://www.reddit.com/r/Dentists/comments/def', title: 'Patients keep missing appointments - what reminder system works?', quote: 'Two no-shows a day at our Park Slope office. Texts from the front desk are not cutting it.', date: '2026-10-24', query: 'appointment reminders', buyer_intent: 'yes', draft: 'Automated text + email reminders 48h and 2h before cut our no-shows roughly in half. Happy to share the setup.', draft_status: 'draft' },
  ]
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url())
    if (u.origin !== base) { offHost.push(u.href); return route.abort() }
    if (!u.pathname.startsWith('/api/')) return route.continue()
    if (req.method() !== 'GET') {
      writes.push(`${req.method()} ${u.pathname} ${req.postData()}`)
      const body = JSON.parse(req.postData() || '{}')
      if (body.action === 'save') {
        if (failSave) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Database busy"}' })
        const t = THREADS.find(x => u.pathname.endsWith(`/${x.id}`)); t.draft = body.draft; t.draft_status = 'edited' // what the server stores
      }
      return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' })
    }
    if (u.pathname === '/api/replies') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ queries: enabled ? ['booking tool'] : [], threads: enabled ? THREADS : [], platforms: { reddit: enabled, x: false }, consent: enabled, has_key: hasKey }) })
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/app/replies`, { waitUntil: 'networkidle' })
  await page.waitForURL('**/app/social')
  await page.locator('main h1').waitFor()
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'social.png') })
  if (process.env.BEFORE_ONLY) { console.log('before shot'); process.exit(0) }
  const nav = page.locator('aside')
  assert.deepEqual(await nav.getByRole('link').allTextContents().then(a => a.filter(t => /Replies|Social|Inbox/.test(t))), ['Inbox', 'Social opportunities']) // Social sits under More, after Engage
  assert.equal(await nav.getByRole('link', { name: 'Social opportunities' }).getAttribute('href'), '/app/social')
  assert.equal((await page.locator('main h1').textContent()).trim(), 'Social opportunities')
  assert.equal(await page.locator('main').getByRole('link', { name: 'Inbox' }).getAttribute('href'), '/app/inbox')
  // Not enabled on this workspace: nothing that cannot work is offered.
  const main = page.locator('main').last() // the page renders its own <main> inside the layout's
  assert.equal(await page.getByTestId('social-coming-soon').isVisible(), true)
  assert.match(await page.getByTestId('social-coming-soon').textContent(), /Coming soon on this workspace/)
  assert.equal(await main.getByRole('button').count(), 0, 'no Add or Check buttons')
  assert.equal(await main.locator('input, textarea').count(), 0, 'no search box')
  assert.equal(await main.getByRole('heading', { name: 'Searches' }).count(), 0, 'no searches card')
  assert.doesNotMatch(await main.innerText(), /Check for new threads|Reply drafts use your own AI key|No threads yet/)
  // Enabled (with consent): the searches card is there and the notice is gone.
  enabled = true
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Searches' }).waitFor()
  assert.equal(await page.getByTestId('social-coming-soon').count(), 0)
  assert.equal(await main.getByRole('button', { name: 'Check for new threads' }).count(), 1)
  assert.equal(await main.getByRole('button', { name: 'Remove search "booking tool"' }).count(), 1, 'the remove control is labelled')
  // Thread cards: labelled actions and a "what happens" hint on each.
  const cards = main.getByTestId('thread-actions')
  assert.equal(await cards.count(), 3)
  const first = cards.nth(0), second = cards.nth(1)
  assert.deepEqual(await first.getByRole('button').allTextContents(), ['Approve', 'Reject'])
  assert.equal(await first.getByRole('button', { name: 'Approve' }).isDisabled(), true, 'no key: Approve cannot write the reply')
  assert.equal(await first.getByTestId('action-hint').textContent(), 'Approve needs your AI key to write the reply (add one in Settings). Reject hides this thread.')
  assert.deepEqual(await second.getByRole('button').allTextContents(), ['Approve', 'Edit draft', 'Reject', 'I posted it'])
  assert.equal(await second.getByTestId('action-hint').textContent(), 'dazl never posts. Approve copies your reply and opens the thread so you post it from your own account. Reject hides this thread.')
  for (const c of await cards.all()) assert.equal(await c.locator('.btn-primary').count(), 1, 'one primary action per card')
  assert.equal(await main.getByTestId('thread-card').nth(1).getByTestId('draft-text').textContent(), THREADS[1].draft, 'the draft is shown before you approve it')
  for (const btn of await main.getByTestId('thread-actions').getByRole('button').all()) assert.ok((await btn.textContent()).trim().length >= 4, 'no icon-only or one-letter action')
  if (process.env.SHOTS) { await main.getByTestId('thread-card').first().scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(process.env.SHOTS, 'social-enabled.png') }); await second.locator('xpath=..').screenshot({ path: path.join(process.env.SHOTS, 'social-drafted-card.png') }) }
  // Edit draft: the text opens with Save / Cancel; Cancel writes nothing and restores the saved draft.
  const card2 = main.getByTestId('thread-card').nth(1)
  const box = card2.getByRole('textbox', { name: 'Your reply' })
  const SAVED = THREADS[1].draft
  await second.getByRole('button', { name: 'Edit draft' }).click()
  await box.fill('Edited reply')
  await card2.getByRole('button', { name: 'Cancel' }).click()
  assert.equal(await card2.getByTestId('draft-text').textContent(), SAVED, 'Cancel restores the saved draft')
  assert.deepEqual(writes.splice(0), [])
  // A failed Save (Instinct #333): the editor stays open with the typed text, the error is on this card, and the saved
  // draft and its status are unchanged; Cancel then restores the last server-confirmed draft.
  failSave = true
  await second.getByRole('button', { name: 'Edit draft' }).click()
  await box.fill('Edited reply')
  await card2.getByRole('button', { name: 'Save' }).click()
  await card2.getByTestId('card-error').waitFor()
  assert.equal(await card2.getByTestId('card-error').textContent(), 'Not saved: Database busy. Your text is still here; try Save again.')
  assert.equal(await box.isVisible(), true, 'the editor stays open')
  assert.equal(await box.inputValue(), 'Edited reply', 'with the typed text')
  assert.equal(await card2.getByTestId('draft-status').textContent(), 'Copied', 'the status is unchanged')
  assert.equal(await page.getByText('Database busy').count(), 1, 'the error shows once, beside the card, not above the list')
  await card2.getByRole('button', { name: 'Cancel' }).click()
  assert.equal(await card2.getByTestId('draft-text').textContent(), SAVED, 'the displayed draft is still the saved one')
  assert.equal(await card2.getByTestId('card-error').count(), 0)
  await page.reload({ waitUntil: 'networkidle' }); await cards.first().waitFor()
  assert.equal(await card2.getByTestId('draft-text').textContent(), SAVED, 'after reload too')
  // Retry: fail, then Save again succeeds and closes the editor with the saved text shown.
  await second.getByRole('button', { name: 'Edit draft' }).click()
  await box.fill('Edited reply')
  await card2.getByRole('button', { name: 'Save' }).click()
  await card2.getByTestId('card-error').waitFor()
  failSave = false
  await card2.getByRole('button', { name: 'Save' }).click()
  // Wait for the saved text itself: the element appears before the refresh that follows the save lands (Instinct, #333).
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=thread-card]')[1]?.querySelector('[data-testid=draft-text]')?.textContent === 'Edited reply', null, { timeout: 10000 })
  assert.equal(await card2.getByTestId('draft-text').textContent(), 'Edited reply')
  assert.equal(await card2.getByTestId('card-error').count(), 0)
  assert.equal(await card2.getByTestId('draft-status').textContent(), 'Edited')
  assert.deepEqual(writes.splice(0), Array(3).fill('POST /api/replies/t2 {"action":"save","draft":"Edited reply"}'))
  // Approve with a draft: copies and opens the thread (the popup is aborted off-host), recorded as copied; nothing posted.
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
  const popup = page.waitForEvent('popup')
  await cards.nth(2).getByRole('button', { name: 'Approve' }).click()
  await (await popup).close()
  await page.waitForTimeout(400)
  assert.ok(offHost.includes(THREADS[2].url), 'Approve opened the thread itself')
  assert.deepEqual(writes.splice(0), ['POST /api/replies/t3 {"action":"mark","status":"copied"}'])
  // 390px: the same cards, readable, no horizontal scroll.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload({ waitUntil: 'networkidle' }); await cards.first().waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scroll at 390px')
  for (const c of await cards.all()) for (const btn of await c.getByRole('button').all()) { const bb = await btn.boundingBox(); assert.ok(bb.x >= 0 && bb.x + bb.width <= 390, 'every action on screen') }
  if (process.env.SHOTS) { await main.getByTestId('thread-card').nth(2).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(process.env.SHOTS, 'social-390.png') }) }
  await page.setViewportSize({ width: 1280, height: 800 })
  // With a key: Draft reply works; it and Dismiss reach only the existing endpoints (stubbed).
  hasKey = true
  await page.reload({ waitUntil: 'networkidle' })
  await cards.first().waitFor()
  if (process.env.SHOTS) { await main.getByTestId('thread-card').first().scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(process.env.SHOTS, 'social-desktop.png') }) }
  assert.equal(await cards.nth(0).getByTestId('action-hint').textContent(), 'Approve writes a suggested reply on your AI key for you to check. Nothing is posted. Reject hides this thread.')
  await cards.nth(0).getByRole('button', { name: 'Approve' }).click()
  await cards.nth(0).getByRole('button', { name: 'Reject' }).click()
  await page.waitForTimeout(500)
  assert.deepEqual(writes, ['POST /api/replies/t1 {"action":"draft"}', 'POST /api/replies {"action":"dismiss","id":"t1"}'])
  // An old bookmark (with a query string) still lands on the renamed page, signed in.
  await page.goto(`${base}/app/replies?from=bookmark`, { waitUntil: 'networkidle' })
  await page.waitForURL('**/app/social')
  assert.equal(new URL(page.url()).pathname, '/app/social')
  assert.equal((await page.locator('main h1').first().textContent()).trim(), 'Social opportunities')
  console.log('social opportunities UI check passed')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
