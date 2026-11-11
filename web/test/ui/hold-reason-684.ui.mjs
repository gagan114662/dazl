// #684 rendered check: a held lead's shown hold reason fits its saved claim, on Leads and on Home, at 1280 and 390 px. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/hold-reason-684.ui.mjs   (SHOTS=<dir> saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed in the browser
// (synthetic leads, invented companies): nothing is confirmed, drafted or sent. Off-host requests are aborted. It proves:
//   1. Leads: a job-posting claim ("Hiring a front desk receptionist") stored with the customer-mention hold is NOT labelled
//      "someone else's customer" - its label and its Keep-as-research hint say it is not verified and stays out of drafting;
//   2. Leads: a real customer-mention claim keeps the customer label (nothing else changes);
//   3. Home: the same vacancy lead's research line names no customer relationship.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-hold-reason-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), email_verified_at INTEGER); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt,email_verified_at) VALUES ('u1','s@example.test','x','y',1)").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const now = Math.floor(Date.now() / 1000)
const P = 'c'.repeat(24)
const QUERY = 'NYC dental practices hiring front desk staff'
const BUYER = { summary: 'Independent dental practices in New York', who: ['Practice owner'], industries: ['Dental'], sizes: [], where: ['New York, NY'], signals: ['hiring front desk staff'], exclude: [] }
const PROFILE = { business_name: 'Brightsmile', sells: 'Appointment reminder software for dental practices', website: 'https://brightsmile.example', buyer: BUYER }
const job = { id: P, status: 'done', error: null, query: QUERY, business_name: '', csv_domain: null, created_at: now - 3600, finished_at: now - 3000, candidates: 2, verified: 0, needs_review: 2, dropped: 0, lead_count: 2, test_only: false, funded_by: null }
const lead = (id, company, o = {}) => ({ id, name: '', company, contact: null, signal: `${company} opened a second office`, source_url: `https://news.example/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} opened a second office`, event_date: null, date_status: 'undated', published_at: null, confidence: null, review_reason: null, company_domain: null, human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 3, action: 3, why: 'synthetic', icp_match: null, signal_kind: null, source_kind: null, enrichments: [], ...o })
// The audit shape (synthetic): a vacancy claim on a job board, stored before #684 with the customer-mention hold.
const VACANCY = lead('1'.repeat(24), 'Smile Dental Care', { signal: 'Hiring a front desk receptionist', evidence_excerpt: 'Smile Dental Care is hiring a front desk receptionist for its Brooklyn office', source_url: 'https://www.dentalpost.example/jobs/12345', review_reason: 'counterparty_signal' })
// A real customer mention: its customer reason applies and is still shown.
const CUSTOMER = lead('2'.repeat(24), 'Harbor Dental Studio', { signal: 'Harbor Dental Studio became a Weave customer', evidence_excerpt: 'Harbor Dental Studio switched to Weave for patient reminders', source_url: 'https://weave.example/customers/harbor', review_reason: 'counterparty_signal' })
const LEADS = [VACANCY, CUSTOMER]

