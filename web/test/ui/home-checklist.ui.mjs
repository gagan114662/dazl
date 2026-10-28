// Home's five-step path (website -> brain -> first play run -> first lead approved -> first draft sent) with realistic
// seeded tenant data. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/home-checklist.ui.mjs   (SHOTS=<dir> saves desktop and mobile screenshots)
// Production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed in the browser:
// no scan, no draft, nothing sent. It proves:
//   1. midway (play finished, one draft, nothing sent): steps 1-4 ticked, "First draft sent" is next and links to
//      Outreach; the sources line names only the sources that ran in that play (not skipped or switched-off ones);
//   2. new (website saved, no brain): the brain is next and links to /app?setup=brain; the sources line names only the
//      sources configured here (an operator-off source is not named);
//   3. emails that fail to load make "approved" and "sent" "could not check", never a tick or a to-do;
//   4. all five done: the checklist is gone;
//   5. nothing is written; no horizontal scroll at 390px.
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-homechecklist-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const now = Math.floor(Date.now() / 1000)
const P = 'a'.repeat(24)
const QUERY = 'Independent dental practices in Brooklyn and Queens that opened a new location in the past 90 days'
const PROFILE = { business_name: 'Brightsmile', sells: 'Online booking and reminders for dental practices', website: 'https://brightsmile.example', buyer: { summary: 'Independent dental practices with 2-10 chairs that are expanding', who: ['Practice owner', 'Office manager'], industries: ['Dental'], sizes: ['2-10 chairs'], where: ['Brooklyn', 'Queens'], signals: ['new location'], exclude: ['DSOs'] } }
const JOB = { id: P, status: 'done', error: null, query: QUERY, business_name: '', csv_domain: null, created_at: now - 86400, finished_at: now - 86400 + 540, candidates: 12, verified: 5, needs_review: 2, dropped: 5, lead_count: 7, test_only: false }
const PROGRESS = [
  { source: 'search:anthropic', state: 'done', status: 'ok', note: null, candidates: 6, accepted: 3, review: 1, rejected: 2 },
  { source: 'search:news', state: 'done', status: 'ok', note: null, candidates: 5, accepted: 2, review: 1, rejected: 2 },
  { source: 'adapter:pages', state: 'done', status: 'empty', note: null, candidates: 0, accepted: 0, review: 0, rejected: 0 },
  { source: 'adapter:reddit', state: 'done', status: 'skipped', note: null, candidates: null, accepted: null, review: null, rejected: null },
  { source: 'search:tinyfish', state: 'done', status: 'unavailable', note: null, candidates: null, accepted: null, review: null, rejected: null },
]
const msg = (i, status) => ({ id: `m${i}`, lead_id: String(i).repeat(24), to_email: 'office@parkslope.example', subject: 'Your new Park Slope location', status, created_at: now, sent_at: status === 'sent' ? now : null })
const SCENES = {
  midway: { profile: PROFILE, jobs: [JOB], msgs: [msg(1, 'draft')] },
  fresh: { profile: { ...PROFILE, buyer: null }, jobs: [], msgs: [] },
  emailsfail: { profile: PROFILE, jobs: [JOB], msgs: 'fail' },
  alldone: { profile: PROFILE, jobs: [JOB], msgs: [msg(1, 'sent'), msg(2, 'draft')] },
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
    if (p === '/api/settings/profile') return json(sc.profile)
    if (p === '/api/scan/jobs') return json({ jobs: sc.jobs, totals: { searches: sc.jobs.length, finished: sc.jobs.filter(j => j.status === 'done').length } })
    if (p === '/api/scan/status') return u.searchParams.get('job_id') === P ? json({ job_id: P, status: 'done', progress: PROGRESS }) : json({}, 404)
    if (p === '/api/scan/latest') return json({ query: sc.jobs[0]?.query ?? null, icp: null, icp_source: null })
    if (p === '/api/leads') return json({ leads: [], hidden_count: 0 })
    if (p === `/api/campaigns/${P}`) return json({ job: JOB, leads: [], messages: Array.isArray(sc.msgs) ? sc.msgs : [] })
    if (p === '/api/watch') return json({ watches: [] })
    if (p === '/api/usage') return json({ plan: 'pro', scans_used: 3, scan_limit: 50, has_key: true, trial: null })
    if (p === '/api/settings/llm-key') return json({ keys: [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1 }], rejection: null })
    if (p === '/api/settings/advanced') return json({ available: true, version: '1', platforms: [{ platform: 'reddit', allowed: true, consent: false, connected: false, enabled: false }] })
    if (p === '/api/scan/sources') return json({ web_index: false, news: true, websites: true })
    if (p === '/api/outreach/settings') return json({ gmail: { email: 'dana@brightsmile.example', status: 'active' }, sender: { sender_name: 'Dana Smith', postal_address: '1 Main St, Brooklyn NY' }, daily_cap: 20, sent_24h: 0, account_sent_24h: 0, read_notice: [] })
    if (p === '/api/outreach') return sc.msgs === 'fail' ? json({ error: 'boom' }, 500) : json({ messages: sc.msgs })
    if (p === '/api/campaigns') return json({ campaigns: [] })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  await page.getByTestId('journey').waitFor({ timeout: 15000 }); await page.waitForLoadState('networkidle')
  return { ctx, page, writes }
}
const states = page => page.getByTestId('home-checklist').locator('li').evaluateAll(ls => ls.map(l => `${l.dataset.testid.slice(3)}:${l.dataset.hcState}${l.dataset.hcNext ? '*' : ''}`))
const shot = async (page, name) => { if (process.env.SHOTS) { await page.waitForTimeout(300); await page.getByTestId('home-checklist').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) } }
try {
  for (const [w, h, tag] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
    // 1. Midway.
    let { ctx, page, writes } = await open(SCENES.midway, w, h)
    await page.getByTestId('hc-sources').waitFor()
    assert.deepEqual(await states(page), ['website:done', 'brain:done', 'play:done', 'approved:done', 'sent:todo*'])
    assert.equal(await page.getByTestId('hc-progress').textContent(), '4 of 5')
    const next = page.getByTestId('hc-sent').getByRole('link')
    assert.deepEqual([await next.textContent(), await next.getAttribute('href')], ['Open Outreach', '/app/outreach'])
    assert.match(await page.getByTestId('hc-sent').innerText(), /a draft is waiting: approve its exact text and send/)
    assert.match(await page.getByTestId('hc-play').innerText(), /1 finished; latest: Independent dental practices/)
    const src = page.getByTestId('hc-sources')
    assert.equal(await src.getAttribute('data-basis'), 'ran')
    assert.deepEqual(await src.locator('.pill').allTextContents(), ['Web research with your AI key', 'News articles', 'Web pages'], 'only sources that ran; skipped Reddit and switched-off web search are not named')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll (${tag})`)
    await shot(page, `midway-${tag}`)
    assert.deepEqual(writes, []); await ctx.close()
    // 2. New tenant: website saved, no brain.
    ;({ ctx, page, writes } = await open(SCENES.fresh, w, h))
    await page.getByTestId('hc-sources').waitFor()
    assert.deepEqual(await states(page), ['website:done', 'brain:todo*', 'play:todo', 'approved:todo', 'sent:todo'])
    const build = page.getByTestId('hc-brain').getByRole('link')
    assert.deepEqual([await build.textContent(), await build.getAttribute('href')], ['Build', '/app?setup=brain'])
    assert.equal(await page.getByTestId('hc-play').getByRole('link').getAttribute('href'), '/app/leads')
    assert.equal(await page.getByTestId('hc-sources').getAttribute('data-basis'), 'ready')
    assert.deepEqual(await page.getByTestId('hc-sources').locator('.pill').allTextContents(), ['Web research with your AI key', 'News articles', 'Company websites'], 'the operator-off web index and unconsented Reddit are not named')
    await shot(page, `new-${tag}`)
    assert.deepEqual(writes, []); await ctx.close()
    if (tag !== 'desktop') continue
    // 3. Emails failed to load.
    ;({ ctx, page, writes } = await open(SCENES.emailsfail, w, h))
    await page.getByTestId('home-checklist').waitFor()
    assert.deepEqual(await states(page), ['website:done', 'brain:done', 'play:done', 'approved:unknown', 'sent:unknown'])
    assert.match(await page.getByTestId('hc-sent').innerText(), /could not check - your emails did not load/)
    await ctx.close()
    // 4. All done: no checklist.
    ;({ ctx, page, writes } = await open(SCENES.alldone, w, h))
    await page.waitForTimeout(800)
    assert.equal(await page.getByTestId('home-checklist').count(), 0, 'hidden once all five are done')
    assert.deepEqual(writes, []); await ctx.close()
  }
  console.log('home checklist UI check passed: 5 steps from tenant state with links (midway, new, emails unreadable, all done hidden); sources named only when they ran or are configured; no writes; no horizontal scroll at 390px')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
