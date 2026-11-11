// #1036: "Find work email" on a lead's buyer. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/work-email.ui.mjs   (SHOTS=<dir> saves desktop + mobile screenshots)
// Production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed in the browser
// (invented company and people): no site is fetched, no provider is called, nothing is charged or sent. It proves:
//   1. the lead's Details show "Work email for the buyer" with a Find work email button for each buyer-role person
//      (practice manager, owner) and none for a former title or a non-buyer title, plus the cost line;
//   2. clicking it shows a CHECKED address only for a verified answer (green, "verified", provider + date, Copy button),
//      an unchecked one as "not checked" (amber, no Copy), and "No work email found" with its reason;
//   3. a lead whose website is not settled shows no button; the rows fit at 390px.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-workemail-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), email_verified_at INTEGER); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt,email_verified_at) VALUES ('u1','s@example.test','x','y',1)").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const fence = pathToFileURL(path.join(dir, 'test/helpers/net-fence.ts')).href
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${fence}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const J = 'f'.repeat(24), L1 = '1'.repeat(24), L2 = '2'.repeat(24)
const ICP = { summary: 'NYC dental practices', who: ['Practice manager', 'Owner'], industries: ['Dental'], where: ['New York, NY'], sizes: [], signals: ['Hiring front desk'], exclude: [] }
const e = (connector, kind, value, url, label = null) => ({ connector, kind, value, label, source_url: url, source_date: '2026-11-08', confidence: 70, retrieved_at: Math.floor(Date.now() / 1000) - 3600 })
const domainRow = site => e('sitecrawl', 'domain', `${site}|evidence_own_domain`, `https://${site}/`, 'domain-basis-v1:evidence_own_domain')
const lead = (id, company, site, enrichments) => ({ id, name: '', company, contact: null, signal: `${company} is hiring a front desk coordinator`, source_url: `https://${site}/careers`, score: 70, evidence_excerpt: `${company} is hiring a front desk coordinator`, event_date: '2026-11-02', date_status: 'verified', published_at: null, confidence: 90, review_reason: null, company_domain: site, human_confirmed_at: null, human_confirmed_from: null, fit: 5, intent: 4, action: 3, why: 'Hiring front desk staff this month.', signals: null, icp_match: null, enrichments, events: [] })
const LEADS = [
  lead(L1, 'Harbor Dental', 'harbordental.example', [domainRow('harbordental.example'),
    e('enrich:apollo', 'contact', 'Dana Lee - Practice Manager', 'https://www.linkedin.com/in/dana-lee-invented', 'Apollo record updated 2026-11-01'),
    e('sitecrawl', 'person', 'Owen Park, Owner', 'https://harbordental.example/team'),
    e('enrich:apollo', 'contact', 'Rita Ross - Office Coordinator', 'https://www.linkedin.com/in/rita-invented'),
    e('enrich:apollo', 'contact', 'Fay Former - Former Practice Manager', 'https://www.linkedin.com/in/fay-invented')]),
  lead(L2, 'Bayside Smiles', 'baysidesmiles.example', [e('search:people', 'person', 'Ivy Chen, Owner', 'https://www.linkedin.com/in/ivy-chen-invented')]),
]
const NOW = Math.floor(Date.now() / 1000)
const ANSWERS = {
  'Dana Lee|Practice Manager': { status: 'verified', lookup: { target: 'Dana Lee|Practice Manager', status: 'verified', provider: 'apollo', address: 'dana.lee@harbordental.example', detail: 'Apollo verified', source_url: null, checked_at: NOW, updated_at: NOW }, replayed: false },
  'Owen Park|Owner': { status: 'unverified', lookup: { target: 'Owen Park|Owner', status: 'unverified', provider: 'pdl', address: 'owen@harbordental.example', detail: 'Apollo had no match; People Data Labs has it; PDL does not check mailboxes', source_url: null, checked_at: null, updated_at: NOW }, replayed: false },
}

