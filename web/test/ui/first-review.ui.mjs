// After the first lead cards: review them and start outreach, end to end on the production build with seeded data.
// NOT part of `npm test`. Run:  cd web && npm run build && node test/ui/first-review.ui.mjs   (SHOTS=<dir> saves shots)
// Throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed in the browser (website read,
// profile save, the scan, its status, the leads read, the draft action, sending settings): no live or paid scan, no
// email sent, no Gmail connection made. It proves:
//   1. "Start reaching out" opens a review step in place: the ready leads one at a time (company, contact, why, quote,
//      source + date), Approve and draft / Skip, "n of N";
//   2. Approve is the existing draft action: one POST /api/outreach { lead_id } per approval; a server refusal is shown on
//      the card and the lead stays; a lead the approve gate holds (no published email) says why and cannot be approved;
//   3. then "Before your first email sends": Gmail with its read notice and a Connect link (/api/gmail/connect), and the
//      sender name + mailing address (the existing PUT /api/outreach/settings); "Review your N drafts" opens Outreach;
//   4. nothing is sent; no horizontal overflow at 390px.
// It prints: things typed before the first lead card and before the first draft, and seconds from sign-in to each.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-firstreview-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }


const J = 'f'.repeat(24)
const READ = { source: 'https://www.ledgerline.example/', sells: 'Bookkeeping software for small accounting firms',
  icp: { summary: 'Accounting and bookkeeping firms with 5-50 staff that are growing', who: ['Managing partner', 'Practice manager'], industries: ['Accounting', 'Bookkeeping'], where: ['London, UK', 'Manchester, UK'], sizes: ['5-50 employees'], signals: ['Hiring accountants', 'Opening a new office'], exclude: ['Big Four firms'] } }
