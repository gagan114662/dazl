// #1037: every lead row names the person to contact (name · title · LinkedIn or source), or "No buyer named yet",
// on Leads AND on the first play's cards. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/lead-person.ui.mjs   (SHOTS=<dir> saves desktop + mobile screenshots)
// Production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed in the
// browser (invented companies and people): no site is fetched, no search or model call is made, nothing is sent. It proves:
//   1. Leads: each card shows its person line without opening Details: a public-search person with a LinkedIn link and
//      the "search result, not verified as current" label; a site-listed person with a source link; "No buyer named
//      yet" for a lead with nobody and for a lead whose only person has a former title (never shown);
//   2. the first play (mode first5): once the play is done, each first-play card shows the same line;
//   3. the lines fit at 390px (no element past the screen edge).
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-person-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), email_verified_at INTEGER); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt,email_verified_at) VALUES ('u1','s@example.test','x','y',1)").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
// A file:// URL for --import (a bare Windows path is rejected by node's ESM loader).
const fence = pathToFileURL(path.join(dir, 'test/helpers/net-fence.ts')).href
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${fence}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const J = 'f'.repeat(24)
const READ = { source: 'https://www.dazl.ai/', sells: 'Signal-based prospecting for small B2B teams',
  icp: { summary: 'B2B SaaS teams hiring their first sellers', who: ['Head of Sales', 'Founder'], industries: ['B2B SaaS'], where: ['London, UK'], sizes: ['1-50 employees'], signals: ['Hiring an SDR or AE'], exclude: ['Enterprises'] } }
const ppl = (connector, value, url) => ({ connector, kind: 'person', value, label: null, source_url: url, source_date: '2026-11-08', confidence: null })
const lead = (id, company, enrichments, o = {}) => ({ id, name: '', company, contact: null, signal: `${company} is hiring its first SDR`, source_url: `https://boards.example/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} is hiring its first SDR`, event_date: '2026-11-02', date_status: 'verified', published_at: null, confidence: 90, review_reason: null, company_domain: null, human_confirmed_at: null, fit: 5, intent: 4, action: 3, why: `${company} posted its first SDR role this month.`, signals: null, icp_match: null, enrichments, events: [], ...o })
const LEADS = [
  lead('1'.repeat(24), 'Northwind Labs', [ppl('search:people', 'Maya Chen, Head of Sales', 'https://uk.linkedin.com/in/maya-chen-nw')]),
  lead('2'.repeat(24), 'Kitebase', [ppl('sitecrawl', 'Omar Haddad, Co-founder', 'https://kitebase.example/team')]),
  lead('3'.repeat(24), 'Harbor Analytics', []),
  lead('4'.repeat(24), 'Gramercy Cloud', [ppl('search:people', 'Pat Lee, Former Head of Sales', 'https://www.linkedin.com/in/pat-lee-gc')]),
]
const f5lead = l => ({ id: l.id, company: l.company, name: null, signal: l.signal, source_url: l.source_url, event_date: l.event_date, published_at: null, fit_pct: 100, provisional: false })
const F5 = { target: 5, found: 4, verified: 4, enriching: false, next: { action: 'wider_search', label: 'Search wider' }, state: 'partial', finding_more: false, reason: null, message: '4 of 5 verified from the free sources. You can search wider.', leads: LEADS.map(f5lead), sources: [{ source: 'search:news', state: 'done', status: 'ok', note: null, candidates: 6, accepted: 4, review: 0, rejected: 2 }], failed_sources: [], can_continue: true }
const EXPECT = [
  { company: 'Northwind Labs', text: /Maya Chen · Head of Sales · LinkedIn \(search result, not verified as current\)/, href: 'https://uk.linkedin.com/in/maya-chen-nw' },
  { company: 'Kitebase', text: /Omar Haddad · Co-founder · source \(search result, not verified as current\)/, href: 'https://kitebase.example/team' },
  { company: 'Harbor Analytics', text: /^No buyer named yet/, href: null },
  { company: 'Gramercy Cloud', text: /^No buyer named yet/, href: null },
]

