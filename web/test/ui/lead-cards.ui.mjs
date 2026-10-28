// Rendered check for the compact lead cards on Leads. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/lead-cards.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, and EVERY /api/* CALL ANSWERED
// FROM A STUB in the browser: no scan, no draft is really created, nothing is sent. Off-host requests are aborted.
// It proves, on the rendered page:
//   0. viewing a scan, Leads links to that scan's campaign page;
//   1. each card shows company, contact, one line of why, source link + date, and Approve / Reject; Details is closed;
//   1b. the contact's uncertainty is visible beside it on the collapsed card: name-guessed website (Instinct's repro),
//      conflicting websites, restricted inbox, past-title people; only cited/own-site/user-checked reads "Confirmed";
//   2. Approve on an eligible lead sends one POST /api/outreach { lead_id } per attempt (the existing draft action),
//      even on a double click against a slow server; after a failure it can be retried; nothing else is written;
//   3. Approve is disabled with the reason on leads the existing gates hold (no email, window, timing);
//   4. Reject opens an optional-reason step (presets, free text, Cancel/Escape writes nothing); Confirm reject sends the
//      existing quarantine POST with "Rejected: <reason>" (or just "Rejected" with none); the card leaves To review, the
//      result line says so and the card shows its reason under Rejected; Undo (on the card or the result) sends its DELETE.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-leadcards-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const JOB = 'b'.repeat(24)
const ICP = { summary: 'Growing dental practices', who: ['Practice owner'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['new location'], exclude: [] }
const lead = (id, company, over = {}) => ({ id, name: '', company, contact: null, signal: `${company} opened a second office`, source_url: `https://www.news.example/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} opened a second office`, event_date: '2026-10-01', date_status: 'unverified', confidence: 80, review_reason: null, company_domain: null, human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 3, action: 3, why: `${company} is a two-location practice that matches your dental owner profile. More detail follows.`, signals: null, icp_match: null, enrichments: [], events: [], ...over })
const dom = (site, token, url = 'https://www.news.example/x') => ({ connector: 'sitecrawl', kind: 'domain', value: `${site}|${token}`, label: `domain-basis-v1:${token}`, source_url: url, source_date: '2026-10-20', confidence: null })
const row = (kind, value) => ({ connector: 'sitecrawl', kind, value, label: null, source_url: 'https://name-guessed.example/team', source_date: '2026-10-20', confidence: null })
const LEADS = [
  lead('a'.repeat(24), 'Bright Dental', { contact: 'hello@brightdental.example' }),
  lead('c'.repeat(24), 'Lakeside Smiles'),
  lead('d'.repeat(24), 'Old Town Dental', { contact: 'info@oldtown.example', window_held: true }),
  // Instinct's repro: website guessed from the name, crawled address on it, a listed person.
  lead('e'.repeat(24), 'Pico Dental', { contact: 'hello@name-guessed.example', enrichments: [dom('name-guessed.example', 'name_probe', 'https://name-guessed.example/'), row('email', 'hello@name-guessed.example'), row('person', 'Dana Smith, Practice owner')] }),
  lead('f'.repeat(24), 'Twin Dental', { contact: 'hello@a-dental.example', enrichments: [dom('a-dental.example', 'name_probe'), dom('b-dental.example', 'evidence_link_domain_label'), row('email', 'hello@a-dental.example')] }),
  lead('1'.repeat(24), 'Quiet Dental', { contact: 'privacy@quietdental.example' }),
  lead('2'.repeat(24), 'Former Dental', { contact: 'hello@formerdental.example', enrichments: [row('person', 'Pat Lee, Former practice owner')] }),
]
let outreachMode = 'ok'
const writes = []; const outreachBodies = []; const quarantineCalls = []
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method()
  if (u.origin !== base) return route.abort()
  if (!u.pathname.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (m !== 'GET') writes.push(`${m} ${u.pathname}`)
  if (u.pathname === '/api/scan/status') return json({ status: 'done', lead_count: LEADS.length, icp: ICP, icp_source: 'user', attempts: 1, max_attempts: 3, query: 'Dental practice owners in Ohio opening a new location' })
  if (u.pathname === '/api/leads') return json({ job_id: JOB, status: 'done', hidden_count: 0, leads: LEADS })
  if (u.pathname === '/api/scan/jobs') return json({ jobs: [] })
  if (u.pathname === '/api/outreach' && m === 'POST') {
    outreachBodies.push(JSON.parse(req.postData()))
    await new Promise(res => setTimeout(res, 800)) // a slow server: a double click lands while the first request is in flight
    if (outreachMode === 'fail') { outreachMode = 'ok'; return json({ error: 'Could not create the draft right now' }, 500) }
    return json({ ok: true, message_id: 'm1' })
  }
  const q = /^\/api\/leads\/([a-f0-9]{24})\/quarantine$/.exec(u.pathname)
  if (q) { quarantineCalls.push({ method: m, lead: q[1], body: req.postData() ? JSON.parse(req.postData()) : null }); return json({ quarantined: m === 'POST' }) }
  return json({}, 404)
})
const page = await ctx.newPage()
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
try {
  await page.goto(`${base}/app/leads?job_id=${JOB}&passive=1`, { waitUntil: 'networkidle' })
  const cards = page.getByTestId('lead-card')
  await cards.first().waitFor({ timeout: 15000 })
  assert.equal(await cards.count(), 7)
  assert.equal(await page.getByTestId('campaign-page-link').getAttribute('href'), `/app/campaigns/${JOB}`, 'Leads links the scan being viewed to its campaign page')
  await page.locator('main').evaluate(m => m.scrollTo(0, m.scrollHeight)); await shot('cards')

  const bright = cards.filter({ hasText: 'Bright Dental' })
  assert.match(await bright.textContent(), /hello@brightdental\.example/)
  assert.equal(await bright.getByTestId('contact-status').textContent(), 'Confirmed: address printed on the cited page.')

  // Contact uncertainty is on the collapsed card, beside the contact, not only in Details.
  const statusOf = name => cards.filter({ hasText: name }).getByTestId('contact-status')
  const pico = cards.filter({ hasText: 'Pico Dental' })
  assert.match(await pico.textContent(), /Dana Smith, Practice owner - hello@name-guessed\.example/)
  assert.equal(await statusOf('Pico Dental').isVisible(), true)
  assert.equal(await statusOf('Pico Dental').textContent(), 'Unconfirmed - name match only: name-guessed.example: found by name search, not linked from the source. Role as listed; current role not verified.')
  assert.equal(await pico.getByRole('button', { name: 'Approve' }).isDisabled(), true)
  assert.match(await statusOf('Twin Dental').textContent(), /^Unconfirmed - name match only: several websites recorded \(a-dental\.example, b-dental\.example\); which one is theirs is not settled\./)
  assert.match(await statusOf('Quiet Dental').textContent(), /Restricted inbox \(privacy\): not a sales contact\./)
  assert.doesNotMatch(await cards.filter({ hasText: 'Former Dental' }).textContent(), /Pat Lee/)
  assert.match(await statusOf('Former Dental').textContent(), /Listed people have past, negated or assistant titles; no current buyer named\./)
  assert.match(await bright.textContent(), /Bright Dental is a two-location practice that matches your dental owner profile\./)
  assert.doesNotMatch(await bright.textContent(), /More detail follows/, 'one line of why, not the whole rationale')
  assert.match(await bright.textContent(), /news\.example · claimed event date 1 Oct 2026/)
  assert.equal(await bright.getByRole('link', { name: 'news.example' }).getAttribute('href'), 'https://www.news.example/aaaa')
  assert.equal(await page.getByText('Saved signal claim: Bright Dental opened a second office').isVisible(), false, 'Details are closed by default')

  // Held leads: Approve disabled, with the reason on the card.
  const lakeside = cards.filter({ hasText: 'Lakeside Smiles' })
  assert.equal(await lakeside.getByRole('button', { name: 'Approve' }).isDisabled(), true)
  assert.match(await lakeside.textContent(), /No contact found yet[\s\S]*To approve: No published email address to draft to yet/)
  const old = cards.filter({ hasText: 'Old Town Dental' })
  assert.equal(await old.getByRole('button', { name: 'Approve' }).isDisabled(), true)
  assert.match(await old.textContent(), /To approve: Outside the time window/)

  assert.deepEqual(writes, [], 'nothing written by loading the page')
  // First attempt fails: the button comes back for a retry. A double click while in flight sends one request.
  outreachMode = 'fail'
  await bright.getByRole('button', { name: 'Approve' }).dblclick()
  await bright.getByText('Could not create the draft right now').waitFor()
  assert.equal(outreachBodies.length, 1, 'a double click while the request is in flight sends one request')
  assert.equal(await bright.getByRole('button', { name: 'Approve' }).isEnabled(), true, 'retry is possible after a failure')
  await bright.getByRole('button', { name: 'Approve' }).dblclick()
  // Success: a one-line result, and the card moves from To review to Approved (it is a draft now).
  await page.getByTestId('card-result').getByText(/Bright Dental: draft created/).waitFor()
  assert.deepEqual(outreachBodies, [{ lead_id: 'a'.repeat(24) }, { lead_id: 'a'.repeat(24) }], 'one request per attempt: the failed one and the retry')
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid=lead-card]')].some(c => c.textContent.includes('Bright Dental')))
  await page.getByTestId('tab-approved').click()
  assert.equal(await bright.getByRole('button', { name: 'Approve' }).isDisabled(), true, 'cannot approve again after success')
  await page.getByTestId('tab-review').click()

  // Reject asks for an optional reason; Cancel and Escape write nothing.
  await lakeside.getByRole('button', { name: 'Reject' }).click()
  const reasonRow = lakeside.getByTestId('reject-reason'); await reasonRow.waitFor()
  assert.deepEqual(await reasonRow.getByRole('button').allTextContents(), ['i', 'Not a fit', 'Wrong company', 'Wrong contact', 'Already a customer', 'Confirm reject', 'Cancel']) // the (i) holds what rejecting does
  await reasonRow.getByRole('button', { name: 'Cancel' }).click()
  assert.equal(await lakeside.getByTestId('reject-reason').count(), 0)
  await lakeside.getByRole('button', { name: 'Reject' }).click()
  await lakeside.getByLabel('Reason (optional)').press('Escape')
  assert.equal(await lakeside.getByTestId('reject-reason').count(), 0)
  assert.deepEqual(quarantineCalls, [], 'cancelling writes nothing')
  // A preset reason.
  await lakeside.getByRole('button', { name: 'Reject' }).click()
  await lakeside.getByTestId('reject-reason').getByRole('button', { name: 'Wrong company' }).click()
  await shot('reject-reason')
  await lakeside.getByRole('button', { name: 'Confirm reject' }).click()
  // The rejected card leaves the list; the result line says so, and the card is under Rejected with its reason.
  const result = page.getByTestId('card-result')
  await result.getByText(/Lakeside Smiles \(Wrong company\) left the list\./).waitFor()
  assert.equal(await lakeside.count(), 0)
  await page.getByTestId('tab-rejected').click()
  assert.match(await lakeside.textContent(), /^LSLakeside SmilesRejected[\s\S]*Rejected: Wrong companyiKept with its evidence; it will not be drafted, sent or exported\./)
  await shot('after-actions')
  await lakeside.getByRole('button', { name: 'Undo' }).click()
  await page.getByTestId('tab-review').click()
  await lakeside.getByRole('button', { name: 'Reject' }).waitFor()
  // No reason at all: just "Rejected" (Enter in the box confirms); Undo from the result line.
  await lakeside.getByRole('button', { name: 'Reject' }).click()
  await lakeside.getByLabel('Reason (optional)').press('Enter')
  await result.getByText(/^Lakeside Smiles left the list\./).waitFor()
  await result.getByRole('button', { name: 'Undo' }).click()
  await lakeside.getByRole('button', { name: 'Reject' }).waitFor()
  const C = 'c'.repeat(24)
  assert.deepEqual(quarantineCalls, [
    { method: 'POST', lead: C, body: { reason: 'Rejected: Wrong company' } }, { method: 'DELETE', lead: C, body: {} },
    { method: 'POST', lead: C, body: { reason: 'Rejected' } }, { method: 'DELETE', lead: C, body: {} },
  ])
  assert.deepEqual(writes, ['POST /api/outreach', 'POST /api/outreach', `POST /api/leads/${C}/quarantine`, `DELETE /api/leads/${C}/quarantine`, `POST /api/leads/${C}/quarantine`, `DELETE /api/leads/${C}/quarantine`], 'no other writes')

  await page.getByTestId('tab-approved').click() // Bright Dental is under Approved now
  await page.locator('summary:not([data-testid=caveat] summary)', { hasText: 'Details' }).first().click() // a lead's Details, not a page caveat's
  assert.equal(await page.getByText('Saved signal claim: Bright Dental opened a second office').isVisible(), true, 'everything else is still there under Details')
  console.log('lead cards UI check passed:', writes.join(', '))
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
