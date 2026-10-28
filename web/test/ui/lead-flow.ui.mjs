// Rendered check for the lead cards after a scan: what each card shows, and what Approve and Reject visibly do. NOT part
// of `npm test`.  Run:  cd web && npm run build && node test/ui/lead-flow.ui.mjs   (SHOTS=<dir> saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call answered from a
// stub in the browser: no scan, no draft is really created, nothing is sent. It proves:
//   1. the cards open on "To review" with counts on the tabs; each card shows company, contact name + role, one line of
//      why, source + date, and Approve / Reject; no caveat paragraph is on screen (the limits sit behind (i));
//   2. Approve sends exactly one POST /api/outreach { lead_id }; the card leaves To review for Approved, and a one-line
//      result says the draft was created with a link to review it (this play's Outreach);
//   3. Reject with a reason sends the existing quarantine POST ("Rejected: <reason>"); the card leaves the list, the result
//      line says so, and Undo (its DELETE) brings it back; nothing else is written.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-leadflow-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const JOB = 'b'.repeat(24)
const ICP = { summary: 'Growing dental practices', who: ['Practice owner'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['new location'], exclude: [] }
const person = (name, url) => ({ connector: 'sitecrawl', kind: 'person', value: name, label: null, source_url: url, source_date: '2026-10-20', confidence: null })
const lead = (id, company, over = {}) => ({ id, name: '', company, contact: null, signal: `${company} opened a second office`, source_url: `https://www.daytondailynews.example/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} opened a second office`, event_date: '2026-10-12', date_status: 'verified', confidence: 90, review_reason: null, company_domain: null, human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 4, action: 3, why: `${company} just opened a second Ohio office and is hiring front-desk staff. More detail follows here.`, signals: null, icp_match: null, enrichments: [], events: [], ...over })
const A = 'a'.repeat(24), C = 'c'.repeat(24), M = 'd'.repeat(24)
const LEADS = [
  lead(A, 'Bright Dental', { contact: 'hello@brightdental.example', enrichments: [person('Dana Smith, Practice owner', 'https://www.daytondailynews.example/aaaa')] }),
  lead(M, 'Maple Family Dentistry', { contact: 'office@mapledental.example', enrichments: [person('Sam Ortiz, Office manager', 'https://www.daytondailynews.example/dddd')] }),
  lead(C, 'Lakeside Smiles'),
]
const writes = []; const drafts = []
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
  if (u.origin !== base) return route.abort()
  if (!p.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (m !== 'GET') writes.push({ m, p, body: req.postData() ? JSON.parse(req.postData()) : null })
  if (p === '/api/scan/status') return json({ status: 'done', lead_count: LEADS.length, icp: ICP, icp_source: 'user', attempts: 1, max_attempts: 3, query: 'Dental practice owners in Ohio opening a new location', quality: { candidates: 5, passed: 3, needs_review: 0, dropped: 2, drop_reasons: { stale: 2 } } })
  if (p === '/api/leads') return json({ job_id: JOB, status: 'done', hidden_count: 0, leads: LEADS })
  if (p === '/api/scan/jobs') return json({ jobs: [] })
  if (p === `/api/campaigns/${JOB}`) return json({ job: { id: JOB }, leads: [], messages: drafts.map((lead_id, i) => ({ id: `m${i}`, lead_id, to_email: 'x@y.example', subject: 'Hi', status: 'draft', created_at: 1, sent_at: null })) })
  if (p === '/api/outreach' && m === 'POST') { drafts.push(JSON.parse(req.postData()).lead_id); return json({ ok: true, message_id: 'm1' }) }
  if (/^\/api\/leads\/[a-f0-9]{24}\/quarantine$/.test(p)) return json({ quarantined: m === 'POST' })
  return json({}, 404)
})
const page = await ctx.newPage()
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) }
const cards = () => page.getByTestId('lead-card')
const card = name => cards().filter({ hasText: name })
const tab = t => page.getByTestId(`tab-${t}`)
try {
  await page.goto(`${base}/app/leads?job_id=${JOB}&passive=1`, { waitUntil: 'networkidle' })
  await cards().first().waitFor({ timeout: 15000 })
  if (process.env.BEFORE_ONLY) { await cards().first().scrollIntoViewIfNeeded(); await page.locator('main').evaluate(m => m.scrollBy(0, -140)); await shot('before'); console.log('before shot'); process.exit(0) }
  // 1. What a card shows, and no caveat paragraphs.
  assert.equal(await tab('review').getAttribute('aria-selected'), 'true', 'opens on To review')
  assert.deepEqual(await Promise.all(['review', 'approved', 'rejected'].map(t => tab(t).textContent())), ['To review 3', 'Approved 0', 'Rejected 0'])
  assert.equal(await cards().count(), 3)
  const bright = card('Bright Dental')
  const t = await bright.textContent()
  assert.match(t, /Dana Smith, Practice owner/, 'contact name and role')
  assert.match(t, /Bright Dental just opened a second Ohio office and is hiring front-desk staff\./); assert.doesNotMatch(t, /More detail follows/, 'one line of why')
  assert.match(t, /daytondailynews\.example · claimed event date 12 Oct 2026/, 'source and date')
  assert.equal(await bright.getByRole('button', { name: 'Approve' }).isEnabled(), true); assert.equal(await bright.getByRole('button', { name: 'Reject' }).isEnabled(), true)
  assert.equal(await card('Lakeside Smiles').getByRole('button', { name: 'Approve' }).isDisabled(), true)
  assert.equal(await card('Lakeside Smiles').getByTestId('approve-hold').isVisible(), true, 'a held lead says it cannot be approved yet; the reason is behind its (i)')
  const visibleText = await page.locator('main').innerText()
  for (const caveat of [/approving a card makes a draft/i, /Kept with its evidence/, /Reject this lead\?/, /To approve:/, /Cards shown below/]) assert.doesNotMatch(visibleText, caveat, `no caveat paragraph on screen: ${caveat}`)
  await page.locator('main').evaluate(m => m.scrollBy(0, -10000)); await cards().first().scrollIntoViewIfNeeded(); await page.locator('main').evaluate(m => m.scrollBy(0, -140))
  await shot('after')
  // 2. Approve -> draft, card moves to Approved, one-line result.
  await bright.getByRole('button', { name: 'Approve' }).click()
  const result = page.getByTestId('card-result')
  await result.waitFor()
  assert.equal(await result.getAttribute('data-kind'), 'approved')
  assert.match(await result.innerText(), /Bright Dental: draft created\./)
  assert.equal(await result.getByRole('link', { name: 'Review draft' }).getAttribute('href'), `/app/outreach?job_id=${JOB}`)
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid=lead-card]')].some(c => c.textContent.includes('Bright Dental')))
  assert.deepEqual(await Promise.all(['review', 'approved'].map(t => tab(t).textContent())), ['To review 2', 'Approved 1'])
  await shot('after-approve')
  await tab('approved').click()
  const approvedCards = await cards().allTextContents()
  assert.equal(approvedCards.length, 1); assert.match(approvedCards[0], /Bright DentalApproved/, 'the approved card is under Approved, marked Approved')
  await tab('review').click()
  // 3. Reject -> leaves the list, Undo brings it back.
  const maple = card('Maple Family Dentistry')
  await maple.getByRole('button', { name: 'Reject' }).click()
  await maple.getByTestId('reject-reason').getByRole('button', { name: 'Not a fit' }).click()
  await maple.getByRole('button', { name: 'Confirm reject' }).click()
  await page.waitForFunction(() => document.querySelector('[data-testid=card-result]')?.getAttribute('data-kind') === 'rejected')
  assert.match(await result.innerText(), /Maple Family Dentistry \(Not a fit\) left the list\./)
  assert.equal(await card('Maple Family Dentistry').count(), 0, 'the rejected card leaves the list')
  assert.deepEqual(await Promise.all(['review', 'rejected'].map(t => tab(t).textContent())), ['To review 1', 'Rejected 1'])
  await shot('after-reject')
  await result.getByRole('button', { name: 'Undo' }).click()
  await card('Maple Family Dentistry').waitFor()
  assert.equal(await page.getByTestId('card-result').count(), 0, 'Undo clears the result')
  assert.deepEqual(writes.map(w => [w.m, w.p, w.body]), [
    ['POST', '/api/outreach', { lead_id: A }],
    ['POST', `/api/leads/${M}/quarantine`, { reason: 'Rejected: Not a fit' }],
    ['DELETE', `/api/leads/${M}/quarantine`, {}],
  ], 'only the existing draft and quarantine actions are written')
  // 4. At 390px the actions stack under the identity: a long company name, its email and the role warning get the card's width.
  const L = 'e'.repeat(24), LONG = 'Northern Kentucky Pediatric & Family Dental Associates of Greater Cincinnati'
  LEADS.push(lead(L, LONG, { contact: 'frontdesk.scheduling@northernkentuckypediatricdental.example', enrichments: [person('Alexandra Montgomery-Whitfield, Practice owner and clinical director', 'https://www.daytondailynews.example/eeee')] }))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload({ waitUntil: 'networkidle' })
  const long = card(LONG); await long.waitFor()
  const box = await long.boundingBox(), text = await long.locator('.min-w-0.break-words').boundingBox()
  const acts = await long.getByTestId('card-actions').boundingBox()
  assert.ok(text.width >= box.width - 60, `identity column uses the card width at 390px (${Math.round(text.width)} of ${Math.round(box.width)})`)
  assert.ok(acts.y >= text.y + text.height - 1, 'Approve/Reject sit below the identity and contact')
  assert.match(await long.getByTestId('contact-status').innerText(), /current role not verified/, 'the role warning stays on screen')
  for (const name of ['Approve', 'Reject']) { const btn = long.getByRole('button', { name }); assert.equal(await btn.isVisible(), true); const bb = await btn.boundingBox(); assert.ok(bb.x >= box.x && bb.x + bb.width <= box.x + box.width, `${name} fits inside the card`) }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scroll')
  if (process.env.SHOTS) { await long.scrollIntoViewIfNeeded(); await long.screenshot({ path: path.join(process.env.SHOTS, 'after-390-long.png') }) }
  await page.setViewportSize({ width: 1280, height: 900 })
  const dbox = await card('Maple Family Dentistry').getByTestId('card-actions').boundingBox(), didb = await card('Maple Family Dentistry').locator('.min-w-0.break-words').boundingBox()
  assert.ok(Math.abs(dbox.y - didb.y) < 30, 'desktop keeps the actions beside the identity')
  console.log('lead flow UI check passed: cards show company, contact name + role, one-line why, source + date; Approve -> draft + moves to Approved; Reject -> leaves the list with Undo; no caveat paragraphs')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
