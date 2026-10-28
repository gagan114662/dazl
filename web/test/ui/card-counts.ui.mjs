// Rendered check for the Leads cards' count bar and date line. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/card-counts.ui.mjs   (SHOTS=<dir> saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, and EVERY /api/* CALL ANSWERED
// FROM A STUB in the browser: no draft is really created, nothing is sent. It proves:
//   1. a full card shows company, contact, one line of why, "source · claimed event date 1 Oct 2026", Approve and Reject;
//   2. a card with no contact says "No contact found yet"; an undated lead says "No dated source" (a published-only lead
//      says "published ..., event date unknown"), never an invented date;
//   3. the tabs read Approved / Rejected / To review from this scan's complete campaign record (a draft older than the
//      newest 200 Outreach emails still counts as approved), says it excludes Needs your review, and
//      follows Approve (one POST /api/outreach), Reject (one quarantine POST) and Undo (one DELETE);
//   4. if this scan's emails cannot be read, Approved and To review show "?" with the reason, never a guess.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-cardcounts-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const JOB = 'b'.repeat(24), FULL = 'a'.repeat(24), NOCONTACT = 'c'.repeat(24), PUBONLY = 'd'.repeat(24), DRAFTED = 'e'.repeat(24)
const ICP = { summary: 'Growing dental practices', who: ['Practice owner'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['new location'], exclude: [] }
const lead = (id, company, over = {}) => ({ id, name: '', company, contact: null, signal: `${company} opened a second office`, source_url: `https://www.news.example/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} opened a second office`, event_date: '2026-10-01', date_status: 'unverified', published_at: null, confidence: 80, review_reason: null, company_domain: null, human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 3, action: 3, why: `${company} matches your dental owner profile. More detail follows.`, signals: null, icp_match: null, enrichments: [], events: [], ...over })
const LEADS = [
  lead(FULL, 'Bright Dental', { contact: 'hello@brightdental.example' }),
  lead(NOCONTACT, 'Lakeside Smiles', { event_date: null }),
  lead(PUBONLY, 'Maple Dental', { event_date: null, published_at: '2026-10-03', contact: 'hi@maple.example' }),
  lead(DRAFTED, 'Grove Dental', { contact: 'hello@grove.example' }),
  // Seen in an earlier scan and hidden by default: not a card, so not counted; the label says so.
  lead('f'.repeat(24), 'Seen Dental', { contact: 'hi@seen.example', seen_before: 1 }),
]
const msg = lead_id => ({ id: lead_id.slice(0, 6) + 'm', lead_id, to_email: 'x@example.test', subject: 'Hi', body: 'Hi', status: 'draft', error: null, created_at: 1, sent_at: null, test: 0, evidence_state: 'machine', currentness_held: false, provenance: null, send_footer: null })
const state = { msgs: [msg(DRAFTED)], outreachFail: false }
const writes = []
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
  if (u.origin !== base) return route.abort()
  if (!p.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (m !== 'GET') writes.push(`${m} ${p}`)
  if (p === '/api/scan/status') return json({ job_id: JOB, status: 'done', lead_count: LEADS.length, icp: ICP, icp_source: 'user', attempts: 1, max_attempts: 3, query: 'Dental practice owners in Ohio opening a new location', enrichment: { state: 'none' } })
  if (p === '/api/leads' && m === 'GET') return json({ job_id: JOB, status: 'done', hidden_count: 0, leads: LEADS })
  if (p === '/api/scan/jobs') return json({ jobs: [] })
  // The account-wide list is capped at the newest 200: here it is full of other scans' emails, and this scan's older
  // draft (Grove) is not in it. The page must not read it; this scan's campaign record has every email of the scan.
  if (p === '/api/outreach' && m === 'GET') return json({ messages: Array.from({ length: 200 }, (_, k) => ({ ...msg('9'.repeat(24)), id: `n${k}` })) })
  if (p === `/api/campaigns/${JOB}`) return state.outreachFail ? json({ error: 'unavailable' }, 503) : json({ job: { id: JOB }, leads: [], messages: state.msgs })
  if (p === '/api/outreach' && m === 'POST') { const { lead_id } = JSON.parse(req.postData()); state.msgs.push(msg(lead_id)); return json({ ok: true, message_id: 'm' }) }
  if (/^\/api\/leads\/[a-f0-9]{24}\/quarantine$/.test(p)) return json({ quarantined: m === 'POST' })
  return json({}, 404)
})
const page = await ctx.newPage()
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
const card = company => page.getByTestId('lead-card').filter({ hasText: company })
// The counts sit on the To review / Approved / Rejected tabs; read back in the old bar's order.
const counts = async () => { const n = async t => (await page.getByTestId(`tab-${t}`).textContent()).trim().split(' ').pop(); return `Approved ${await n('approved')} · Rejected ${await n('rejected')} · To review ${await n('review')}` }
try {
  await page.goto(`${base}/app/leads?job_id=${JOB}&passive=1`, { waitUntil: 'networkidle' })
  await card('Bright Dental').waitFor({ timeout: 15000 })
  // 1. Full card.
  const full = await card('Bright Dental').textContent()
  assert.match(full, /hello@brightdental\.example/)
  assert.match(full, /Bright Dental matches your dental owner profile\./)
  assert.doesNotMatch(full, /More detail follows/, 'one line of why')
  assert.match(full, /news\.example · claimed event date 1 Oct 2026/)
  for (const n of ['Approve', 'Reject']) await card('Bright Dental').getByRole('button', { name: n }).waitFor()
  // 2. No contact, no dated source; published-only.
  const none = await card('Lakeside Smiles').textContent()
  assert.match(none, /No contact found yet/)
  assert.match(none, /news\.example · No dated source/)
  assert.doesNotMatch(none, /claimed event date|\d{4}-\d{2}-\d{2}/, 'no invented date')
  assert.match(await card('Maple Dental').textContent(), /news\.example · published 3 Oct 2026, event date unknown/)
  // 3. Counts from real state: Grove already has a draft in Outreach.
  await page.getByTestId('lead-tabs').waitFor()
  await page.waitForFunction(() => /Approved 1/.test(document.querySelector('[data-testid=tab-approved]')?.textContent ?? ''))
  assert.equal(await counts(), 'Approved 1 · Rejected 0 · To review 3', "Instinct #285: Grove's draft is older than the newest 200 emails and still counts")
  assert.equal(await page.getByTestId('card-counts-scope').textContent(), 'Cards below, not counting Needs your review or hidden already-seen leads. ')
  assert.match(await page.getByTestId('card-counts-note').textContent(), /Approving a card makes a draft; each email is still approved in Outreach before it sends/, 'a card approval is never presented as an approved email')
  await shot('counts-initial')
  await card('Bright Dental').getByRole('button', { name: 'Approve' }).click()
  await page.getByTestId('card-result').getByText(/Bright Dental: draft created/).waitFor()
  await page.waitForFunction(() => /Approved 2/.test(document.querySelector('[data-testid=tab-approved]')?.textContent ?? ''))
  assert.equal(await counts(), 'Approved 2 · Rejected 0 · To review 2')
  await card('Lakeside Smiles').getByRole('button', { name: 'Reject' }).click()
  await card('Lakeside Smiles').getByRole('button', { name: 'Confirm reject' }).click()
  await page.getByTestId('card-result').getByRole('button', { name: 'Undo' }).waitFor()
  assert.equal(await counts(), 'Approved 2 · Rejected 1 · To review 1')
  await shot('counts-after')
  await page.getByTestId('card-result').getByRole('button', { name: 'Undo' }).click()
  await card('Lakeside Smiles').getByRole('button', { name: 'Reject' }).waitFor()
  assert.equal(await counts(), 'Approved 2 · Rejected 0 · To review 2')
  assert.deepEqual(writes, ['POST /api/outreach', `POST /api/leads/${'c'.repeat(24)}/quarantine`, `DELETE /api/leads/${'c'.repeat(24)}/quarantine`], 'only the approve, reject and undo writes')
  // 4. Emails unreadable: Approved is unknown, not guessed.
  state.outreachFail = true
  await page.reload({ waitUntil: 'networkidle' })
  await card('Bright Dental').waitFor({ timeout: 15000 })
  assert.equal(await counts(), 'Approved ? · Rejected 0 · To review ?')
  assert.equal(await page.getByTestId('card-counts-note').textContent(), 'Drafts could not be loaded, so Approved is unknown.')
  console.log('card counts UI check passed: full and no-contact cards, "No dated source", published-only date, Approved/Rejected/To review follow approve, reject and undo; unknown when drafts cannot load')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