const L = (n, company, signal, host, date, fit, o = {}) => ({ id: String(n).repeat(24), company, name: o.name ?? null, signal, source_url: `https://www.${host}/${n}`, event_date: date, published_at: null, fit_pct: fit, provisional: false })
const LEADS = [
  L(1, 'Hartley & Shaw Accountants', 'Hiring two trainee accountants for its new Shoreditch office', 'accountancyage.example', '2026-10-21', 80, { name: 'Priya Hartley' }),
  L(2, 'Northgate Bookkeeping', 'Opened a second office in Salford this month', 'manchestereveningnews.example', '2026-10-18', 80),
  L(3, 'Clearline Tax', 'Advertising for a senior bookkeeper and a payroll clerk', 'reed.example', '2026-10-16', 60),
  L(4, 'Ashworth Partners', 'Announced a merger and a move to larger offices in Leeds', 'yorkshirepost.example', '2026-10-12', 60),
  L(5, 'Brightledger', 'Hiring an operations manager to scale client onboarding', 'workable.example', '2026-10-09', 60),
]
const src = (source, state, status, candidates) => ({ source, state, status, note: null, candidates, accepted: null, review: null, rejected: null })
const view = (o) => ({ target: 5, found: 0, verified: 0, enriching: false, next: null, state: 'finding', finding_more: true, reason: null, message: '', leads: [], sources: [], failed_sources: [], can_continue: false, ...o })
// What the status read returns on each poll of the seeded run: queued, the news being read, job boards being read with
// candidates counted, two leads still being checked, then 5 verified (or, for the short run, 2 of 5).
const STEPS = full => [
  { status: 'running', first5: view({ sources: [src('search:news', 'running', 'running', null), src('adapter:jobboards', 'queued', 'running', null)] }) },
  { status: 'running', first5: view({ sources: [src('search:news', 'done', 'ok', 7), src('adapter:jobboards', 'running', 'running', 3)] }) },
  { status: 'enriching', first5: view({ enriching: true, found: 2, leads: LEADS.slice(0, 2).map(l => ({ ...l, provisional: true })), sources: [src('search:news', 'done', 'ok', 7), src('adapter:jobboards', 'done', 'ok', 5)] }) },
  full ? { status: 'done', first5: view({ state: 'ready', finding_more: false, found: 5, verified: 5, can_continue: true, message: 'We found 5 customers you can look at today.', leads: LEADS, sources: [src('search:news', 'done', 'ok', 7), src('adapter:jobboards', 'done', 'ok', 5)] }) }
    : { status: 'done', first5: view({ state: 'partial', finding_more: false, found: 2, verified: 2, can_continue: true, next: { action: 'wider_search', label: 'Search wider (a full scan, using your scan allowance)' }, message: '2 of 5 verified from the free sources.', leads: LEADS.slice(0, 2), sources: [src('search:news', 'done', 'ok', 7), src('adapter:jobboards', 'done', 'ok', 5)] }) },
]
const b = await chromium.launch()
// Full lead rows for the review (what GET /api/leads returns): verified, dated, a named contact with a published email,
// except Clearline Tax, which has no published email yet (the approve gate holds it).
const person = (n, url) => ({ connector: 'sitecrawl', kind: 'person', value: n, label: null, source_url: url, source_date: '2026-10-20', confidence: null })
const row = (n, company, who, email, quote, host, date, o = {}) => ({ id: String(n).repeat(24), name: '', company, contact: email, signal: quote, source_url: `https://www.${host}/${n}`, score: 70, evidence_excerpt: quote, event_date: date, date_status: 'verified', published_at: null, confidence: 90, review_reason: null, company_domain: email ? email.split('@')[1] : null, human_confirmed_at: null, fit: 4, intent: 4, action: 3, why: o.why ?? `${company} is growing its team this month.`, signals: null, icp_match: null, enrichments: who ? [person(who, `https://www.${host}/${n}`)] : [], events: [], ...o })
const ROWS = [
  row(1, 'Hartley & Shaw Accountants', 'Priya Hartley, Managing partner', 'priya@hartleyshaw.example', 'Hartley & Shaw is hiring two trainee accountants for its new Shoreditch office.', 'accountancyage.example', '2026-10-21', { why: 'A new office and two trainee hires: more client books to keep.' }),
  row(2, 'Northgate Bookkeeping', 'Tom Reed, Practice manager', 'tom@northgatebk.example', 'Northgate Bookkeeping opened a second office in Salford this month.', 'manchestereveningnews.example', '2026-10-18'),
  row(3, 'Clearline Tax', null, null, 'Clearline Tax is advertising for a senior bookkeeper and a payroll clerk.', 'reed.example', '2026-10-16'),
  row(4, 'Ashworth Partners', 'Helen Ashworth, Managing partner', 'helen@ashworthpartners.example', 'Ashworth Partners announced a merger and a move to larger offices in Leeds.', 'yorkshirepost.example', '2026-10-12'),
]
const NOTICE = ['dazl reads only replies and delivery-failure notices in the email threads it started for you.', 'Nothing else in your mailbox is read, stored or used.']
async function run({ width, height, tag }) {
  const st = { profile: { business_name: '', sells: '', website: '', buyer: null }, scanBodies: [], polls: 0, drafts: [], failNext4: true, sender: { sender_name: '', postal_address: '', booking_url: null } }
  const ctx = await b.newContext({ viewport: { width, height } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const writes = []
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (m !== 'GET') writes.push(`${m} ${p}`)
    if (p === '/api/scan/icp-from-url') { await new Promise(r => setTimeout(r, 1200)); return json(READ) }
    if (p === '/api/settings/profile' && m === 'POST') { st.profile = { ...st.profile, ...JSON.parse(req.postData()) }; return json({ ok: true }) }
    if (p === '/api/settings/profile') return json(st.profile)
    if (p === '/api/scan' && m === 'POST') { st.scanBodies.push(JSON.parse(req.postData())); return json({ job_id: J }) }
    if (p === '/api/scan/status') { const s = STEPS(true)[Math.min(st.polls++, 3)]; return json({ job_id: J, ...s }) }
    if (p === '/api/leads') return json({ leads: u.searchParams.get('job_id') === J ? ROWS : [], hidden_count: 0 })
    if (p === '/api/outreach' && m === 'POST') {
      const { lead_id } = JSON.parse(req.postData())
      // One refusal the first time Ashworth is approved: the card shows it and the lead stays.
      if (lead_id === ROWS[3].id && st.failNext4) { st.failNext4 = false; return json({ error: 'Could not create the draft right now. Try again.' }, 503) }
      st.drafts.push(lead_id); return json({ id: `m${st.drafts.length}` }, 201)
    }
    if (p === '/api/outreach/settings' && m === 'PUT') { st.sender = { ...st.sender, ...JSON.parse(req.postData()) }; return json({ ok: true }) }
    if (p === '/api/outreach/settings') return json({ gmail: null, sender: st.sender, daily_cap: 20, sent_24h: 0, account_sent_24h: 0, read_notice: NOTICE })
    if (p === '/api/scan/jobs') return json({ jobs: [] })
    if (p === '/api/usage') return json({ plan: 'free', scans_used: 0, scan_limit: 10, has_key: false, trial: { funded: true, remaining: 3 } })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  let typed = 0
  const type = async (loc, text) => { typed++; await loc.fill(text) }
  const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}-${tag}.png`) }) }
  const t0 = Date.now()
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  await page.getByTestId('site-step').waitFor({ timeout: 15000 })
  await type(page.getByLabel('Your website'), 'ledgerline.example')
  await page.getByRole('button', { name: 'Read my site' }).click()
  await page.getByTestId('ready-step').waitFor({ timeout: 20000 })
  await page.getByTestId('ready-cta').click() // the prefilled sentence: nothing typed
  await page.getByTestId('first-lead').first().waitFor({ timeout: 15000 })
  const toFirstLead = { seconds: (Date.now() - t0) / 1000, typed }
  await page.waitForFunction(() => document.querySelector('[data-testid=ready-cta]')?.textContent === 'Start reaching out', null, { timeout: 15000 })
  // 1. Review in place.
  await page.getByTestId('ready-cta').click()
  const card = page.getByTestId('review-card')
  await card.waitFor()
  assert.equal(await page.getByTestId('review-count').textContent(), '1 of 4')
  const t1 = await card.innerText()
  for (const want of ['Hartley & Shaw Accountants', 'Priya Hartley, Managing partner - priya@hartleyshaw.example', 'A new office and two trainee hires: more client books to keep.', '“Hartley & Shaw is hiring two trainee accountants for its new Shoreditch office.”', 'accountancyage.example', '21 Oct 2026']) assert.ok(t1.includes(want), want)
  assert.equal(await page.getByTestId('send-setup').count(), 0, 'setup waits until there is a draft')
  await shot('5-review')
  if (process.env.SHOTS) await card.screenshot({ path: path.join(process.env.SHOTS, `5-review-card-${tag}.png`) })
  // 2. Approve -> one draft; Skip; a held lead says why; a refusal stays on the card.
  await card.getByRole('button', { name: 'Approve and draft' }).click()
  await page.waitForFunction(() => document.querySelector('[data-testid=review-count]')?.textContent === '2 of 4')
  const toFirstDraft = { seconds: (Date.now() - t0) / 1000, typed }
  await card.getByRole('button', { name: 'Skip' }).click()
  await page.waitForFunction(() => document.querySelector('[data-testid=review-count]')?.textContent === '3 of 4')
  assert.equal(await card.getByRole('button', { name: 'Approve and draft' }).isDisabled(), true, 'no published email: the approve gate holds it')
  assert.match(await page.getByTestId('review-held').textContent(), /^Can't approve yet: No published email address to draft to yet\./)
  assert.equal(await page.getByTestId('review-contact').textContent(), 'No contact found yet')
  await card.getByRole('button', { name: 'Skip' }).click()
  await card.getByRole('button', { name: 'Approve and draft' }).click()
  await page.getByTestId('review-error').waitFor()
  assert.equal(await page.getByTestId('review-error').textContent(), 'Could not create the draft right now. Try again.')
  assert.equal(await page.getByTestId('review-count').textContent(), '4 of 4', 'a refused approval keeps the lead on screen')
  await card.getByRole('button', { name: 'Approve and draft' }).click()
  // The drafts link is already there after the first approval: wait for the queue to finish instead.
  await page.waitForFunction(() => document.querySelector('[data-testid=review-step] h1')?.textContent === '2 drafts ready for you', null, { timeout: 10000 })
  assert.deepEqual(st.drafts, [ROWS[0].id, ROWS[3].id], 'one draft per approval, through the existing action')
  // 3. Send setup.
  assert.equal(await page.getByTestId('review-step').locator('h1').textContent(), '2 drafts ready for you')
  assert.deepEqual(await page.getByTestId('read-notice').locator('li').allTextContents(), NOTICE, 'the read notice the connect accepts is shown beside it')
  assert.equal(await page.getByTestId('connect-gmail').getAttribute('href'), '/api/gmail/connect')
  await shot('6-setup')
  await type(page.getByPlaceholder('Your name, as recipients will see it'), 'Dana Okafor')
  await type(page.getByPlaceholder(/Mailing address/), '14 Leonard Street, London EC2A 4AY, UK')
  await page.getByRole('button', { name: 'Save sender details' }).click()
  await page.waitForFunction(() => document.querySelector('[data-testid=setup-sender]')?.textContent?.startsWith('✓ Sender: Dana Okafor'))
  const drafts = page.getByTestId('review-drafts')
  assert.deepEqual([await drafts.textContent(), await drafts.getAttribute('href')], ['Review your 2 drafts', `/app/outreach?job_id=${J}`])
  // 4. Nothing sent; only these writes.
  assert.deepEqual(writes, ['POST /api/scan/icp-from-url', 'POST /api/settings/profile', 'POST /api/scan', 'POST /api/outreach', 'POST /api/outreach', 'POST /api/outreach', 'PUT /api/outreach/settings'])
  assert.equal(await page.getByTestId('onboarding-screen').evaluate(e => e.scrollWidth <= e.clientWidth), true, `no horizontal overflow at ${width}px`)
  await page.waitForTimeout(200); await shot('7-ready-to-send')
  if (process.env.SHOTS) await page.getByTestId('send-setup').screenshot({ path: path.join(process.env.SHOTS, `7-setup-card-${tag}.png`) })
  await ctx.close()
  return { toFirstLead, toFirstDraft, typedToSendReady: typed }
}
try {
  const d = await run({ width: 1440, height: 900, tag: 'desktop' })
  const m = await run({ width: 390, height: 844, tag: 'mobile' })
  assert.deepEqual([d.toFirstLead.typed, d.toFirstDraft.typed, m.toFirstLead.typed, m.toFirstDraft.typed], [1, 1, 1, 1])
  console.log(`MEASURE things typed: before the first lead card ${d.toFirstLead.typed}, before the first draft ${d.toFirstDraft.typed}, before ready to send ${d.typedToSendReady} (website + sender name + mailing address)`)
  console.log(`MEASURE seconds from sign-in (seeded, stubbed timings): first lead card ${d.toFirstLead.seconds.toFixed(1)} desktop / ${m.toFirstLead.seconds.toFixed(1)} 390px; first draft ${d.toFirstDraft.seconds.toFixed(1)} desktop / ${m.toFirstDraft.seconds.toFixed(1)} 390px`)
  console.log('first review UI check passed: review in place, approve = existing draft action, held lead says why, refusal stays on the card, Gmail with its notice + sender details, review drafts in Outreach, nothing sent')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
