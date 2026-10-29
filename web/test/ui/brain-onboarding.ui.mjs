// Onboarding to "Your brain is ready", the Pancake-style first run (Hermes for Gagan). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/brain-onboarding.ui.mjs   (SHOTS=<dir> saves desktop + mobile screenshots)
// Production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed in the
// browser: no site is fetched, no model is called, no scan runs, nothing is sent. It proves:
//   1. a new account sees one input (its website) on a full screen; nothing else is asked;
//   2. "Read my site" shows the brain building: one node per fact the read returned, nothing invented;
//   3. the inferred profile is saved exactly as read (one POST /api/settings/profile), then "Your brain is ready." with
//      the plan card (4 checks, one dark CTA) and the first-customers card; no scan has started on its own;
//   4. one click on "Find my first leads" sends exactly one POST /api/scan with the first suggested play and the
//      inferred profile; progress shows in place; when it is done, the first 5 ready customers (initials, name,
//      "Title · Company", fit) are listed and a held lead is not among them.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-brain-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const J = 'f'.repeat(24)
const READ = { source: 'https://www.dazl.ai/', sells: 'Signal-based prospecting for small B2B teams',
  icp: { summary: 'B2B SaaS founders and agency owners, 1-50 employees', who: ['Founder', 'Head of Sales, EMEA'], industries: ['B2B SaaS', 'IT services, consulting', 'Agencies'], where: ['London, UK', 'Toronto, Canada', 'New York, NY'], sizes: ['1-50 employees'], signals: ['Hiring an SDR or AE', 'Raised a seed round'], exclude: ['Enterprises'] } }