const b = await chromium.launch()
async function open(url, width, height) {
  const ctx = await b.newContext({ viewport: { width, height } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const writes = []
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (m !== 'GET') { writes.push(`${m} ${p}`); return json({ error: 'not stubbed' }, 400) }
    if (p === '/api/settings/profile') return json(PROFILE)
    if (p === '/api/scan/jobs') return json({ jobs: [job], totals: { searches: 1, finished: 1 } })
    if (p === '/api/scan/latest') return json({ query: QUERY, icp: BUYER, icp_source: 'user' })
    if (p === '/api/scan/status') return json({ status: 'done', lead_count: 2, icp: BUYER, icp_source: 'user', attempts: 1, max_attempts: 3, query: QUERY })
    if (p === '/api/leads') return u.searchParams.get('job_id') === P ? json({ job_id: P, status: 'done', leads: LEADS, hidden_count: 0 }) : json({ error: 'nope' }, 404)
    if (p === `/api/campaigns/${P}`) return json({ job, leads: LEADS, messages: [] })
    if (p === '/api/usage') return json({ plan: 'free', scans_used: 1, scan_limit: 10, has_key: true, trial: null })
    if (p === '/api/settings/llm-key') return json({ keys: [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1 }], rejection: null })
    if (p === '/api/settings/advanced') return json({ available: true, version: '1', platforms: [] })
    if (p === '/api/scan/sources') return json({ web_index: false, news: true, websites: true })
    if (p === '/api/outreach/settings') return json({ gmail: null, sender: null, daily_cap: 20, sent_24h: 0, account_sent_24h: 0, read_notice: [] })
    if (p === '/api/outreach') return json({ messages: [] })
    if (p === '/api/campaigns') return json({ campaigns: [] })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}${url}`, { waitUntil: 'networkidle' })
  return { ctx, page, writes }
}
const CUSTOMER_LABEL = /someone else.s customer|another company.s page names it, as their customer|as their customer/i
try {
  for (const [w, h, tag] of [[1280, 1000, '1280'], [390, 844, '390']]) {
    // 1-2. Leads review rows.
    const { ctx, page, writes } = await open(`/app/leads?job_id=${P}&passive=1`, w, h)
    const actions = page.getByTestId('review-actions'); await actions.first().waitFor({ timeout: 20000 })
    const rowOf = company => page.locator('div.p-4.text-sm', { hasText: company }).filter({ has: page.getByTestId('review-actions') })
    const vac = (await rowOf('Smile Dental Care').innerText()).replace(/\s+/g, ' ')
    assert.match(vac, /Saved signal claim: Hiring a front desk receptionist/, vac)
    assert.doesNotMatch(vac, CUSTOMER_LABEL, `${tag}: the vacancy row names no customer relationship: ${vac}`)
    assert.match(vac, /Not verified - it was held by the check for another company's page, which does not apply to a job posting/, vac)
    assert.match(vac, /Keep as research/, vac)
    assert.match(vac, /evidence not verified, which checking the source cannot change, so it stays out of drafting/, vac)
    const cus = (await rowOf('Harbor Dental Studio').innerText()).replace(/\s+/g, ' ')
    assert.match(cus, /Names this company as someone else's customer/, cus)
    assert.match(cus, /only another company's page names it, as their customer/, cus)
    await rowOf('Smile Dental Care').scrollIntoViewIfNeeded()
    if (process.env.SHOTS) await rowOf('Smile Dental Care').screenshot({ path: path.join(process.env.SHOTS, `leads-vacancy-${tag}.png`) })
    if (process.env.SHOTS) await rowOf('Harbor Dental Studio').screenshot({ path: path.join(process.env.SHOTS, `leads-customer-${tag}.png`) })
    assert.deepEqual(writes, [], 'nothing written')
    await ctx.close()
    // 3. Home research line.
    const home = await open('/app', w, h)
    await home.page.getByTestId('journey').waitFor({ timeout: 20000 })
    await home.page.waitForFunction(() => document.querySelector('[data-testid=journey]')?.getAttribute('data-stage') !== null)
    await home.page.waitForLoadState('networkidle')
    await home.page.getByTestId('research-row').first().waitFor({ timeout: 20000 })
    const rows = (await home.page.getByTestId('research-row').allTextContents()).map(t => t.trim())
    const v = rows.find(r => r.startsWith('Smile Dental Care'))
    assert.ok(v, `Home lists the vacancy lead as research: ${JSON.stringify(rows)}`)
    assert.doesNotMatch(v, CUSTOMER_LABEL, `${tag}: Home names no customer relationship for the vacancy: ${v}`)
    assert.match(v, /^Smile Dental Care: evidence not verified\./, v)
    const c = rows.find(r => r.startsWith('Harbor Dental Studio'))
    assert.match(c ?? '', /only another company's page names it, as their customer/, c)
    if (process.env.SHOTS) await home.page.getByTestId('journey-results').screenshot({ path: path.join(process.env.SHOTS, `home-research-${tag}.png`) })
    assert.deepEqual(home.writes, [], 'nothing written')
    await home.ctx.close()
  }
  console.log('PASS hold-reason-684: Leads label + hint and Home research line fit each saved claim at 1280 and 390 px')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
