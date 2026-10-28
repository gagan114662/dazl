// Home journey state map, rendered on the production build with every /api/* call stubbed (throwaway database, server
// under test/helpers/net-fence.ts; no scan, key check, email or spend). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/journey-states.ui.mjs   (SHOTS=<dir> saves desktop and mobile pixels)
// States: new, returning incomplete, running, failed source, zero extracted, all held, useful, campaign record error.
// Proves: wrong-company, undated and out-of-window leads never enter the preview or its count; drafts come from the
// same campaign only (unknown on error, never borrowed); profile edits persist through a refresh; Home writes nothing else.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-journey-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const now = Math.floor(Date.now() / 1000)
const P = 'a'.repeat(24)
const BUYER = { summary: 'Independent dental practices with 2-10 chairs', who: ['Practice owner'], industries: ['Dental'], sizes: ['2-10 chairs'], where: ['Ohio'], signals: ['Opened a new location'], exclude: ['Dental schools', 'chains'] }
const PLAY_ICP = { ...BUYER, window_days: 90 }
const job = o => ({ id: P, status: 'done', error: null, query: 'Dental practice owners in Ohio - opened a new location', business_name: '', csv_domain: null, created_at: now - 3600, finished_at: now - 3000, candidates: 4, verified: 2, needs_review: 1, dropped: 1, lead_count: 4, test_only: false, funded_by: null, ...o })
const lead = (id, company, o = {}) => ({ id, name: '', company, contact: `hello@${id[0]}.example`, signal: `${company} opened a second office`, source_url: `https://news.example/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} opened a second office`, event_date: '2026-10-12', date_status: 'verified', published_at: null, confidence: 90, review_reason: null, company_domain: `${id[0]}.example`, human_confirmed_at: null, fit: 4, intent: 4, action: 3, why: `${company} just opened a second Ohio office.`, signals: null, icp_match: null, enrichments: [], events: [], ...o })
const GOOD = lead('1'.repeat(24), 'Bright Dental')
const NO_CONTACT = lead('2'.repeat(24), 'Maple Family Dentistry', { contact: null })
const WRONG_CO = lead('3'.repeat(24), 'Gramercy Dental Practice', { review_reason: 'identity_mismatch' })
const UNDATED = lead('4'.repeat(24), 'Lakeside Smiles', { event_date: null, date_status: 'undated' })
const OUT_OF_WINDOW = lead('5'.repeat(24), 'Old Town Dental', { window_held: true })
const PROFILE = { business_name: 'Brightsmile', sells: 'Appointment booking software', website: 'https://brightsmile.example', buyer: BUYER }