const person = (n, url) => ({ connector: 'sitecrawl', kind: 'person', value: n, label: null, source_url: url, source_date: '2026-10-20', confidence: null })
const lead = (id, company, who, o = {}) => ({ id, name: '', company, contact: `hi@${id.slice(0, 3)}.example`, signal: `${company} is hiring an SDR`, source_url: `https://boards.example/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} is hiring an SDR`, event_date: '2026-10-14', date_status: 'verified', published_at: null, confidence: 90, review_reason: null, company_domain: `${id.slice(0, 3)}.example`, human_confirmed_at: null, fit: 5, intent: 4, action: 3, why: `${company} posted its first SDR role this month.`, signals: null, icp_match: null, enrichments: [person(who, 'https://boards.example/x')], events: [], ...o })
const LEADS = [
  lead('1'.repeat(24), 'Northwind Labs', 'Maya Chen, Founder & CEO'),
  lead('2'.repeat(24), 'Kitebase', 'Omar Haddad, Co-founder'),
  lead('3'.repeat(24), 'Brightline Studio', 'Tess Morgan, Founder', { fit: 4 }),
  lead('4'.repeat(24), 'Quillwork', 'Ravi Patel, Head of Sales', { fit: 4 }),
  lead('5'.repeat(24), 'Harbor Analytics', 'Lena Fischer, CEO'),
  lead('6'.repeat(24), 'Gramercy Partners', 'Pat Lee, Founder', { review_reason: 'identity_mismatch' }),
]
const b = await chromium.launch()
async function run(width, height, tag, leads = LEADS, fail = false) {
  const st = { profile: { business_name: '', sells: '', website: '', buyer: null }, jobs: [], scanBodies: [], profileBodies: [], status: 'pending', polls: 0 }
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
    if (p === '/api/settings/profile' && m === 'POST') { const body = JSON.parse(req.postData()); st.profileBodies.push(body); st.profile = { ...st.profile, ...body }; return json({ ok: true }) }
    if (p === '/api/settings/profile') return json(st.profile)
    if (p === '/api/scan' && m === 'POST') { st.scanBodies.push(JSON.parse(req.postData())); return json({ job_id: J }) }
    if (p === '/api/scan/status') { st.polls++; st.status = st.polls < 2 ? 'running' : fail ? 'failed' : 'done'; return json({ job_id: J, status: st.status, lead_count: st.status === 'done' ? 6 : 2 }) }
    if (p === '/api/leads') return json({ leads, hidden_count: 0 })
    if (p === '/api/scan/jobs') return json({ jobs: st.jobs })
    if (p === '/api/usage') return json({ plan: 'free', scans_used: 0, scan_limit: 10, has_key: true, trial: null })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}-${tag}.png`) }) }
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  const screen = page.getByTestId('onboarding-screen')
  // The fixed full-screen container is its own scroller: check it, not only the document (Instinct #332, 390px).
  const fits = async what => {
    const r = await screen.evaluate(e => ({ sw: e.scrollWidth, cw: e.clientWidth, out: [...e.querySelectorAll('[data-testid=ready-step] *, [data-testid=site-step] *')].filter(n => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().right > e.clientWidth + 0.5).length }))
    assert.ok(r.sw <= r.cw && r.out === 0, `${what} fits at ${width}px (scrollWidth ${r.sw}, clientWidth ${r.cw}, ${r.out} elements past the edge)`)
  }
  await page.getByTestId('site-step').waitFor({ timeout: 15000 })
  // 1. One input.
  assert.equal(await screen.locator('input:visible, textarea:visible, select:visible').count(), 1, 'the website is the only thing asked')
  await fits('site step')
  await shot('1-site')
  await page.getByLabel('Your website').fill('dazl.ai')
  await page.getByRole('button', { name: 'Read my site' }).click()
  // 2. The brain builds from the read.
  await page.getByTestId('building-step').waitFor()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=brain-node]').length >= 6)
  await shot('2-building')
  await page.getByTestId('ready-step').waitFor({ timeout: 15000 })
  assert.equal(await page.getByTestId('brain-node').count(), 15, 'one node per fact the read returned')
  // 3. Saved as read; ready screen; nothing started.
  assert.deepEqual(st.profileBodies, [{ sells: READ.sells, website: 'https://dazl.ai', business_name: '', buyer: READ.icp }])
  assert.deepEqual(st.scanBodies, [], 'no scan starts on its own')
  assert.equal(await page.getByRole('heading', { name: 'Your brain is ready.' }).isVisible(), true)
  assert.equal(await page.getByTestId('ready-plan').locator('li').count(), 4)
  assert.equal(await page.getByTestId('first-play').count(), 3)
  // The inferred criteria are shown before the click, item for item ("London, UK" is one place).
  assert.equal(await page.getByTestId('first-heading').textContent(), 'Who do you want to find?')
  for (const [k, v] of [['who', READ.icp.who], ['industry', READ.icp.industries], ['where', READ.icp.where], ['size', READ.icp.sizes], ['signals', READ.icp.signals], ['skip', READ.icp.exclude]]) assert.deepEqual(await page.getByTestId(`criteria-${k}`).locator('.pill').allTextContents(), v, `${k} shown exactly as inferred`)
  await page.waitForTimeout(600)
  await fits('ready screen')
  await shot('3-ready')
  if (process.env.SHOTS && tag !== 'held') for (const id of ['ready-plan', 'first-customers']) await page.getByTestId(id).screenshot({ path: path.join(process.env.SHOTS, `3-${id}-${tag}.png`) })
  // 4. One click starts the first play; customers appear in place.
  const firstPlay = await page.getByTestId('first-play').first().innerText()
  await page.getByTestId('ready-cta').click()
  await page.getByTestId('first-progress').waitFor()
  assert.equal(await page.getByTestId('first-heading').textContent(), 'Finding your first leads')
  if (leads === LEADS) await page.getByTestId('first-lead').first().waitFor({ timeout: 20000 })
  assert.deepEqual(st.scanBodies, [{ query: firstPlay.trim(), icp: READ.icp, mode: 'first5' }], 'exactly one scan: the first play (the prefilled sentence) and the inferred profile, every list item as read, as the fast first scan')
  if (leads !== LEADS) {
    // Nothing ready (only held, none at all, or the play failed): heading and button say what is there, never "Start
    // reaching out" (Instinct #332).
    const [heading, cta] = fail ? ['This play could not finish', 'See what happened'] : leads.length ? ['Leads held for your review', 'Review held leads'] : ['No leads in this first play', 'View results']
    await page.waitForFunction(h => document.querySelector('[data-testid=first-heading]')?.textContent === h, heading, { timeout: 20000 })
    assert.equal(await page.getByTestId('ready-cta').textContent(), cta)
    assert.equal(await page.getByTestId('ready-cta').getAttribute('href'), `/app/leads?job_id=${J}`)
    assert.equal(await page.getByTestId('first-lead').count(), 0)
    if (!fail && leads.length) assert.match(await page.getByTestId('first-customers').innerText(), /0 ready to contact, 1 held for your review/)
    assert.doesNotMatch(await page.getByTestId('onboarding-screen').innerText(), /Start reaching out|Watch it live/)
    await ctx.close(); return
  }
  const rows = await page.getByTestId('first-lead').allInnerTexts()
  assert.equal(rows.length, 5)
  assert.match(rows[0], /Maya Chen\nFounder & CEO · Northwind Labs\nready to contact$/)
  assert.match(rows[1], /Omar Haddad\nCo-founder · Kitebase/, 'a hyphenated title is kept whole')
  assert.ok(!rows.some(r => /Gramercy|Pat Lee/.test(r)), 'a held lead is not a ready customer')
  assert.equal(await page.getByTestId('ready-subhead').textContent(), 'dazl found 5 leads ready to contact.')
  assert.equal(await page.getByTestId('first-heading').textContent(), '5 ready to contact')
  assert.equal(await page.getByTestId('ready-cta').textContent(), 'Start reaching out')
  assert.equal(await page.getByTestId('ready-cta').evaluate(e => e.tagName), 'BUTTON', 'with leads ready, reaching out opens the review step in place (test/ui/first-review.ui.mjs)')
  await page.waitForTimeout(400)
  await fits('ready screen with leads')
  await shot('4-customers')
  if (process.env.SHOTS) await page.getByTestId('first-customers').screenshot({ path: path.join(process.env.SHOTS, `4-first-customers-${tag}.png`) })
  assert.deepEqual(writes, ['POST /api/scan/icp-from-url', 'POST /api/settings/profile', 'POST /api/scan'])
  await ctx.close()
}
try {
  await run(1440, 900, 'desktop')
  await run(390, 844, 'mobile')
  await run(1440, 900, 'held', LEADS.filter(l => l.review_reason))
  await run(1440, 900, 'held', [])
  await run(1440, 900, 'held', [], true)
  console.log('brain onboarding UI check passed: one input, comma-bearing criteria kept whole from read to scan, state headings and buttons (pick / finding / N ready / held only / none / failed), no overflow at 390px, brain built from the read (15 facts), profile saved as read, ready screen with plan + first customers, one click -> one scan -> 5 ready customers in place, held lead excluded')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
