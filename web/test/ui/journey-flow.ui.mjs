// Home journey transitions and the outcomes view, on the production build with every /api/* call stubbed (throwaway
// database, server under test/helpers/net-fence.ts; no scan, key check, email or spend). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/journey-flow.ui.mjs   (SHOTS=<dir> saves the screenshots)
// Proves (Instinct #305 review of e546dda):
//   1. editing only "You sell" sends every buyer constraint back exactly - ["London, UK"] stays one entry - and it reads
//      back unchanged after a refresh;
//   2. a running play on Home becomes its result without a page reload (same document), and its stepper has Stop, which
//      sends exactly one POST /api/scan/cancel for that play and settles into the cancelled state;
//   3. the outcomes view is reachable from Home and the nav, scoped to the play: opportunities, drafts, approved-unsent,
//      conversations needing the owner and exceptions; another play's draft or reply is never counted; a failed read
//      shows "?" (unknown), never 0; a stopped thread is not a conversation needing the owner; approved-but-unsent emails
//      show even with zero drafts; two replies in one thread count as one conversation.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-journey-flow-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const now = Math.floor(Date.now() / 1000)
const P = 'a'.repeat(24), OTHER = 'f'.repeat(24)
const BUYER = { summary: 'B2B SaaS companies, 10-50 staff', who: ['Founder, CEO'], industries: ['SaaS'], sizes: ['10-50 employees'], where: ['London, UK'], signals: ['Raised a seed round, last 90 days', 'Hiring sales'], exclude: ['Agencies, recruiters'] }
const job = o => ({ id: P, status: 'done', error: null, query: 'Seed-stage SaaS founders in London hiring sales', business_name: '', csv_domain: null, created_at: now - 600, finished_at: null, candidates: 3, verified: 2, needs_review: 1, dropped: 0, lead_count: 3, test_only: false, funded_by: null, ...o })
const lead = (id, company, o = {}) => ({ id, name: '', company, contact: `hello@${id[0]}.example`, signal: `${company} raised a seed round`, source_url: `https://news.example/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} raised a seed round`, event_date: '2026-10-12', date_status: 'verified', published_at: null, confidence: 90, review_reason: null, company_domain: `${id[0]}.example`, human_confirmed_at: null, fit: 4, intent: 4, action: 3, why: `${company} raised a seed round and is hiring its first sales lead.`, signals: null, icp_match: null, enrichments: [], events: [], ...o })
const LEADS = [lead('1'.repeat(24), 'Northwind Labs'), lead('2'.repeat(24), 'Kitebase', { contact: null }), lead('3'.repeat(24), 'Gramercy Ltd', { review_reason: 'identity_mismatch' })]
const MSGS = [
  { id: 'm1', lead_id: LEADS[0].id, to_email: 'hello@1.example', subject: 'Your seed round', status: 'draft', created_at: now, sent_at: null },
  { id: 'm2', lead_id: LEADS[1].id, to_email: 'ops@2.example', subject: 'Hiring sales?', status: 'approved', created_at: now, sent_at: null },
  { id: 'm3', lead_id: LEADS[0].id, to_email: 'ceo@1.example', subject: 'Intro', status: 'uncertain', created_at: now, sent_at: null },
]
const REPLIES = [
  { gmail_id: 'g1', thread_id: 't1', lead_id: LEADS[0].id, from_email: 'ceo@1.example', excerpt: 'Sounds interesting - can we talk Thursday?', classification: 'positive', received_at: now, company: 'Northwind Labs', lead_name: null, followups_sent: 0, stopped: null },
  // A second, earlier reply in the same thread as g1: one conversation, not two.
  { gmail_id: 'g1b', thread_id: 't1', lead_id: LEADS[0].id, from_email: 'ceo@1.example', excerpt: 'Thanks for reaching out.', classification: 'other', received_at: now - 3600, company: 'Northwind Labs', lead_name: null, followups_sent: 0, stopped: null },
  { gmail_id: 'g2', thread_id: 't2', lead_id: LEADS[1].id, from_email: 'ops@2.example', excerpt: 'Please remove me', classification: 'opt_out', received_at: now, company: 'Kitebase', lead_name: null, followups_sent: 0, stopped: 'opt_out' },
  { gmail_id: 'g3', thread_id: 't3', lead_id: '9'.repeat(24), from_email: 'x@other.example', excerpt: 'Another play', classification: 'positive', received_at: now, company: 'Other Co', lead_name: null, followups_sent: 0, stopped: null },
]
const b = await chromium.launch()
async function open(s, url = '/app', width = 1400, height = 1000) {
  const ctx = await b.newContext({ viewport: { width, height } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const writes = []
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (m !== 'GET') {
      writes.push({ m, p, body: JSON.parse(req.postData() || '{}') })
      if (p === '/api/settings/profile') { const body = JSON.parse(req.postData() || '{}'); s.profile = { ...s.profile, ...(body.sells !== undefined ? { sells: body.sells } : {}), ...(body.buyer ? { buyer: body.buyer } : {}) }; return json({ ok: true }) }
      if (p === '/api/scan/cancel') { s.job = job({ status: 'failed', error: 'cancelled', candidates: null, verified: null, needs_review: null, dropped: null, lead_count: 0 }); return json({ ok: true, note: 'Stop requested.' }) }
      return json({ error: 'not stubbed' }, 400)
    }
    if (p === '/api/settings/profile') return json(s.profile)
    if (p === '/api/scan/jobs') { s.jobPolls = (s.jobPolls ?? 0) + 1; if (s.finishAfter && s.jobPolls > s.finishAfter) s.job = job(); return json({ jobs: [s.job, job({ id: OTHER, query: 'Another play', created_at: now - 99999 })], totals: { searches: 2, finished: 1 } }) }
    if (p === '/api/scan/latest') return json({ query: s.job.query, icp: { ...BUYER, window_days: 90 }, icp_source: 'user' })
    if (p === '/api/leads') return u.searchParams.get('job_id') === P ? json({ leads: LEADS, hidden_count: 0 }) : json({ error: 'nope' }, 500)
    if (p === `/api/campaigns/${P}`) return s.campaignFails ? json({ error: 'boom' }, 500) : json({ job: s.job, leads: LEADS, messages: [...(s.msgs ?? MSGS), { id: 'x', lead_id: '8'.repeat(24), to_email: 'z@other.example', subject: 'Other play', status: 'draft', created_at: now, sent_at: null }] })
    if (p === '/api/outreach/inbox') return json({ available: true, consent_accepted: true, read_granted: true, account: 'me@x.example', rows: s.replies ?? REPLIES, booking_url: null })
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
  let docs = 0; page.on('request', r => { if (r.resourceType() === 'document') docs++ })
  await page.goto(base + url, { waitUntil: 'networkidle' })
  return { ctx, page, writes, docs: () => docs }
}
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
const stage = page => page.getByTestId('journey').getAttribute('data-stage')
try {
  // 1. Profile edit round-trip.
  {
    const s = { profile: { business_name: 'Acme', sells: 'Sales hiring software', website: 'https://acme.example', buyer: structuredClone(BUYER) }, job: job() }
    const { ctx, page, writes } = await open(s)
    const u = page.getByTestId('journey-understanding'); await u.waitFor({ timeout: 15000 })
    assert.match(await u.textContent(), /WhereLondon, UK/)
    await u.getByRole('button', { name: 'Edit' }).click()
    assert.equal(await u.getByLabel('Where').inputValue(), 'London, UK')
    await u.getByLabel('You sell').fill('Sales hiring software for seed-stage startups')
    await u.getByRole('button', { name: 'Save' }).click(); await u.getByRole('button', { name: 'Edit' }).waitFor()
    const saved = writes.filter(w => w.p === '/api/settings/profile')
    assert.equal(saved.length, 1)
    assert.deepEqual(saved[0].body.buyer, BUYER, 'every untouched constraint goes back exactly; "London, UK" is one entry')
    assert.equal(saved[0].body.sells, 'Sales hiring software for seed-stage startups')
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByTestId('journey-understanding').waitFor()
    const t = await page.getByTestId('journey-understanding').textContent()
    assert.match(t, /WhereLondon, UK/); assert.match(t, /SkipAgencies, recruiters/); assert.match(t, /You sellSales hiring software for seed-stage startups/)
    assert.deepEqual(s.profile.buyer, BUYER)
    await ctx.close()
  }
  // 2a. Running -> result, no reload.
  {
    const s = { profile: { sells: 'x', website: 'https://acme.example', buyer: BUYER }, job: job({ status: 'running' }), finishAfter: 2 }
    const { ctx, page, writes, docs } = await open(s)
    await page.getByTestId('journey').waitFor({ timeout: 15000 })
    assert.equal(await stage(page), 'running'); await page.getByTestId('scan-stepper').waitFor()
    assert.equal(await page.getByTestId('journey-stop').isVisible(), true, 'Stop on the running stepper')
    await shot(page, 'home-running')
    await page.waitForFunction(() => document.querySelector('[data-testid=journey]')?.getAttribute('data-stage') === 'useful', null, { timeout: 20000 })
    await page.getByTestId('journey-opportunity').first().waitFor()
    assert.equal(docs(), 1, 'no page reload: the same document')
    assert.equal(await page.getByTestId('journey-line').textContent(), '2 opportunities in this play.')
    assert.equal(await page.getByTestId('scan-stepper').count(), 0)
    assert.deepEqual(writes, [], 'watching a play writes nothing')
    await shot(page, 'home-result')
    // Polling stops once the play settled.
    const polls = s.jobPolls; await page.waitForTimeout(9000); assert.equal(s.jobPolls, polls, 'no more polling after the result')
    await ctx.close()
  }
  // 2b. Stop on the running stepper.
  {
    const s = { profile: { sells: 'x', website: 'https://acme.example', buyer: BUYER }, job: job({ status: 'running' }) }
    const { ctx, page, writes } = await open(s)
    await page.getByTestId('journey-stop').click()
    await page.waitForFunction(() => document.querySelector('[data-testid=journey]')?.getAttribute('data-stage') === 'failed', null, { timeout: 15000 })
    assert.deepEqual(writes.map(w => [w.m, w.p, w.body]), [['POST', '/api/scan/cancel', { job_id: P }]], 'exactly one cancel, for this play')
    assert.equal(await page.getByTestId('journey-line').textContent(), 'Cancelled')
    await shot(page, 'home-stopped')
    await ctx.close()
  }
  // 3. Outcomes view.
  {
    const s = { profile: { sells: 'x', website: 'https://acme.example', buyer: BUYER }, job: job() }
    const { ctx, page, writes } = await open(s)
    await page.getByTestId('journey-campaign').click()
    await page.waitForURL(`**/app/outcomes?job_id=${P}`)
    await page.getByTestId('outcomes-conversations').locator('a').first().waitFor({ timeout: 15000 })
    const tile = async t => (await page.getByTestId(t).locator('div').first().textContent()).trim()
    assert.deepEqual([await tile('tile-opportunities'), await tile('tile-drafts'), await tile('tile-conversations'), await tile('tile-exceptions')], ['2', '1', '1', '2'])
    assert.match(await page.getByTestId('outcomes-play').textContent(), /Seed-stage SaaS founders in London hiring sales/)
    const conv = await page.getByTestId('outcomes-conversations').textContent()
    assert.match(conv, /Northwind Labs.*can we talk Thursday/); assert.doesNotMatch(conv, /Thanks for reaching out/, 'two replies in one thread are one conversation (the newest)')
    assert.equal(await page.getByTestId('outcomes-conversations').locator('a').count(), 1); assert.doesNotMatch(conv, /Other Co|remove me/, 'not another play, not an opt-out')
    assert.doesNotMatch(await page.getByTestId('outcomes-drafts').textContent(), /other\.example/, 'another play\'s draft is not counted')
    assert.match(await page.getByTestId('outcomes-approved').textContent(), /^1 approved, not sent yet\./)
    const exc = await page.getByTestId('outcomes-exceptions').textContent()
    assert.match(exc, /ceo@1\.example may not have sent/); assert.match(exc, /Gramercy Ltd: needs your review/)
    for (const [name, href] of [['Audit trail', `/app/campaigns/${P}`], ['Pause sending', '/app/settings#autopilot']]) assert.equal(await page.getByTestId('outcomes-secondary').getByRole('link', { name }).getAttribute('href'), href)
    assert.equal(await page.locator('aside').getByRole('link', { name: 'Outcomes' }).getAttribute('href'), '/app/outcomes')
    assert.deepEqual(writes, [], 'the outcomes view writes nothing')
    await shot(page, 'outcomes-desktop')
    await ctx.close()
    // Nav entry (no job_id: the current play) and a failed campaign read shows unknown, not zero.
    const f = { ...s, campaignFails: true }
    const o2 = await open(f, '/app/outcomes')
    await o2.page.getByTestId('outcomes-tiles').waitFor({ timeout: 15000 })
    await o2.page.waitForLoadState('networkidle')
    assert.equal((await o2.page.getByTestId('tile-drafts').locator('div').first().textContent()).trim(), '?')
    assert.match(await o2.page.getByTestId('outcomes-drafts').textContent(), /Could not load this/)
    await o2.ctx.close()
    // Instinct #305 review of 45d6d06: a stopped thread is not a conversation that needs the owner, and approved-but-unsent
    // emails show even when there are no drafts.
    const z = { ...s, msgs: [{ ...MSGS[1] }], replies: [{ ...REPLIES[0], stopped: 'replied' }, { ...REPLIES[0], gmail_id: 'g4', thread_id: 't4', lead_id: LEADS[1].id, from_email: 'ops@2.example', company: 'Kitebase', excerpt: 'Who is this for?', classification: 'other', stopped: null }] }
    const o3 = await open(z, `/app/outcomes?job_id=${P}`)
    await o3.page.getByTestId('outcomes-conversations').locator('a').first().waitFor({ timeout: 15000 })
    const t3 = async t => (await o3.page.getByTestId(t).locator('div').first().textContent()).trim()
    assert.deepEqual([await t3('tile-drafts'), await t3('tile-conversations')], ['0', '1'])
    const conv3 = await o3.page.getByTestId('outcomes-conversations').textContent()
    assert.match(conv3, /Kitebase.*Who is this for\?/); assert.doesNotMatch(conv3, /Northwind Labs/, 'the stopped thread is not listed')
    const d3 = o3.page.getByTestId('outcomes-drafts')
    assert.doesNotMatch(await d3.textContent(), /No drafts waiting/, 'not shown as empty while an approved email waits')
    assert.match(await d3.textContent(), /ops@2\.example.*Approved, not sent yet/)
    assert.match(await o3.page.getByTestId('outcomes-approved').textContent(), /^1 approved, not sent yet\./)
    await shot(o3.page, 'outcomes-approved-stopped')
    await o3.ctx.close()
    const m = await open(s, `/app/outcomes?job_id=${P}`, 390, 844)
    await m.page.getByTestId('outcomes-conversations').locator('a').first().waitFor({ timeout: 15000 })
    await shot(m.page, 'outcomes-mobile')
    await m.ctx.close()
  }
  console.log('journey flow UI check passed: profile edit round-trips exactly (London, UK kept), running -> result without reload, Stop cancels this play once, outcomes view scoped and reachable, unknown never shown as 0')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