// Each state: what the stubbed account returns, and what Home must show.
const STATES = {
  'new': { profile: { business_name: '', sells: '', website: '', buyer: null }, jobs: [] },
  'returning-incomplete': { profile: PROFILE, jobs: [] },
  'running': { profile: PROFILE, jobs: [job({ status: 'running', finished_at: null })] },
  'failed-source': { profile: PROFILE, jobs: [job({ status: 'failed', error: 'key_rejected', candidates: null, verified: null, needs_review: null, dropped: null, lead_count: 0 })] },
  'zero-extracted': { profile: PROFILE, jobs: [job({ status: 'failed', error: 'no_candidates', candidates: 0, verified: null, needs_review: null, dropped: null, lead_count: 0 })] },
  'all-held': { profile: PROFILE, jobs: [job()], leads: [WRONG_CO, UNDATED, OUT_OF_WINDOW] },
  'useful': { profile: PROFILE, jobs: [job()], leads: [GOOD, NO_CONTACT, WRONG_CO, UNDATED, OUT_OF_WINDOW], messages: [{ lead_id: GOOD.id, status: 'draft' }, { lead_id: NO_CONTACT.id, status: 'approved' }] },
  'useful-campaign-error': { profile: PROFILE, jobs: [job()], leads: [GOOD], campaignFails: true },
}
const b = await chromium.launch()
async function open(s, width = 1400, height = 1000) {
  const ctx = await b.newContext({ viewport: { width, height } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const writes = []
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (m !== 'GET') {
      writes.push(`${m} ${p}`)
      if (p === '/api/settings/profile') { const body = JSON.parse(req.postData() || '{}'); s.profile = { ...s.profile, ...(body.sells !== undefined ? { sells: body.sells } : {}), ...(body.buyer ? { buyer: body.buyer } : {}) }; s.saved = body; return json({ ok: true }) }
      return json({ error: 'not stubbed' }, 400)
    }
    if (p === '/api/settings/profile') return json(s.profile)
    if (p === '/api/scan/jobs') return json({ jobs: s.jobs, totals: { searches: s.jobs.length, finished: s.jobs.filter(j => j.status !== 'running').length } })
    if (p === '/api/scan/latest') return json(s.jobs.length ? { query: s.jobs[0].query, icp: PLAY_ICP, icp_source: 'user' } : { query: null, icp: null, icp_source: null })
    if (p === '/api/leads') return u.searchParams.get('job_id') === P && s.leads ? json({ leads: s.leads, hidden_count: 0 }) : json({ error: 'nope' }, 500)
    if (p === `/api/campaigns/${P}`) return s.campaignFails ? json({ error: 'boom' }, 500) : json({ job: s.jobs[0], leads: s.leads ?? [], messages: s.messages ?? [] })
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
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  return { ctx, page, writes }
}
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
const stageOf = page => page.getByTestId('journey').getAttribute('data-stage')
try {
  for (const [name, s0] of Object.entries(STATES)) {
    for (const [w, h, tag] of [[1400, 1000, 'desktop'], [390, 844, 'mobile']]) {
      const s = structuredClone(s0)
      const { ctx, page, writes } = await open(s, w, h)
      await page.locator('main h1').waitFor()
      if (name === 'new') {
        // New account: the website-first steps, no checklist, no journey yet.
        await page.getByRole('heading', { name: "What's your website?" }).waitFor()
        assert.equal(await page.getByTestId('readiness-checklist').count(), 0)
      } else {
        await page.getByTestId('journey').waitFor()
        await page.waitForFunction(() => document.querySelector('[data-testid=journey]')?.getAttribute('data-stage') !== null)
        await page.waitForLoadState('networkidle')
        const stage = await stageOf(page)
        const action = page.getByTestId('journey-action')
        const actionText = await action.count() ? (await action.textContent()).trim() : null
        const href = await action.count() ? await action.getAttribute('href') : null
        const preview = page.getByTestId('journey-opportunity')
        // Setup machinery is secondary: collapsed, never the first thing; no sending setup is forced before a preview.
        assert.equal(await page.getByTestId('setup-details').evaluate(d => d.open), false, `${name}: setup details collapsed`)
        assert.equal(await page.getByTestId('readiness-checklist').isVisible().catch(() => false), false, `${name}: checklist not on screen`)
        assert.equal(await page.locator('main a.btn-primary:visible, main button.btn-primary:visible').count(), 1, `${name}: one primary action`)
        if (name === 'returning-incomplete') { assert.equal(stage, 'no_play'); assert.deepEqual([actionText, href], ['Find your first leads', '/app/leads']) }
        if (name === 'running') { assert.equal(stage, 'running'); assert.equal(href, `/app/leads?job_id=${P}`); await page.getByTestId('scan-stepper').waitFor(); assert.doesNotMatch(await page.locator('main').textContent(), /No leads yet|0 opportunities/) }
        if (name === 'failed-source') { assert.equal(stage, 'failed'); assert.match(await page.getByTestId('journey-line').textContent(), /rejected the key/); assert.equal(href, '/app/settings') }
        if (name === 'zero-extracted') { assert.equal(stage, 'zero'); assert.equal(await page.getByTestId('journey-line').textContent(), 'This play found 0 companies.'); assert.equal(await preview.count(), 0) }
        if (name === 'all-held') {
          assert.equal(stage, 'all_held'); assert.equal(await preview.count(), 0, 'wrong-company, undated and out-of-window leads never enter the preview')
          assert.equal(await page.getByTestId('journey-line').textContent(), '0 opportunities. 3 leads need review.')
          assert.match(await page.getByTestId('journey-held').textContent(), /^3 held for review/)
        }
        if (name === 'useful') {
          assert.equal(stage, 'useful')
          assert.deepEqual((await preview.allTextContents()).map(t => t.match(/Bright Dental|Maple Family Dentistry|Gramercy|Lakeside|Old Town/)?.[0]), ['Bright Dental', 'Maple Family Dentistry'])
          assert.deepEqual(await page.getByTestId('journey-contact').allTextContents(), ['Contact ready', 'No published contact yet'])
          assert.equal(await page.getByTestId('journey-line').textContent(), '2 opportunities in this play.', 'held leads never inflate the count')
          assert.match(await page.getByTestId('journey-held').textContent(), /^3 held for review/)
          // Same campaign: the drafts action points at this play only; approved-unsent is reported apart from drafts.
          assert.deepEqual([actionText, href], ['Review 1 draft', `/app/outreach?job_id=${P}`])
          assert.equal(await page.getByTestId('journey-approved').textContent(), '1 approved, not sent yet')
          assert.equal(await page.getByTestId('journey-campaign').getAttribute('href'), `/app/outcomes?job_id=${P}`)
          // The play's reviewed constraints are shown exactly, window and exclusions included.
          const c = await page.getByTestId('journey-constraints').textContent()
          for (const t of ['Practice owner', 'Dental', 'in Ohio', '2-10 chairs', 'Opened a new location', 'past 90 days', 'skip Dental schools', 'skip chains']) assert.ok(c.includes(t), t)
        }
        if (name === 'useful-campaign-error') {
          // The campaign record failed: drafts are unknown, so nothing borrows another campaign; the action stays on this play's leads.
          assert.deepEqual([actionText, href], ['Review 1 opportunity', `/app/leads?job_id=${P}`])
          assert.equal(await page.getByTestId('journey-approved').count(), 0)
        }
        // Profile edits persist through a refresh, with every constraint sent back exactly.
        if (name === 'useful' && tag === 'desktop') {
          const u = page.getByTestId('journey-understanding')
          await u.getByRole('button', { name: 'Edit' }).click()
          await u.getByLabel('Where').fill('Ohio; Kentucky') // list fields are separated with ";"
          await u.getByRole('button', { name: 'Save' }).click()
          await u.getByRole('button', { name: 'Edit' }).waitFor()
          assert.deepEqual(s.saved.buyer, { ...BUYER, where: ['Ohio', 'Kentucky'] }, 'only the edited field changed; exclusions and sizes kept exactly')
          await page.reload({ waitUntil: 'networkidle' })
          await page.getByTestId('journey-understanding').waitFor()
          assert.match(await page.getByTestId('journey-understanding').textContent(), /WhereOhio; Kentucky/)
          assert.deepEqual(writes, ['POST /api/settings/profile'])
        } else assert.deepEqual(writes, [], `${name}: Home writes nothing`)
      }
      await shot(page, `${name}-${tag}`)
      await ctx.close()
    }
  }
  console.log('journey states UI check passed: new, returning incomplete, running, failed source, zero extracted, all held, useful, campaign error; preview gates, same-campaign scope, profile persistence')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
