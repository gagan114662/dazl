// Before/after screenshots for the visual redesign: Home, Plays (Leads with no scan open), a scan's lead cards and a
// running scan's progress, at 1400px and at phone width. NOT part of `npm test`; it asserts only that each screen
// renders without the error screen. Run:  cd web && npm run build && SHOTS=<dir> node test/ui/redesign-shots.ui.mjs
// Real production build, throwaway database, server under test/helpers/net-fence.ts, every /api/* call stubbed.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-redesign-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const JOB = 'b'.repeat(24), RUN = 'c'.repeat(24)
const now = Math.floor(Date.now() / 1000)
const ICP = { summary: 'Independent dental practices with 2-10 chairs that are growing', who: ['Practice owners', 'Office managers'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['Opened a new location', 'Hiring front-desk staff'], exclude: [] }
const PROFILE = { business_name: 'Brightsmile', sells: 'We sell appointment booking software.', website: 'https://brightsmile.example', buyer: ICP }
const job = (id, query, created_at, o = {}) => ({ id, status: 'done', error: null, query, business_name: '', csv_domain: null, created_at, finished_at: created_at + 300, candidates: 9, verified: 4, needs_review: 1, dropped: 4, lead_count: 5, test_only: false, funded_by: null, ...o })
const JOBS = [
  job(JOB, 'Dental practice owners in Ohio - opened a new location', now - 86400),
  job('d'.repeat(24), 'Office managers in Ohio - hiring front-desk staff', now - 3 * 86400, { candidates: 6, verified: 0, needs_review: 0, dropped: 6, lead_count: 0 }),
  job('e'.repeat(24), 'Orthodontists in Columbus - switched practice software', now - 6 * 86400, { status: 'failed', error: 'no_candidates', candidates: 0, verified: null, needs_review: null, dropped: null, lead_count: 0 }),
]
const lead = (id, company, o = {}) => ({ id, name: '', company, contact: null, signal: `${company} opened a second office`, source_url: `https://www.daytondailynews.example/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} opened a second office`, event_date: '2026-10-12', date_status: 'unverified', published_at: null, confidence: 80, review_reason: null, company_domain: null, human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 3, action: 3, why: `${company} just opened a second Ohio office and is hiring front-desk staff.`, signals: null, icp_match: null, enrichments: [], events: [], ...o })
const LEADS = [
  lead('1'.repeat(24), 'Bright Dental', { contact: 'hello@brightdental.example', company_domain: 'brightdental.example', enrichments: [{ connector: 'sitecrawl', kind: 'person', value: 'Dana Smith, Practice owner', label: null, source_url: 'https://brightdental.example/team', source_date: '2026-10-20', confidence: null }] }),
  lead('2'.repeat(24), 'Lakeside Smiles', { event_date: null }),
  lead('3'.repeat(24), 'Maple Family Dentistry', { contact: 'office@mapledental.example', company_domain: 'mapledental.example' }),
  lead('4'.repeat(24), 'Grove Orthodontics', { contact: 'hi@groveortho.example', quarantined_at: now - 60, quarantine_reason: 'Rejected: Not a fit' }),
]
const b = await chromium.launch()
async function shots(width, height, tag) {
  const ctx = await b.newContext({ viewport: { width, height } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  let polls = 0
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (m !== 'GET') return json({ ok: true })
    if (p === '/api/settings/profile') return json(PROFILE)
    if (p === '/api/usage') return json({ plan: 'free', scans_used: 3, scan_limit: 10, has_key: true, trial: null })
    if (p === '/api/settings/llm-key') return json({ keys: [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1 }], rejection: null })
    if (p === '/api/settings/advanced') return json({ available: true, version: '1', platforms: [{ platform: 'linkedin', allowed: true, consent: false, connected: false, enabled: false }] })
    if (p === '/api/scan/sources') return json({ web_index: false, news: true, websites: true })
    if (p === '/api/scan/jobs') return json({ jobs: JOBS, totals: { searches: 3, finished: 2 } })
    if (p === '/api/scan/latest') return json({ query: JOBS[0].query, icp: ICP, icp_source: 'user' })
    if (p === '/api/outreach/settings') return json({ gmail: null, sender: { sender_name: 'Dana', postal_address: '1 Main St, Columbus OH' }, daily_cap: 20, sent_24h: 0, account_sent_24h: 0 })
    if (p === '/api/outreach') return json({ messages: [{ id: 'm1', lead_id: '1'.repeat(24), status: 'draft' }] })
    if (p === '/api/campaigns') return json({ campaigns: [{ id: JOB, qualification: { rejected: 1 }, outreach: { drafts: 1, approved: 0, sent: 0 } }] })
    if (p === `/api/campaigns/${JOB}`) return json({ job: { id: JOB }, leads: [], messages: [{ id: 'm1', lead_id: '1'.repeat(24), status: 'draft' }] })
    if (p === '/api/scan/status') {
      const id = u.searchParams.get('job_id')
      if (id === RUN) { polls++; return json({ job_id: RUN, status: 'running', created_at: now - 120, claimed_at: now - 90, attempts: 1, max_attempts: 3, lead_count: 2, quality: null, error: null, icp: ICP, icp_source: 'user', query: JOBS[0].query, enrichment: { state: 'none' } }) }
      return json({ job_id: JOB, status: 'done', created_at: now - 86400, claimed_at: now - 86400, attempts: 1, max_attempts: 3, lead_count: LEADS.length, quality: { candidates: 9, passed: 4, needs_review: 1, dropped: 4, drop_reasons: { stale: 3, no_quote: 1 } }, error: null, icp: ICP, icp_source: 'user', query: JOBS[0].query, enrichment: { state: 'finished' } })
    }
    if (p === '/api/leads') return json({ job_id: u.searchParams.get('job_id'), status: 'done', hidden_count: 0, leads: u.searchParams.get('job_id') === RUN ? [] : LEADS })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  const go = async (name, url, ready) => {
    await page.goto(base + url, { waitUntil: 'networkidle' }); await ready(); await page.waitForTimeout(500)
    assert.equal(await page.getByText('This page could not be shown').count(), 0, `${name}: app error screen`)
    await page.screenshot({ path: path.join(process.env.SHOTS, `${name}-${tag}.png`), fullPage: true })
  }
  await go('home', '/app', () => page.getByText('Your plays').first().waitFor({ timeout: 15000 }))
  await go('plays', '/app/leads', () => page.getByLabel('Who do you want to reach').first().waitFor({ timeout: 15000 }))
  await go('lead-cards', `/app/leads?job_id=${JOB}&passive=1`, () => page.getByTestId('lead-card').first().waitFor({ timeout: 15000 }))
  await go('scan-progress', `/app/leads?job_id=${RUN}&passive=1`, () => page.getByText(/Scanning|Searching|Reading/).first().waitFor({ timeout: 15000 }))
  await ctx.close()
}
try {
  assert.ok(process.env.SHOTS, 'set SHOTS=<dir>')
  await shots(1400, 900, 'desktop')
  await shots(390, 844, 'mobile')
  console.log('redesign screenshots taken: home, plays, lead-cards, scan-progress at 1400px and 390px')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
