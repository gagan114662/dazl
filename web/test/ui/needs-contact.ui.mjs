// Rendered check for the "Needs contact" label on lead cards. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/needs-contact.ui.mjs   (SHOTS=<dir> saves screenshots)
// Real production build, throwaway database, every /api/* call answered from a stub in the browser. It proves:
//   1. a lead whose every contact was refused reads "Needs contact" with the refusal reason under it;
//   2. a lead that was never refused anything still reads "No contact found yet"; a lead with a contact shows the contact;
//   3. a refused lead that also has a kept contact shows the contact, not "Needs contact".
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-needscontact-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const JOB = 'b'.repeat(24)
const ICP = { summary: 'Growing dental practices', who: ['Practice owner'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['new location'], exclude: [] }
const lead = (id, company, over = {}) => ({ id, name: '', company, contact: null, signal: `${company} opened a second office`, source_url: `https://www.news.example/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} opened a second office`, event_date: '2026-10-01', date_status: 'unverified', published_at: null, confidence: 80, review_reason: null, company_domain: null, human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 3, action: 3, why: `${company} matches your dental owner profile. More detail follows.`, signals: null, icp_match: null, enrichments: [], events: [], ...over })
const REFUSED = '1'.repeat(24), NEVER = '2'.repeat(24), KEPT = '3'.repeat(24)
const row = (kind, value, label = null) => ({ connector: 'enrich:apollo', kind, value, label, confidence: null, source_url: 'https://invalid.example/', source_date: '2026-10-20' })
const LEADS = [
  lead(REFUSED, 'Smile Avenue Dental', { enrichments: [row('contact_rejected', 'contact rejected: location mismatch Pico Rivera, CA vs New York, NY', 'contact_location_mismatch')] }),
  lead(NEVER, 'Lakeside Smiles'),
  lead(KEPT, 'Grove Dental', { contact: 'hello@grove.example', enrichments: [row('contact_rejected', 'contact rejected: domain mismatch grove.io vs grove.example', 'contact_domain_mismatch')] }),
]
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const p = u.pathname
  if (u.origin !== base) return route.abort()
  if (!p.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (p === '/api/scan/status') return json({ job_id: JOB, status: 'done', lead_count: LEADS.length, icp: ICP, icp_source: 'user', attempts: 1, max_attempts: 3, query: 'Dental practice owners in New York opening a new location' })
  if (p === '/api/leads') return json({ job_id: JOB, status: 'done', hidden_count: 0, leads: LEADS })
  if (p === '/api/scan/jobs') return json({ jobs: [] })
  if (p === '/api/outreach') return json({ messages: [] })
  if (p === `/api/campaigns/${JOB}`) return json({ job: { id: JOB }, leads: [], messages: [] })
  return json({}, 404)
})
const page = await ctx.newPage()
const card = company => page.getByTestId('lead-card').filter({ hasText: company })
try {
  await page.goto(`${base}/app/leads?job_id=${JOB}&passive=1`, { waitUntil: 'networkidle' })
  await card('Smile Avenue Dental').waitFor({ timeout: 15000 })
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'needs-contact.png'), fullPage: true })
  const refused = await card('Smile Avenue Dental').locator('[data-needs-contact]').textContent()
  assert.match(refused, /Needs contact/); assert.match(refused, /location mismatch Pico Rivera, CA vs New York, NY/)
  assert.ok(!/contact rejected:/.test(refused), 'the "contact rejected:" prefix is not repeated')
  assert.equal(await card('Smile Avenue Dental').locator('text=No contact found yet').count(), 0)
  assert.match(await card('Lakeside Smiles').textContent(), /No contact found yet/); assert.equal(await card('Lakeside Smiles').locator('[data-needs-contact]').count(), 0)
  assert.match(await card('Grove Dental').textContent(), /hello@grove\.example/); assert.equal(await card('Grove Dental').locator('[data-needs-contact]').count(), 0)
  console.log('needs-contact UI check passed: refused -> "Needs contact" + reason; never refused -> "No contact found yet"; kept contact shown')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