const b = await chromium.launch()
const shotDir = process.env.SHOTS
async function context(width, height) {
  const ctx = await b.newContext({ viewport: { width, height } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const st = { profile: { business_name: '', sells: '', website: '', buyer: null }, polls: 0, writes: [] }
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (m !== 'GET') st.writes.push(`${m} ${p}`)
    if (p === '/api/scan/icp-from-url') return json(READ)
    if (p === '/api/settings/profile' && m === 'POST') { st.profile = { ...st.profile, ...JSON.parse(req.postData()) }; return json({ ok: true }) }
    if (p === '/api/settings/profile') return json(st.profile)
    if (p === '/api/scan' && m === 'POST') return json({ job_id: J })
    if (p === '/api/scan/status') { st.polls++; const done = st.polls >= 2; return json({ job_id: J, status: done ? 'done' : 'running', lead_count: 4, icp: READ.icp, icp_source: 'user', attempts: 1, max_attempts: 3, query: 'B2B SaaS teams hiring their first SDR', first5: done ? F5 : { ...F5, state: 'finding', finding_more: true, verified: 0, leads: [] } }) }
    if (p === '/api/leads') return json({ job_id: J, status: 'done', hidden_count: 0, leads: LEADS })
    if (p === '/api/scan/jobs') return json({ jobs: [] })
    if (p === '/api/usage') return json({ plan: 'free', scans_used: 0, scan_limit: 10, has_key: true, trial: null })
    if (p === '/api/enrich/held') return json({ held: [] })
    return json({}, 404)
  })
  return { ctx, st }
}
const fitsAt = async (page, sel) => page.evaluate(s => [...document.querySelectorAll(s)].filter(n => n.getBoundingClientRect().right > window.innerWidth + 0.5).length, sel)

async function leadsPage(width, height, tag) {
  const { ctx, st } = await context(width, height); const page = await ctx.newPage()
  await page.goto(`${base}/app/leads?job_id=${J}&passive=1`, { waitUntil: 'networkidle' })
  const cards = page.getByTestId('lead-card'); await cards.first().waitFor({ timeout: 20000 })
  assert.equal(await cards.count(), 4)
  for (const e of EXPECT) {
    const line = cards.filter({ hasText: e.company }).getByTestId('lead-person')
    assert.equal(await line.isVisible(), true, `${e.company}: the person line is on the collapsed card`)
    assert.match((await line.innerText()).replace(/\s+/g, ' ').trim(), e.text, e.company)
    if (e.href) assert.equal(await line.locator('a').first().getAttribute('href'), e.href)
    else assert.equal(await line.getAttribute('data-empty'), 'true')
  }
  assert.doesNotMatch(await cards.filter({ hasText: 'Gramercy Cloud' }).getByTestId('lead-person').innerText(), /Pat Lee/, 'a former title is never the named person')
  assert.equal(await fitsAt(page, '[data-testid=lead-person], [data-testid=lead-person] *'), 0, `person lines fit at ${width}px`)
  if (shotDir) { await cards.first().screenshot({ path: path.join(shotDir, `leads-card-named-${tag}.png`) }); await cards.nth(2).screenshot({ path: path.join(shotDir, `leads-card-none-${tag}.png`) }); await page.screenshot({ path: path.join(shotDir, `leads-page-${tag}.png`) }) }
  assert.deepEqual(st.writes, [], 'viewing the leads writes nothing')
  await ctx.close()
}

async function firstPlay(width, height, tag) {
  const { ctx } = await context(width, height); const page = await ctx.newPage()
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  await page.getByTestId('site-step').waitFor({ timeout: 20000 })
  await page.getByLabel('Your website').fill('dazl.ai')
  await page.getByRole('button', { name: 'Read my site' }).click()
  await page.getByTestId('ready-step').waitFor({ timeout: 20000 })
  await page.getByTestId('ready-cta').click()
  await page.getByTestId('first-lead-person').first().waitFor({ timeout: 30000 })
  const cards = page.getByTestId('first-lead'); assert.equal(await cards.count(), 4)
  for (const e of EXPECT) {
    const line = cards.filter({ hasText: e.company }).getByTestId('first-lead-person')
    assert.match((await line.innerText()).replace(/\s+/g, ' ').trim(), e.text.source.startsWith('^No buyer') ? /^No buyer named yet · Find contact$/ : e.text, `first play: ${e.company}`)
    if (e.href) assert.equal(await line.locator('a').first().getAttribute('href'), e.href)
  }
  assert.equal(await fitsAt(page, '[data-testid=first-lead-person], [data-testid=first-lead-person] *'), 0, `first-play person lines fit at ${width}px`)
  if (shotDir) { await page.waitForTimeout(400); await page.getByTestId('first-customers').screenshot({ path: path.join(shotDir, `first-play-${tag}.png`) }) }
  await ctx.close()
}

try {
  await leadsPage(1280, 1000, 'desktop')
  await leadsPage(390, 844, 'mobile')
  await firstPlay(1440, 900, 'desktop')
  await firstPlay(390, 844, 'mobile')
  console.log('lead person UI check passed: Leads cards and first-play cards name the person (name · title · LinkedIn/source, with its basis) or say "No buyer named yet"; a former title is never named; lines fit at 390px')
} finally {
  await b.close(); srv.kill()
  setTimeout(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows may hold the db file a moment longer */ } }, 1500)
}
