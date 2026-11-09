// Rendered check for a play that never recorded its offer (#687, part of #349). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/play-offer-unconfirmed.ui.mjs   (SHOTS=<dir> also saves screenshots, 1280 and 390px)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, and EVERY /api/* CALL ANSWERED
// FROM A STUB in the browser with the shape GET /api/campaigns/:id returns for such a play (readPlayOffer ->
// storedPlayOffer: { offer: <current profile offer>, source: 'profile', conflict: null, unconfirmed: true }). Synthetic
// plays only; no scan, no draft, nothing sent. It proves:
//   1. Home, the play's campaign page and its drafts page show an explicit "Confirm what this play sells" alert naming
//      the CURRENT offer, never "This play sells ... (recorded when this play started)" or a plain profile label;
//   2. confirming posts that offer for this play only; writing another posts the typed one; afterwards the three pages
//      show the chosen offer, labelled as chosen for this play;
//   3. a play with a recorded offer on the same pages shows no alert.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-playoffer687-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

// The old play ran while the profile sold dental software; the profile now sells bookkeeping. Nothing recorded which.
const BOOKS = 'Bookkeeping for independent design agencies'
const OTHER = 'Payroll setup for dental practices'
const OLD = 'e'.repeat(24), REC = 'f'.repeat(24)
const OLD_Q = 'Independent dental practices in New York hiring a front-desk coordinator in the past 60 days'
const REC_Q = 'Design agencies in Leeds hiring an office manager in the past 60 days'
const UNCONFIRMED = { offer: BOOKS, source: 'profile', conflict: null, unconfirmed: true }
let oldOffer = UNCONFIRMED
const recOffer = { offer: BOOKS, source: 'recorded', conflict: null }
const job = (id, query, created) => ({ id, status: 'done', error: null, query, business_name: '', csv_domain: null, created_at: created, finished_at: created + 100, candidates: 6, verified: 2, needs_review: 1, dropped: 3, lead_count: 1, test_only: false })
const lead = (id, company, jobId) => ({ id: id.repeat(24), scan_job_id: jobId, company, name: 'Sam Example', contact: `hello@${company.toLowerCase().replace(/\W+/g, '')}.example`, signal: 'Hiring a front-desk coordinator', source_url: `https://jobs.example/${id}`, evidence_excerpt: `${company} is hiring a front-desk coordinator`, confidence: 80, human_confirmed_at: 1, review_reason: null, quarantined_at: null, event_date: '2026-10-15', date_status: 'verified' })
const LEADS = { [OLD]: [lead('3', 'Gentle Dental Studio', OLD)], [REC]: [lead('4', 'Northern Design Co', REC)] }
// a draft written before this change, under the old fallback: kept for inspection, its approval is what the server refuses
const MSG = l => ({ id: l.id.slice(0, 1) + 'm'.repeat(23), lead_id: l.id, to_email: l.contact, subject: `Quick question for ${l.company}`, body: 'Hi Sam,\n\nA short synthetic draft.\n\nThanks,', status: 'draft', error: null, created_at: 1761600000, sent_at: null, test: 0, company: l.company })
const posts = []
const b = await chromium.launch()
const shots = process.env.SHOTS
const run = async (width, label, resolve) => {
  oldOffer = UNCONFIRMED // each pass starts before the choice
  const ctx = await b.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method()
    if (u.origin !== base) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (u.pathname === '/api/settings/profile') return json({ sells: BOOKS, website: 'https://acme.example', business_name: 'Acme', buyer: { summary: 'Design agency owners', who: ['Owner'], industries: ['Design'], sizes: [], where: ['Leeds'], signals: [], exclude: [] } })
    if (u.pathname === '/api/scan/jobs') return json({ jobs: [job(OLD, OLD_Q, 1761600000), job(REC, REC_Q, 1761000000)] })
    if (u.pathname === '/api/scan/latest') return json({ query: OLD_Q, icp: { summary: 'NYC independent dental practices', who: ['Practice owner'], industries: ['Dental'], sizes: ['1-5 locations'], where: ['New York'], signals: ['hiring a front-desk coordinator'], exclude: [], window_days: 60 }, icp_inferred: 1 })
    if (u.pathname === '/api/leads') { const id = u.searchParams.get('job_id'); return json({ job_id: id, status: 'done', hidden_count: 0, leads: LEADS[id] ?? [] }) }
    for (const id of [OLD, REC]) {
      if (u.pathname === `/api/campaigns/${id}`) {
        if (m === 'POST') { const body = JSON.parse(req.postData() || '{}'); posts.push([id, body.offer]); if (id === OLD) oldOffer = { offer: body.offer, source: 'play', conflict: null }; return json({ offer: id === OLD ? oldOffer : recOffer }) }
        const ls = LEADS[id]
        return json({ job: { ...job(id, id === OLD ? OLD_Q : REC_Q, 1761600000) }, leads: ls, messages: ls.map(MSG), offer: id === OLD ? oldOffer : recOffer })
      }
    }
    if (u.pathname === '/api/outreach') return json({ messages: [...LEADS[OLD], ...LEADS[REC]].map(MSG) })
    if (u.pathname === '/api/watch') return json({ watches: [] })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  const shot = async name => { if (shots) await page.screenshot({ path: path.join(shots, `${name}-${label}.png`), fullPage: true }) }
  // Home scrolls inside its own container: the section that shows the play's offer is captured on its own
  const shotOf = async (name, testid) => { if (shots) await page.getByTestId(testid).screenshot({ path: path.join(shots, `${name}-${label}.png`) }) }
  const unconfirmedShown = async scope => {
    const card = scope.getByTestId('play-offer-unconfirmed')
    await card.waitFor({ timeout: 20000 })
    const text = await card.textContent()
    assert.match(text, /Confirm what this play sells/); assert.match(text, /did not record an offer when this play started/)
    assert.equal(await card.getByTestId('play-offer-current').textContent(), BOOKS)
    assert.match(text, /will not draft or approve emails for this play until you confirm/)
    assert.equal(await card.getAttribute('role'), 'alert')
    // never presented as a pinned offer
    assert.equal(await scope.getByTestId('play-offer-text').count(), 0)
    assert.doesNotMatch(await scope.textContent(), /recorded when this play started|from your business profile/)
  }
  // 1. Home, the campaign page and the drafts page, before the choice
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  await page.getByTestId('journey-play-offer').waitFor({ timeout: 20000 })
  await unconfirmedShown(page.getByTestId('journey-play-offer'))
  await shot('home-unconfirmed'); await shotOf('home-play-offer-unconfirmed', 'journey-play-offer')
  await page.goto(`${base}/app/outreach?job_id=${OLD}`, { waitUntil: 'networkidle' })
  await page.getByTestId('outreach-play-offer').waitFor({ timeout: 20000 })
  await unconfirmedShown(page.getByTestId('outreach-play-offer'))
  await shot('drafts-unconfirmed')
  await page.goto(`${base}/app/campaigns/${OLD}`, { waitUntil: 'networkidle' })
  await page.getByTestId('play-offer-unconfirmed').waitFor({ timeout: 20000 })
  await unconfirmedShown(page.locator('main'))
  await shot('campaign-unconfirmed'); await shotOf('campaign-play-offer-unconfirmed', 'play-offer-unconfirmed')
  // 2. the choice: confirm the current offer (desktop) or write another (mobile); this play only
  const chosen = resolve === 'confirm' ? BOOKS : OTHER
  if (resolve === 'confirm') await page.getByTestId('play-offer-confirm-current').click()
  else {
    await page.getByTestId('play-offer-write').click()
    await page.getByTestId('play-offer-input').fill(OTHER)
    await page.getByTestId('play-offer-save').click()
  }
  await page.getByTestId('play-offer-text').filter({ hasText: chosen }).waitFor({ timeout: 20000 })
  assert.equal(await page.getByTestId('play-offer-unconfirmed').count(), 0)
  assert.match(await page.getByTestId('play-offer').textContent(), /chosen for this play/)
  await shot('campaign-chosen')
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  await page.getByTestId('journey-play-offer').getByTestId('play-offer-text').filter({ hasText: chosen }).waitFor({ timeout: 20000 })
  await shot('home-chosen'); await shotOf('home-play-offer-chosen', 'journey-play-offer')
  await page.goto(`${base}/app/outreach?job_id=${OLD}`, { waitUntil: 'networkidle' })
  await page.getByTestId('outreach-play-offer').getByTestId('play-offer-text').filter({ hasText: chosen }).waitFor({ timeout: 20000 })
  await shot('drafts-chosen')
  // 3. a play with a recorded offer shows it plainly, with no alert
  await page.goto(`${base}/app/campaigns/${REC}`, { waitUntil: 'networkidle' })
  await page.getByTestId('play-offer-text').filter({ hasText: BOOKS }).waitFor({ timeout: 20000 })
  assert.equal(await page.getByTestId('play-offer-unconfirmed').count(), 0)
  assert.match(await page.getByTestId('play-offer').textContent(), /recorded when this play started/)
  await shot('recorded-campaign')
  await ctx.close()
  return chosen
}
try {
  const a = await run(1280, 'desktop', 'confirm')
  const c = await run(390, 'mobile', 'write')
  assert.deepEqual(posts, [[OLD, a], [OLD, c]], 'only the unconfirmed play was changed, once per pass, with the offer chosen')
  console.log('unconfirmed play offer UI check passed: Home, campaign and drafts show the explicit confirm alert with the current offer and never a recorded label; confirming or writing another posts that play only, then all three show the chosen offer; a recorded play shows no alert (1280 and 390px)')
} catch (e) { console.error(e); process.exitCode = 1 } finally { await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true }) }
