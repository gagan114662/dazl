// The Pancake-style start of a play, end to end on the production build with realistic seeded data. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/one-sentence.ui.mjs   (SHOTS=<dir> saves desktop and 390px screenshots)
// Throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed in the browser (the website read,
// the profile save, the scan start and its status): no live or paid scan, nothing sent. It proves:
//   1. signed in -> the website is the ONLY thing typed: the brain builds, and the one-sentence box is already filled with
//      the top suggestion from the profile, with 3 suggestions beside it;
//   2. "Find my first leads" sends ONE POST /api/scan { query: that sentence, icp: the profile as read, mode: 'first5' };
//   3. a live view shows which source is being read and the candidates found so far (from the status read's first5 block),
//      then lead cards (company, signal, source link, date; "checking" while still being verified), then 5 ready;
//   4. a picked suggestion starts at once; a typed sentence is sent as typed;
//   5. a short result (2 of 5) says so and offers the wider full search as a link to Plays, never as an automatic scan.
// It prints two numbers: things typed before the first lead card, and seconds from sign-in to the first lead card.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-onesentence-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
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
// The full lead rows the leads read returns once the scan settles: the ready bar (approve gate) is judged on these.
// Three have a named contact with a published email; Clearline Tax and Brightledger have none yet, so they need research.
const person = (n, url) => ({ connector: 'sitecrawl', kind: 'person', value: n, label: null, source_url: url, source_date: '2026-10-20', confidence: null })
const row = (l, who, email) => ({ id: l.id, name: '', company: l.company, contact: email, signal: l.signal, source_url: l.source_url, score: 70, evidence_excerpt: l.signal, event_date: l.event_date, date_status: 'verified', published_at: null, confidence: 90, review_reason: null, company_domain: email ? email.split('@')[1] : null, human_confirmed_at: null, fit: 4, intent: 4, action: 3, why: l.signal, signals: null, icp_match: null, enrichments: who ? [person(who, l.source_url)] : [], events: [] })
const ROWS = [row(LEADS[0], 'Priya Hartley, Managing partner', 'priya@hartleyshaw.example'), row(LEADS[1], 'Tom Reed, Practice manager', 'tom@northgatebk.example'), row(LEADS[2], null, null), row(LEADS[3], 'Helen Ashworth, Managing partner', 'helen@ashworthpartners.example'), row(LEADS[4], null, null)]
const b = await chromium.launch()
async function run({ width, height, tag, how = 'cta', full = true, incomplete = false, tz = 'UTC' }) {
  const st = { profile: { business_name: '', sells: '', website: '', buyer: null }, scanBodies: [], polls: 0 }
  const ctx = await b.newContext({ viewport: { width, height }, timezoneId: tz })
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
    if (p === '/api/scan/status') { const s = STEPS(full)[Math.min(st.polls++, 3)]; return json({ job_id: J, ...s }) }
    if (p === '/api/scan/jobs') return json({ jobs: [] })
    if (p === '/api/usage') return json({ plan: 'free', scans_used: 0, scan_limit: 10, has_key: false, trial: { funded: true, remaining: 3 } })
    if (p === '/api/leads') return json({ leads: u.searchParams.get('job_id') === J ? (incomplete ? ROWS.map(r => ({ ...r, contact: null, enrichments: [], company_domain: null })) : ROWS).slice(0, full ? 5 : 2) : [], hidden_count: 0 })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  let typed = 0
  const type = async (loc, text) => { typed++; await loc.fill(text) }
  const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}-${tag}.png`) }) }
  const t0 = Date.now() // signed in: the session exists, Home is opened
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  await page.getByTestId('site-step').waitFor({ timeout: 15000 })
  await type(page.getByLabel('Your website'), 'ledgerline.example')
  await page.getByRole('button', { name: 'Read my site' }).click()
  await page.getByTestId('ready-step').waitFor({ timeout: 20000 })
  // 1. The sentence box already holds the top suggestion; 3 suggestions beside it.
  assert.equal(await page.getByTestId('first-heading').textContent(), 'Who do you want to find?')
  assert.equal(await page.getByLabel('Describe who you want in one sentence').count(), 1)
  const box = page.getByTestId('first-ask')
  const suggestion = await box.inputValue()
  assert.ok(suggestion.length > 10, 'prefilled with a suggestion built from the profile')
  const chips = page.getByTestId('first-play')
  assert.equal(await chips.count(), 3)
  assert.equal((await chips.first().innerText()).trim(), suggestion, 'the box starts as the first suggestion')
  assert.deepEqual(st.scanBodies, [], 'nothing starts before a click')
  if (width < 768) assert.ok((await page.getByTestId('first-customers').boundingBox()).y < (await page.getByTestId('ready-plan').boundingBox()).y, 'on a phone the sentence card comes first')
  if (tag !== 'held' && !incomplete) await shot('1-ask')
  // 2. One click starts the fast first scan with that sentence and the profile as read.
  let query = suggestion
  if (how === 'cta') await page.getByTestId('ready-cta').click()
  else if (how === 'chip') { query = (await chips.nth(1).innerText()).trim(); await chips.nth(1).click() }
  else { query = 'Accounting firms in Leeds hiring a payroll manager'; await type(box, query); await box.press('Enter') }
  await page.getByTestId('first-progress').waitFor({ timeout: 10000 })
  assert.deepEqual(st.scanBodies, [{ query, icp: READ.icp, mode: 'first5' }], 'one scan: the sentence, the profile as read, the fast first scan')
  // 3. Live: which source is read now, candidates so far.
  await page.waitForFunction(() => /^Reading News articles/.test(document.querySelector('[data-testid=live-now]')?.textContent ?? ''), null, { timeout: 10000 })
  if (how === 'cta' && !incomplete) await shot('2-live')
  await page.waitForFunction(() => document.querySelector('[data-testid=live-now]')?.textContent === 'Reading Job postings...', null, { timeout: 10000 })
  assert.equal(await page.getByTestId('live-candidates').textContent(), '10 candidates found so far')
  assert.deepEqual(await page.getByTestId('live-source').evaluateAll(ls => ls.map(l => `${l.textContent}|${l.dataset.state}`)), ['News articlesDone · 7|done', 'Job postingsSearching...|running'])
  await page.getByTestId('first-lead').first().waitFor({ timeout: 15000 })
  const firstCardSeconds = (Date.now() - t0) / 1000
  const firstCard = await page.getByTestId('first-lead').first().innerText()
  assert.match(firstCard, /^Hartley & Shaw Accountants · Priya Hartley\n+checking\n+Hiring two trainee accountants for its new Shoreditch office\n+accountancyage\.example\n+21 Oct 2026$/, 'company + contact, still being checked, the signal, source link and date')
  assert.equal(await page.getByTestId('first-heading').textContent(), '2 found - checking each one')
  assert.equal(await page.getByTestId('live-now').textContent(), 'Checking each lead and looking up who to contact...', 'sources done, leads being checked')
  if (how === 'cta' && !incomplete) await shot('3-checking')
  // 4. Settled.
  if (full) {
    // Settled: only leads that meet the ready bar (approve gate: evidence + a published email + ...) are ready to contact.
    const heading = incomplete ? '5 found - research needed before outreach' : '3 ready to contact, 2 need research'
    await page.waitForFunction(h => document.querySelector('[data-testid=first-heading]')?.textContent === h, heading, { timeout: 10000 })
    assert.equal(await page.getByTestId('first-lead').count(), 5)
    const badges = await page.getByTestId('first-lead').evaluateAll(ls => ls.map(l => l.querySelector('.pill')?.textContent))
    assert.deepEqual(badges, incomplete ? Array(5).fill('needs research') : ['ready to contact', 'ready to contact', 'needs research', 'ready to contact', 'needs research'])
    assert.equal(await page.getByTestId('lead-gap').first().textContent(), 'To contact: No published email address to draft to yet.')
    assert.equal(await page.getByTestId('ready-cta').textContent(), incomplete ? 'See what needs research' : 'Start reaching out')
    assert.equal(await page.getByTestId('ready-subhead').textContent(), incomplete ? 'dazl found 5 leads; each needs a contact or more evidence before outreach.' : 'dazl found 3 leads ready to contact.')
    assert.doesNotMatch(await page.getByTestId('onboarding-screen').innerText(), incomplete ? /Start reaching out|ready to contact/ : /5 leads ready|ready for your review/, 'never more ready than the ready bar allows')
    // Dates: the same calendar day as written, in this browser's time zone too (Toronto runs west of UTC).
    assert.match(await page.getByTestId('first-lead').first().innerText(), /21 Oct 2026/, `date in ${tz}`)
    assert.equal(await page.getByTestId('search-wider').count(), 0)
  } else {
    await page.waitForFunction(() => document.querySelector('[data-testid=first-heading]')?.textContent === '2 ready to contact', null, { timeout: 10000 })
    const wider = page.getByTestId('search-wider')
    assert.equal(await wider.textContent(), 'Search wider (a full scan, using your scan allowance)')
    assert.equal(await wider.getAttribute('href'), `/app/leads?q=${encodeURIComponent(query)}`, 'the wider search is a link to Plays, prefilled; it never starts by itself')
  }
  const out = await page.getByTestId('onboarding-screen').evaluate(e => e.scrollWidth <= e.clientWidth)
  assert.equal(out, true, `no horizontal overflow at ${width}px`)
  if (how === 'cta') { await page.waitForTimeout(300); await shot('4-leads'); if (process.env.SHOTS) await page.getByTestId('first-customers').screenshot({ path: path.join(process.env.SHOTS, `4-leads-card-${tag}.png`) }) }
  assert.equal(writes.filter(w => w === 'POST /api/scan').length, 1, 'exactly one scan')
  await ctx.close()
  return { typed, firstCardSeconds }
}
try {
  const d = await run({ width: 1440, height: 900, tag: 'desktop', tz: 'America/Toronto' })
  const m = await run({ width: 390, height: 844, tag: 'mobile' })
  const c = await run({ width: 1440, height: 900, tag: 'held', how: 'chip' })
  const t = await run({ width: 1440, height: 900, tag: 'held', how: 'typed', full: false })
  await run({ width: 1440, height: 900, tag: 'research', incomplete: true, tz: 'America/Toronto' })
  assert.deepEqual([d.typed, m.typed, c.typed], [1, 1, 1], 'the website is the only thing typed')
  assert.equal(t.typed, 2, 'a typed sentence is the second thing typed, only when the user chooses to')
  console.log(`MEASURE things typed before the first lead card: ${d.typed} (desktop), ${m.typed} (390px), ${c.typed} (suggestion click)`)
  console.log(`MEASURE seconds from sign-in to the first lead card (seeded, stubbed timings): ${d.firstCardSeconds.toFixed(1)} desktop, ${m.firstCardSeconds.toFixed(1)} 390px`)
  console.log('one-sentence UI check passed: website is the only thing typed, sentence prefilled from the profile, one first5 scan, live source + candidates view, lead cards, ready / short result with a wider-search link')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
