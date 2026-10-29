// Rendered check for the per-play offer (#349). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/play-offer.ui.mjs   (SHOTS=<dir> also saves screenshots, desktop and 390px)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, and EVERY /api/* CALL ANSWERED
// FROM A STUB in the browser (synthetic plays and offers; no scan, no draft, nothing sent). It proves:
//   1. Home shows what the CURRENT play sells next to its targeting, not the business profile's offer; the profile
//      fact is labelled as where new plays start;
//   2. a play whose request names another offer than the one it started with is shown as a choice (Home, its campaign
//      page and its drafts page), and choosing posts that play's offer only;
//   3. after the choice, Home, the campaign page and the drafts page all say the same offer;
//   4. the older dental play's campaign page still says the dental offer.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-playoffer-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

// Synthetic plays: the newer London play (its request sells CRM consulting, but it started with the dental profile)
// and the older dental play. Not real run ids, companies or people.
const DENTAL = 'Appointment booking and reminder software for dental practices'
const CRM = 'CRM setup and outbound consulting'
const LONDON = 'a'.repeat(24), DENTAL_JOB = 'd'.repeat(24)
const LONDON_Q = `Selling ${CRM} to London B2B SaaS startups that raised seed funding in the past 90 days`
const DENTAL_Q = 'Independent dental practices in New York hiring a front-desk coordinator in the past 60 days'
let londonOffer = { offer: null, source: 'conflict', conflict: { stated: CRM, recorded: DENTAL } }
const dentalOffer = { offer: DENTAL, source: 'recorded', conflict: null }
const job = (id, query, created) => ({ id, status: 'done', error: null, query, business_name: '', csv_domain: null, created_at: created, finished_at: created + 100, candidates: 6, verified: 2, needs_review: 1, dropped: 3, lead_count: 2, test_only: false })
const lead = (id, company, jobId) => ({ id: id.repeat(24), scan_job_id: jobId, company, name: 'Sam Example', contact: `hello@${company.toLowerCase().replace(/\W+/g, '')}.example`, signal: 'Opened a new office', source_url: `https://news.example/${id}`, evidence_excerpt: `${company} opened a new office`, confidence: 80, human_confirmed_at: 1, review_reason: null, quarantined_at: null, event_date: '2026-10-15', date_status: 'verified' })
const LEADS = { [LONDON]: [lead('1', 'Northwind Analytics', LONDON)], [DENTAL_JOB]: [lead('2', 'Bright Smile Dental', DENTAL_JOB)] }
const MSG = (l, offer) => ({ id: l.id.slice(0, 1) + 'm'.repeat(23), lead_id: l.id, to_email: l.contact, subject: `Quick question for ${l.company}`, body: `Hi Sam,\n\nAbout Acme: ${offer}\n\nThanks,`, status: 'draft', error: null, created_at: 1761600000, sent_at: null, test: 0, company: l.company })
const posts = []
const b = await chromium.launch()
const shots = process.env.SHOTS
const run = async (width, label) => {
  londonOffer = { offer: null, source: 'conflict', conflict: { stated: CRM, recorded: DENTAL } } // each pass starts before the choice
  const ctx = await b.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method()
    if (u.origin !== base) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (u.pathname === '/api/settings/profile') return json({ sells: DENTAL, website: 'https://acme.example', business_name: 'Acme', buyer: { summary: 'Dental practice owners', who: ['Practice owner'], industries: ['Dental'], sizes: [], where: ['New York'], signals: [], exclude: [] } })
    if (u.pathname === '/api/scan/jobs') return json({ jobs: [job(LONDON, LONDON_Q, 1761600000), job(DENTAL_JOB, DENTAL_Q, 1761000000)] })
    if (u.pathname === '/api/scan/latest') return json({ query: LONDON_Q, icp: { summary: 'London seed-stage B2B SaaS', who: ['Founder', 'Head of Sales'], industries: ['B2B SaaS'], sizes: ['1-50'], where: ['London, UK'], signals: ['raised seed funding'], exclude: [], window_days: 90 }, icp_inferred: 1 })
    if (u.pathname === '/api/leads') { const id = u.searchParams.get('job_id'); return json({ job_id: id, status: 'done', hidden_count: 0, leads: LEADS[id] ?? [] }) }
    for (const [id, offer] of [[LONDON, () => londonOffer], [DENTAL_JOB, () => dentalOffer]]) {
      if (u.pathname === `/api/campaigns/${id}`) {
        if (m === 'POST') { const body = JSON.parse(req.postData() || '{}'); posts.push([id, body.offer]); if (id === LONDON) londonOffer = { offer: body.offer, source: 'play', conflict: null }; return json({ offer: id === LONDON ? londonOffer : dentalOffer }) }
        const o = offer(); const ls = LEADS[id]
        return json({ job: { ...job(id, id === LONDON ? LONDON_Q : DENTAL_Q, 1761600000) }, leads: ls, messages: o.offer ? ls.map(l => MSG(l, o.offer)) : [], offer: o })
      }
    }
    if (u.pathname === '/api/outreach') return json({ messages: [...LEADS[LONDON].map(l => MSG(l, CRM)), ...LEADS[DENTAL_JOB].map(l => MSG(l, DENTAL))] })
    if (u.pathname === '/api/watch') return json({ watches: [] })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  const shot = async name => { if (shots) await page.screenshot({ path: path.join(shots, `${name}-${label}.png`), fullPage: true }) }
  // Home scrolls inside its own container: the section that shows the play's offer is captured on its own
  const shotOf = async (name, testid) => { if (shots) await page.getByTestId(testid).screenshot({ path: path.join(shots, `${name}-${label}.png`) }) }
  // Home, before the choice: the current London play is contested; the profile fact is labelled as the starting point
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  await page.getByTestId('journey-play-offer').waitFor({ timeout: 20000 })
  await page.getByTestId('play-offer-conflict').waitFor()
  assert.match(await page.getByTestId('journey-understanding').textContent(), /Your business profile sells \(new plays start from this\)/)
  await shot('home-conflict'); await shotOf('home-understanding-conflict', 'journey-understanding')
  // the campaign page offers the choice; choosing posts this play's offer only
  await page.goto(`${base}/app/campaigns/${LONDON}`, { waitUntil: 'networkidle' })
  await page.getByTestId('play-offer-conflict').waitFor({ timeout: 20000 })
  await shot('campaign-conflict')
  await page.getByTestId('play-offer-use-stated').click()
  await page.getByTestId('play-offer-text').filter({ hasText: CRM }).waitFor()
  // now Home, the campaign page and the drafts page say the same offer for the London play
  await shot('campaign-chosen')
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  await page.getByTestId('play-offer-text').filter({ hasText: CRM }).waitFor({ timeout: 20000 })
  assert.doesNotMatch(await page.getByTestId('journey-play-offer').textContent(), /dental/i)
  await shot('home-chosen'); await shotOf('home-understanding-chosen', 'journey-understanding')
  await page.goto(`${base}/app/outreach?job_id=${LONDON}`, { waitUntil: 'networkidle' })
  await page.getByTestId('outreach-play-offer').getByTestId('play-offer-text').filter({ hasText: CRM }).waitFor({ timeout: 20000 })
  assert.match(await page.locator('pre').first().textContent(), new RegExp(`About Acme: ${CRM}`))
  await shot('drafts')
  // the older dental play keeps its own offer
  await page.goto(`${base}/app/campaigns/${DENTAL_JOB}`, { waitUntil: 'networkidle' })
  await page.getByTestId('play-offer-text').filter({ hasText: DENTAL }).waitFor({ timeout: 20000 })
  await shot('dental-campaign')
  await ctx.close()
}
try {
  await run(1280, 'desktop')
  await run(390, 'mobile')
  assert.deepEqual(posts, [[LONDON, CRM], [LONDON, CRM]], 'only the London play was changed, once per run')
  console.log('play offer UI check passed: Home shows the current play\'s offer beside its targeting, a contested play asks before drafting, the choice changes that play only, and Home, campaign and drafts agree; the dental play keeps its offer (desktop and 390px)')
} catch (e) { console.error(e); process.exitCode = 1 } finally { await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true }) }
