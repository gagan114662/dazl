// Home's setup checklist toward the first useful result (profile -> search can run -> first search -> qualified lead ->
// contact -> draft -> sender setup), with realistic seeded tenant data. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/ready-card.ui.mjs   (SHOTS=<dir> saves desktop and 390px screenshots)
// Production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed in the browser:
// no scan, no send. It proves:
//   1. new account: Build profile / Add key / Run a search / Connect, each straight to its fix; later steps wait with no
//      button; the profile step is next;
//   2. the reviewed account (6 searches, 0 source-checked, 0 contacts, Gmail on, sender details missing): 3 of 7, "Review
//      leads" on the latest search is next, sender says what is missing and opens Settings at Gmail;
//   3. midway (2 source-checked, 1 with a contact, no draft): the draft step is next; sources name only what can run;
//   4. results unreadable: qualified / contact / draft are "could not check" with no button, card stays;
//   5. everything done: no card; the card is above the journey, no primary button, no writes, no horizontal scroll at 390px.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-readycard-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const now = Math.floor(Date.now() / 1000)
const PROFILE = { business_name: 'Brightsmile', sells: 'Online booking and reminders for dental practices', website: 'https://brightsmile.example', buyer: { summary: 'Independent dental practices with 2-10 chairs that are expanding', who: ['Practice owner', 'Office manager'], industries: ['Dental'], sizes: ['2-10 chairs'], where: ['Brooklyn, NY', 'Queens, NY'], signals: ['new location'], exclude: ['DSOs'] } }
const GMAIL = { email: 'dana@brightsmile.example', status: 'active' }, SENDER = { sender_name: 'Dana Smith', postal_address: '1 Main St, Brooklyn NY' }
const job = (id, t, q) => ({ id: id.repeat(24), status: 'done', error: null, query: q, csv_domain: null, created_at: now - t * 86400, lead_count: 0, candidates: 2, verified: 0, needs_review: 0, dropped: 2, test_only: false })
const JOBS = [job('a', 1, 'London B2B SaaS startups hiring sales'), job('b', 2, 'Dental practices in Brooklyn opening a new location'), job('c', 3, 'Queens dentists hiring front desk'), job('d', 4, 'NYC orthodontists expanding'), job('e', 5, 'Brooklyn dental groups raising funding'), job('f', 6, 'New York dental chains hiring')]
const camp = (id, o = {}) => ({ id, qualification: { sourceChecked: o.sc ?? 0, confirmedByYou: 0, needsReview: 0, unverified: 0, held: o.held ?? 2, rejected: 0 }, contact: { withContact: o.contacts ?? 0 }, outreach: { drafts: o.drafts ?? 0, approved: 0, sent: 0 } })
const SCENES = {
  fresh: { profile: { ...PROFILE, buyer: null }, key: false, gmail: null, sender: null, jobs: [], camps: [], msgs: [] },
  reviewed: { profile: PROFILE, key: true, gmail: GMAIL, sender: { sender_name: '', postal_address: '' }, jobs: JOBS, camps: JOBS.map(j => camp(j.id)), msgs: [] },
  midway: { profile: PROFILE, key: true, gmail: GMAIL, sender: SENDER, jobs: JOBS.slice(0, 2), camps: [camp(JOBS[0].id, { sc: 2, contacts: 1 }), camp(JOBS[1].id)], msgs: [] },
  campsfail: { profile: PROFILE, key: true, gmail: GMAIL, sender: SENDER, jobs: JOBS.slice(0, 2), camps: 'fail', msgs: [] },
  done: { profile: PROFILE, key: true, gmail: GMAIL, sender: SENDER, jobs: JOBS.slice(0, 1), camps: [camp(JOBS[0].id, { sc: 2, contacts: 1, drafts: 1 })], msgs: [{ id: 'm1', lead_id: 'x', status: 'draft' }] },
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
    if (p === '/api/scan/jobs') return json({ jobs: sc.jobs, totals: { searches: sc.jobs.length, finished: sc.jobs.length } })
    if (p === '/api/scan/latest') return json({ query: sc.jobs[0]?.query ?? null, icp: null, icp_source: null })
    if (p === '/api/leads') return json({ leads: [], hidden_count: 0 })
    if (p.startsWith('/api/campaigns/')) return json({ job: sc.jobs[0], leads: [], messages: [] })
    if (p === '/api/watch') return json({ watches: [] })
    if (p === '/api/usage') return json({ plan: 'free', scans_used: sc.jobs.length, scan_limit: 50, has_key: sc.key, trial: null })
    if (p === '/api/settings/llm-key') return json({ keys: sc.key ? [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1 }] : [], rejection: null })
    if (p === '/api/settings/advanced') return json({ available: true, version: '1', platforms: [{ platform: 'reddit', allowed: true, consent: false, connected: false, enabled: false }] })
    if (p === '/api/scan/sources') return json({ web_index: false, news: true, websites: true })
    if (p === '/api/outreach/settings') return json({ gmail: sc.gmail, sender: sc.sender, daily_cap: 20, sent_24h: 0, account_sent_24h: 0, read_notice: [] })
    if (p === '/api/outreach') return json({ messages: sc.msgs })
    if (p === '/api/campaigns') return sc.camps === 'fail' ? json({ error: 'boom' }, 500) : json({ campaigns: sc.camps })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  await page.getByTestId('journey').waitFor({ timeout: 15000 }); await page.waitForLoadState('networkidle')
  return { ctx, page, writes }
}
const card = page => page.getByTestId('ready-card')
const states = page => card(page).locator('li').evaluateAll(ls => ls.map(l => `${l.dataset.testid.slice(3)}:${l.dataset.rcState}${l.dataset.rcNext ? '*' : ''}`))
const fixes = page => card(page).locator('li').evaluateAll(ls => ls.map(l => [...l.querySelectorAll('a,button')].map(a => `${a.textContent}>${a.getAttribute('href')}`).join('')))
const shot = async (page, name) => { if (process.env.SHOTS) { await page.waitForTimeout(300); await card(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }); await card(page).screenshot({ path: path.join(process.env.SHOTS, `${name}-card.png`) }) } }
const A = JOBS[0].id
try {
  for (const [w, h, tag] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
    // 1. New account.
    let { ctx, page, writes } = await open(SCENES.fresh, w, h)
    await card(page).waitFor()
    assert.deepEqual(await states(page), ['profile:todo*', 'search:todo', 'play:todo', 'qualified:todo', 'contact:todo', 'draft:todo', 'sender:todo'])
    assert.deepEqual(await fixes(page), ['Build profile>/app?setup=brain', 'Add key>/app/settings#model-key', 'Run a search>/app/leads', '', '', '', 'Connect>/app/settings#gmail'])
    assert.equal(await page.getByTestId('rc-progress').textContent(), '0 of 7 done')
    assert.equal(await card(page).locator('.btn-primary').count(), 0, 'Home keeps one primary action')
    assert.ok((await card(page).boundingBox()).y < (await page.getByTestId('journey').boundingBox()).y, 'the card sits above the journey')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll (${tag})`)
    await shot(page, `new-${tag}`)
    assert.deepEqual(writes, []); await ctx.close()
    // 2. The reviewed account.
    ;({ ctx, page, writes } = await open(SCENES.reviewed, w, h))
    await card(page).waitFor()
    assert.deepEqual(await states(page), ['profile:done', 'search:done', 'play:done', 'qualified:todo*', 'contact:todo', 'draft:todo', 'sender:todo'])
    assert.equal(await page.getByTestId('rc-progress').textContent(), '3 of 7 done')
    assert.deepEqual(await fixes(page), ['', '', '', `Review leads>/app/leads?job_id=${A}`, '', '', 'Add sender details>/app/settings#gmail'])
    assert.match(await page.getByTestId('rc-qualified').innerText(), /no lead has passed the source check yet/)
    assert.match(await page.getByTestId('rc-sender').innerText(), /sending from dana@brightsmile\.example; your sender name and mailing address are missing/)
    assert.match(await page.getByTestId('rc-search').innerText(), /Sources: Web research with your AI key, News articles, Company websites/)
    assert.doesNotMatch(await card(page).innerText(), /Web search index|Reddit/, 'sources that cannot run are not shown as available')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll (${tag})`)
    await shot(page, `reviewed-${tag}`)
    if (tag === 'desktop') {
      await page.getByTestId('rc-sender').getByRole('link', { name: 'Add sender details' }).click()
      await page.waitForURL('**/app/settings#gmail')
    }
    assert.deepEqual(writes, []); await ctx.close()
    if (tag !== 'desktop') continue
    // 3. Midway.
    ;({ ctx, page, writes } = await open(SCENES.midway, w, h))
    await card(page).waitFor()
    assert.deepEqual(await states(page), ['profile:done', 'search:done', 'play:done', 'qualified:done', 'contact:done', 'draft:todo*', 'sender:done'])
    assert.deepEqual((await fixes(page))[5], `Review leads>/app/leads?job_id=${A}`)
    await shot(page, `midway-${tag}`)
    await ctx.close()
    // 4. Results unreadable.
    ;({ ctx, page, writes } = await open(SCENES.campsfail, w, h))
    await card(page).waitFor()
    assert.deepEqual((await states(page)).slice(3, 6), ['qualified:unknown', 'contact:unknown', 'draft:unknown'])
    assert.deepEqual((await fixes(page)).slice(3, 6), ['', '', ''], 'nothing to press for a check that failed')
    await ctx.close()
    // 5. Everything done.
    ;({ ctx, page, writes } = await open(SCENES.done, w, h))
    await page.waitForTimeout(800)
    assert.equal(await card(page).count(), 0, 'gone once every step is done')
    assert.deepEqual(writes, []); await ctx.close()
  }
  console.log('setup checklist UI check passed: 7 steps from tenant state (new, reviewed account, midway, results unreadable, all done hidden), one fix button per actionable step, only usable sources named, above the journey, no primary button, no writes, no horizontal scroll at 390px')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
