// Home with real-looking seeded data (Hermes for Gagan, after #305): the play as a card, results first, only what is
// set, folded constraints, and a designed zero state. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/home-play.ui.mjs   (SHOTS=<dir> saves desktop and mobile screenshots;
// BEFORE_ONLY=1 only takes them). Production build, throwaway database, server under test/helpers/net-fence.ts, EVERY
// /api/* call stubbed in the browser: no scan, no draft, nothing sent. It proves:
//   1. the headline is a short play name ("NYC dental practices expanding"), with the full request behind its (i), then
//      Who / Signal / Pace rows and a status chip from the weekly watch (Live, next run);
//   2. results come first: Leads ready / Held for review / Contacted from the play's own leads and campaign, then the
//      ready lead cards;
//   3. "What dazl understands" shows only what is set (no "Not set", "Any", "Nothing", "Anywhere") plus one nudge;
//   4. "This play searched with" shows 6 pills and "+N more", folded by default;
//   5. a play with 0 leads ready shows a designed state whose actions only prefill Plays (Widen to 180 days lands on
//      Plays with only the day count changed; place and signal open the full request to edit); Home writes nothing;
//   6. if the weekly-watch list cannot be read, the schedule reads unavailable, never "Ran once".
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-homeplay-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const now = Math.floor(Date.now() / 1000)
const P = 'a'.repeat(24)
const QUERY = 'Find owners or office managers of independent dental practices in NYC, Brooklyn and Queens that opened a new location or announced an expansion in the past 90 days; 2-10 chairs; skip chains, DSOs and dental schools; I need a dated source and a practice manager contact for each one.'
const ICP = { summary: 'Independent dental practices with 2-10 chairs that are expanding', who: ['Practice owner', 'Office manager', 'Practice manager'], industries: ['Dental', 'Orthodontics'], where: ['NYC', 'Brooklyn', 'Queens'], sizes: ['2-10 chairs'], signals: ['Opened a new location', 'Announced an expansion', 'Hiring front-desk staff', 'Bought new equipment'], exclude: ['Chains', 'DSOs', 'Dental schools'], window_days: 90 }
const PROFILE = { business_name: 'Brightsmile', sells: 'Online booking and reminders for dental practices', website: 'https://brightsmile.example', buyer: { summary: 'Independent dental practices with 2-10 chairs', who: ['Practice owner', 'Office manager'], industries: ['Dental'], where: ['NYC'], sizes: [], signals: ['Opened a new location'], exclude: [] } }
const person = (n, url) => ({ connector: 'sitecrawl', kind: 'person', value: n, label: null, source_url: url, source_date: '2026-10-20', confidence: null })
const lead = (id, company, host, o = {}) => ({ id, name: '', company, contact: `office@${id.slice(0, 3)}.example`, signal: `${company} opened a new location`, source_url: `https://www.${host}/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} opened a new location`, event_date: '2026-10-09', date_status: 'verified', published_at: null, confidence: 90, review_reason: null, company_domain: `${id.slice(0, 3)}.example`, human_confirmed_at: null, fit: 4, intent: 4, action: 3, why: `${company} opened a second office in ${o.place ?? 'Brooklyn'} and is hiring front-desk staff.`, signals: null, icp_match: null, enrichments: [person(o.person ?? 'Dana Smith, Practice owner', `https://www.${host}/x`)], events: [], ...o })
const LEADS = [
  lead('1'.repeat(24), 'Park Slope Family Dental', 'brooklynpaper.example', { person: 'Dana Smith, Practice owner' }),
  lead('2'.repeat(24), 'Astoria Smiles', 'qns.example', { place: 'Astoria', person: 'Luis Ortega, Office manager' }),
  lead('3'.repeat(24), 'Chelsea Dental Studio', 'dnainfo.example', { place: 'Chelsea', person: 'Priya Rao, Practice manager', fit: 5 }),
  lead('4'.repeat(24), 'Williamsburg Orthodontics', 'brooklynpaper.example', { place: 'Williamsburg', person: 'Sam Lee, Practice owner', contact: null }),
  lead('5'.repeat(24), 'Forest Hills Dentistry', 'qchron.example', { place: 'Forest Hills', person: 'Ana Costa, Office manager' }),
  lead('6'.repeat(24), 'Gramercy Dental Practice', 'facebook.example', { review_reason: 'identity_mismatch' }),
  lead('7'.repeat(24), 'Harbor Dental', 'patch.example', { event_date: null, date_status: 'undated' }),
  lead('8'.repeat(24), 'Bay Ridge Smiles', 'patch.example', { window_held: true }),
]
const job = o => ({ id: P, status: 'done', error: null, query: QUERY, business_name: '', csv_domain: null, created_at: now - 2 * 86400, finished_at: now - 2 * 86400 + 600, candidates: 11, verified: 5, needs_review: 3, dropped: 3, lead_count: 8, test_only: false, funded_by: null, ...o })
const MSGS = [['1', 'sent'], ['2', 'sent'], ['3', 'draft']].map(([d, status], i) => ({ id: `m${i}`, lead_id: d.repeat(24), to_email: 'x@y.example', subject: 'Hi', status, created_at: now, sent_at: status === 'sent' ? now : null }))
const SCENES = {
  useful: { jobs: [job()], leads: LEADS, msgs: MSGS, watches: [{ id: 'w1', query: QUERY, icp: ICP, active: true, next_run_at: now + 5 * 86400, last_run_at: now - 2 * 86400, paused_reason: null, last_job_id: P, last_status: 'done', new_leads: 5 }] },
  watchfail: { jobs: [job()], leads: LEADS, msgs: MSGS, watches: 'fail' },
  zero: { jobs: [job({ status: 'failed', error: 'no_candidates', candidates: 0, verified: null, needs_review: null, dropped: null, lead_count: 0 })], leads: [], msgs: [], watches: [] },
}
const b = await chromium.launch()
async function open(sc, width, height) {
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
    if (p === '/api/scan/jobs') return json({ jobs: sc.jobs, totals: { searches: 1, finished: 1 } })
    if (p === '/api/scan/latest') return json({ query: QUERY, icp: ICP, icp_source: 'user' })
    if (p === '/api/leads') return json({ leads: sc.leads, hidden_count: 0 })
    if (p === `/api/campaigns/${P}`) return json({ job: sc.jobs[0], leads: sc.leads, messages: sc.msgs })
    if (p === '/api/watch') return sc.watches === 'fail' ? json({ error: 'boom' }, 500) : json({ watches: sc.watches })
    if (p === '/api/usage') return json({ plan: 'pro', scans_used: 3, scan_limit: 50, has_key: true, trial: null })
    if (p === '/api/settings/llm-key') return json({ keys: [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1 }], rejection: null })
    if (p === '/api/settings/advanced') return json({ available: true, version: '1', platforms: [] })
    if (p === '/api/scan/sources') return json({ web_index: false, news: true, websites: true })
    if (p === '/api/outreach/settings') return json({ gmail: { email: 'dana@brightsmile.example', status: 'active' }, sender: { sender_name: 'Dana', postal_address: '1 Main St' }, daily_cap: 20, sent_24h: 2, account_sent_24h: 2, read_notice: [] })
    if (p === '/api/outreach') return json({ messages: [] })
    if (p === '/api/campaigns') return json({ campaigns: [] })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  await page.getByTestId('journey').waitFor({ timeout: 15000 }); await page.waitForLoadState('networkidle')
  return { ctx, page, writes }
}
const shot = async (page, name) => { if (process.env.SHOTS) { await page.waitForTimeout(300); await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) } }
try {
  for (const [w, h, tag] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
    for (const scene of ['useful', 'zero', 'watchfail']) {
      if (scene === 'watchfail' && (tag !== 'desktop' || process.env.BEFORE_ONLY)) continue
      const { ctx, page, writes } = await open(SCENES[scene], w, h)
      if (scene !== 'watchfail') await shot(page, `${scene}-${tag}`)
      if (!process.env.BEFORE_ONLY && tag === 'desktop') {
        const main = page.locator('main')
        if (scene === 'useful') {
          assert.equal(await page.getByTestId('journey-play').textContent(), 'NYC dental practices expanding', 'a short play name, not the raw request')
          assert.equal(await page.getByTestId('play-request').isVisible(), false, 'the full request sits behind the (i)')
          assert.equal(await page.getByTestId('play-request').textContent(), QUERY)
          assert.equal(await page.getByTestId('play-status').textContent(), 'Live')
          assert.match(await page.getByTestId('play-pace').textContent(), /^Runs weekly, next /)
          const stat = async t => (await page.getByTestId(t).locator('div').first().textContent()).trim()
          assert.deepEqual([await stat('stat-ready'), await stat('stat-held'), await stat('stat-contacted')], ['5', '3', '2'])
          const yResults = (await page.getByTestId('journey-results').boundingBox()).y, yUnderstand = (await page.getByTestId('journey-understanding').boundingBox()).y
          assert.ok(yResults < yUnderstand, 'results come before the profile')
          assert.equal(await page.getByTestId('journey-opportunity').count(), 3)
          const understand = await page.getByTestId('journey-understanding').innerText()
          assert.doesNotMatch(understand, /Not set|\bAny\b|Nothing|Anywhere/, 'only what is set is shown')
          assert.match(await page.getByTestId('profile-nudge').textContent(), /^Complete your profile - add company size, who to skip$/)
          const pills = page.getByTestId('journey-constraints').locator('.pill:visible')
          assert.equal(await pills.count(), 7, '6 pills and the "+N more" toggle')
          assert.equal(await page.getByTestId('pills-more').textContent(), '+11 more')
          await page.getByTestId('pills-more').click()
          assert.equal(await page.getByTestId('journey-constraints').locator('.pill:visible').count(), 18)
          assert.equal(await page.getByTestId('pills-more').textContent(), 'Show less')
          await page.getByTestId('pills-more').click()
        } else if (scene === 'watchfail') {
          // The weekly-watch list could not be read: the schedule is unknown, never reported as "Ran once".
          await page.waitForFunction(() => !!document.querySelector('[data-testid=play-status]'))
          assert.equal(await page.getByTestId('play-status').textContent(), 'Done')
          assert.match(await page.getByTestId('play-pace').textContent(), /^Last run .+; schedule unavailable$/)
          assert.doesNotMatch(await page.getByTestId('play-card').innerText(), /Ran once/)
        } else {
          assert.equal(await page.getByTestId('journey-line').textContent(), 'This play found 0 companies.')
          assert.equal(await page.getByTestId('journey-empty').isVisible(), true)
          assert.deepEqual(await page.getByTestId('journey-empty').getByRole('link').allTextContents(), ['Widen to 180 days', 'Change the place', 'Change the signal'])
          // Place and signal are changed by the user from the full request; nothing claims to have dropped anything.
          for (const t of ['widen-city', 'widen-signal']) assert.equal(decodeURIComponent((await page.getByTestId(t).getAttribute('href')).split('q=')[1]), QUERY)
          await page.getByTestId('widen-window').click()
          await page.waitForURL(/\/app\/leads\?q=/)
          await page.locator('#play').waitFor()
          await page.waitForFunction(() => document.querySelector('#play')?.value.includes('180 days'))
          assert.equal(await page.locator('#play').inputValue(), QUERY.replace('90 days', '180 days'), 'Plays opens with the widened sentence; nothing started')
        }
        assert.deepEqual(writes, [], 'Home and the widen action write nothing')
        void main
      }
      await ctx.close()
    }
  }
  console.log(process.env.BEFORE_ONLY ? 'before shots taken' : 'home play UI check passed: short play name with Who/Signal/Pace and Live status, results first (5/3/2), only set facts + one nudge, 6 pills + "+11 more", designed zero state whose Widen action prefills Plays without running anything')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