const b = await chromium.launch()
const shotDir = process.env.SHOTS
async function context(width, height, answers) {
  const ctx = await b.newContext({ viewport: { width, height } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const st = { posts: [] }
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const we = /^\/api\/leads\/([a-f0-9]{24})\/work-email$/.exec(p)
    if (we && m === 'GET') return json({ providers: { apollo: true, pdl: true, pdlNeedsOptIn: false }, lookups: [] })
    if (we && m === 'POST') { const t = JSON.parse(req.postData()).target; st.posts.push(`${we[1]}:${t}`); return json(answers[t] ?? { status: 'not_found', lookup: { target: t, status: 'not_found', provider: null, address: null, detail: 'Apollo had no match; People Data Labs had no match', source_url: null, checked_at: null, updated_at: NOW }, replayed: false }) }
    if (p === '/api/scan/status') return json({ job_id: J, status: 'done', lead_count: 2, icp: ICP, icp_source: 'user', attempts: 1, max_attempts: 3, query: 'NYC dental practices hiring front desk' })
    if (p === '/api/leads') return json({ job_id: J, status: 'done', hidden_count: 0, leads: LEADS })
    if (p === '/api/scan/jobs') return json({ jobs: [] })
    if (p === '/api/usage') return json({ plan: 'free', scans_used: 0, scan_limit: 10, has_key: true, trial: null })
    if (p === '/api/enrich/held') return json({ held: [] })
    return json({}, 404)
  })
  return { ctx, st }
}
const fitsAt = async (page, sel) => page.evaluate(s => [...document.querySelectorAll(s)].filter(n => n.getBoundingClientRect().right > window.innerWidth + 0.5).length, sel)

async function run(width, height, tag) {
  const { ctx, st } = await context(width, height, ANSWERS); const page = await ctx.newPage()
  await page.goto(`${base}/app/leads?job_id=${J}&passive=1`, { waitUntil: 'networkidle' })
  const cards = page.getByTestId('lead-card'); await cards.first().waitFor({ timeout: 20000 })
  const harbor = page.locator('div:has(> [data-testid=lead-card])').filter({ hasText: 'Harbor Dental' })
  await harbor.getByText('Details', { exact: true }).click()
  const box = harbor.getByTestId('work-email'); await box.waitFor({ timeout: 10000 })
  const rows = box.getByTestId('work-email-row')
  assert.equal(await rows.count(), 2, 'practice manager and owner only: no button for a former title or a non-buyer title')
  assert.match(await box.innerText(), /Dana Lee[\s\S]*Owen Park/)
  assert.doesNotMatch(await box.innerText(), /Fay Former|Rita Ross/)
  assert.match(await box.getByTestId('work-email-cost').innerText(), /up to 1 credit on your Apollo key, then, only if Apollo has none, 1 People Data Labs credit, only on a match\. US contacts only\./)
  if (shotDir) await box.screenshot({ path: path.join(shotDir, `work-email-before-${tag}.png`) })
  for (const r of [0, 1]) await rows.nth(r).getByTestId('work-email-find').click()
  await rows.nth(0).getByTestId('work-email-address').waitFor()
  await rows.nth(1).getByTestId('work-email-address').waitFor()
  const dana = rows.nth(0), owen = rows.nth(1)
  assert.equal(await dana.getAttribute('data-status'), 'verified')
  assert.equal(await dana.getByTestId('work-email-address').getAttribute('data-checked'), 'true')
  assert.match(await dana.innerText(), /dana\.lee@harbordental\.example\s*verified[\s\S]*Checked work email\. Verified by Apollo on \d{4}-\d{2}-\d{2}/i)
  assert.equal(await dana.getByRole('button', { name: 'Copy' }).count(), 1)
  assert.equal(await owen.getAttribute('data-status'), 'unverified')
  assert.equal(await owen.getByTestId('work-email-address').getAttribute('data-checked'), 'false')
  assert.match(await owen.innerText(), /owen@harbordental\.example\s*not checked[\s\S]*Found, not checked\./i)
  assert.equal(await owen.getByRole('button', { name: 'Copy' }).count(), 0, 'an unchecked address gets no Copy shortcut')
  assert.equal(await fitsAt(page, '[data-testid=work-email], [data-testid=work-email] *'), 0, `work email rows fit at ${width}px`)
  if (shotDir) await box.screenshot({ path: path.join(shotDir, `work-email-after-${tag}.png`) })
  // The other lead's site is not settled (no confirmed website row): no Find work email anywhere on it.
  const bay = page.locator('div:has(> [data-testid=lead-card])').filter({ hasText: 'Bayside Smiles' })
  await bay.getByText('Details', { exact: true }).click()
  assert.equal(await bay.getByTestId('work-email').count(), 0)
  assert.deepEqual(st.posts.sort(), [`${L1}:Dana Lee|Practice Manager`, `${L1}:Owen Park|Owner`])
  await ctx.close()
}

try {
  await run(1280, 1000, 'desktop')
  await run(390, 844, 'mobile')
  console.log('work email UI check passed: Find work email only for buyer-role people on a settled site; verified shows as checked with provider and date, unchecked is labelled not checked; rows fit at 390px')
} finally {
  await b.close(); srv.kill()
  setTimeout(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows may hold the db file a moment longer */ } }, 1500)
}
