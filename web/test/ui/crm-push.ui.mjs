// Rendered check for the Leads page "Push to CRM" control (#365, app/app/leads/crm-push.tsx). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/crm-push.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database with one synthetic scan and lead, server under test/helpers/net-fence.ts.
// ONLY /api/crm is answered from a stub in the browser (no CRM request is possible); every other route is the real app.
// Off-host requests are aborted. At desktop (1280) and phone (390) width it proves:
//   1. a delayed push: the button is disabled while it is on its way, so a double click sends ONE push;
//   2. "in progress" (409) never strands the lead: a bounded read-only recheck (status, at most 5, never a push) ends in
//      done, in the unknown-result controls, in "push again" when nothing was created, or in "Check again";
//   3. a failed push offers "Try again"; an unknown result offers only the two resolution choices, and "It is not
//      there" brings the push back;
//   4. reconnect (a new key for the same CRM) keeps the unknown hold; a reload shows the button, and the server's hold
//      answers it again with the resolution choices, not a second create;
//   5. every control is on screen and is what a click there hits, with no horizontal scroll.
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
const { migrateAllSqlite } = await import(path.join(dir, 'lib/db/sqlite-migrations.ts'))
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-crmpush-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
migrateAllSqlite(db)
const JOB = 'a'.repeat(24)
db.prepare("INSERT INTO users (id, email, password_hash, salt) VALUES ('u1', 's@example.test', 'x', 'y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600)
db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query) VALUES (?, 'u1', 'Synthetic Co', 'i', 'l', 'running', 'Synthetic buyers hiring')").run(JOB)
db.prepare("INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, evidence_excerpt, confidence, fit, intent, why) VALUES ('lead-synth-1', ?, 'Synthetic Buyer International Holdings', 'Pat Example', 'pat@buyer.example', 'Hiring a sales lead', 'https://news.example/a', 'Synthetic Buyer is hiring a sales lead.', 80, 4, 4, 'synthetic')").run(JOB)
db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(JOB); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const sleep = ms => new Promise(r => setTimeout(r, ms))
const PROGRESS = { status: 409, json: { outcome: 'in_progress', error: 'This lead is being pushed right now. Wait a moment, then check your CRM.' } }
const b = await chromium.launch()
async function scenario(w, name, answer, run) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const page = await ctx.newPage(); const calls = []
  await page.route(u => u.origin !== base, r => r.abort())
  await page.route('**/api/crm', async r => {
    if (r.request().method() === 'GET') return r.fulfill({ json: { configured: true, provider: 'hubspot' } })
    const body = JSON.parse(r.request().postData() || '{}'); calls.push(body.action)
    const a = answer(body, calls); if (a.delay) await sleep(a.delay)
    return r.fulfill({ status: a.status ?? 200, json: a.json })
  })
  const open = async () => {
    await page.waitForFunction(() => document.querySelectorAll('details').length > 0, null, { timeout: 15000 })
    await page.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true }))
    await page.getByTestId('crm-push').waitFor()
  }
  await page.goto(`${base}/app/leads?job_id=${JOB}`, { waitUntil: 'networkidle' }); await open()
  // what the control shows, and that each of its buttons is on screen and is what a click at its centre hits
  const state = async tag => {
    const el = page.getByTestId('crm-push'); await el.scrollIntoViewIfNeeded()
    const buttons = await el.locator('button').evaluateAll(bs => bs.map(b => { const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { label: b.innerText.trim(), disabled: b.disabled, reachable: r.width > 0 && r.left >= 0 && r.right <= window.innerWidth && (hit === b || b.contains(hit)) } }))
    assert.ok(buttons.every(x => x.reachable), `${name}/${tag}@${w}: a control is off screen or covered`)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name}/${tag}@${w}: horizontal scroll`)
    if (process.env.SHOTS) { const box = await el.boundingBox(); const y = Math.max(0, box.y - 120); await page.screenshot({ path: path.join(process.env.SHOTS, `${name}-${tag}-${w}.png`), clip: { x: 0, y, width: w, height: Math.min(360, 900 - y) } }) }
    return { text: (await el.innerText()).replace(/\s+/g, ' ').trim(), labels: buttons.map(x => `${x.label.toLowerCase()}${x.disabled ? ' (disabled)' : ''}`) }
  }
  const click = label => page.getByTestId('crm-push').locator('button', { hasText: new RegExp(label, 'i') }).click()
  try { await run({ page, state, click, calls, open }) } finally { await ctx.close() }
}
try {
  for (const w of [1280, 390]) {
    await scenario(w, 'double-click', () => ({ delay: 1500, json: { ok: true, message: 'Contact created in HubSpot', external_id: '1234' } }), async ({ page, state, calls }) => {
      const btn = page.getByTestId('crm-push').locator('button')
      await btn.click(); await btn.click({ force: true, timeout: 500 }).catch(() => {}); await btn.click({ force: true, timeout: 500 }).catch(() => {})
      assert.deepEqual((await state('pushing')).labels, ['pushing… (disabled)'])
      await sleep(1800)
      assert.deepEqual(await state('done'), { text: 'Contact created in HubSpot', labels: [] })
      assert.deepEqual(calls, ['push'], 'one push for a double click')
    })
    await scenario(w, 'progress-success', (body, calls) => body.action === 'push' ? PROGRESS : { json: calls.filter(x => x === 'status').length < 2 ? { state: 'in_progress', external_id: null } : { state: 'done', external_id: '1234' } }, async ({ state, click, calls }) => {
      await click('Push to CRM'); await sleep(300)
      assert.deepEqual((await state('progress')).labels, ['check again'])
      await sleep(7000)
      assert.deepEqual(await state('done'), { text: 'In your CRM (record 1234)', labels: [] })
      assert.deepEqual(calls, ['push', 'status', 'status'], 'rechecks are read-only status calls')
    })
    await scenario(w, 'progress-unknown', b => b.action === 'push' ? PROGRESS : { json: { state: 'unknown', external_id: null } }, async ({ state, click, calls }) => {
      await click('Push to CRM'); await sleep(3600)
      assert.deepEqual((await state('unknown')).labels, ['it is in my crm', 'it is not there'])
      assert.deepEqual(calls, ['push', 'status'])
    })
    await scenario(w, 'progress-none', b => b.action === 'push' ? PROGRESS : { json: { state: 'none', external_id: null } }, async ({ state, click }) => {
      await click('Push to CRM'); await sleep(3600)
      assert.deepEqual(await state('none'), { text: 'The earlier push did not create a record. You can push again.PUSH TO CRM', labels: ['push to crm'] })
    })
    await scenario(w, 'progress-stuck', b => b.action === 'push' ? PROGRESS : { json: { state: 'in_progress', external_id: null } }, async ({ state, click, calls }) => {
      await click('Push to CRM'); await sleep(17000)
      assert.deepEqual((await state('after-rechecks')).labels, ['check again'])
      const n = calls.length; await sleep(4000)
      assert.deepEqual([n, calls.length], [6, 6], 'five rechecks, then it stops')
      await click('Check again'); await sleep(400)
      assert.deepEqual(calls.slice(6), ['status'], 'Check again reads status; it never pushes')
    })
    await scenario(w, 'failed-retry', (b, calls) => calls.length === 1 ? { status: 502, json: { outcome: 'failed', error: 'HubSpot 429' } } : { json: { ok: true, message: 'Contact created in HubSpot', external_id: '99' } }, async ({ state, click, calls }) => {
      await click('Push to CRM'); await sleep(400)
      assert.deepEqual((await state('failed')).labels, ['try again'])
      await click('Try again'); await sleep(400)
      assert.deepEqual(await state('retried'), { text: 'Contact created in HubSpot', labels: [] })
      assert.deepEqual(calls, ['push', 'push'])
    })
    await scenario(w, 'unknown-resolve', (b, calls) => b.action === 'resolve' ? { json: { ok: true } } : calls.length === 1 ? { status: 502, json: { outcome: 'unknown', error: 'HubSpot answered without a contact id; the contact may or may not have been created' } } : { json: { ok: true, message: 'Contact created in HubSpot', external_id: '100' } }, async ({ state, click, calls }) => {
      await click('Push to CRM'); await sleep(400)
      assert.deepEqual((await state('unknown')).labels, ['it is in my crm', 'it is not there'], 'no retry on an unknown result')
      await click('It is not there'); await sleep(400)
      assert.deepEqual((await state('resolved')).labels, ['push to crm'])
      await click('Push to CRM'); await sleep(400)
      assert.deepEqual(await state('pushed'), { text: 'Contact created in HubSpot', labels: [] })
      assert.deepEqual(calls, ['push', 'resolve', 'push'])
    })
    await scenario(w, 'reconnect-reload', (b, calls) => calls.length === 1 ? { status: 502, json: { outcome: 'unknown', error: 'HubSpot did not answer; the contact may or may not have been created' } }
      : { status: 409, json: { outcome: 'unknown', error: 'An earlier push of this lead has an unknown result. Check your CRM for this contact first, then record what you found.' } }, async ({ page, state, click, calls, open }) => {
      await click('Push to CRM'); await sleep(400)
      assert.deepEqual((await state('unknown')).labels, ['it is in my crm', 'it is not there'])
      await page.reload({ waitUntil: 'networkidle' }); await open()
      assert.deepEqual((await state('reloaded')).labels, ['push to crm'])
      await click('Push to CRM'); await sleep(400)
      assert.deepEqual((await state('after-reconnect')).labels, ['it is in my crm', 'it is not there'], 'the server hold answers; no second create')
    })
  }
  console.log('CRM push UI check passed at 1280 and 390: one push per double click, bounded read-only recheck after in progress, Try again after failure, resolution-only after unknown, reconnect and reload keep the hold, every control reachable')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
