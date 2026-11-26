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
import { pickUiPort } from '../helpers/ui-port.mjs'
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
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const now = Math.floor(Date.now() / 1000)
// #1772 2g's /api/home/results answer: the by-signal footnote (tiles.leads 'N leads from M companies; K without a
// company name') renders from this response - HomeResultsPanel is a client component and every /api/* call here is
// stubbed, so the panel never reads the harness database. The numbers behind it (companyKey dedup, unnamed count)
// come from lib/outreach/home-results.ts and are unit-tested in home-results-1040.test.ts: two names sharing one
// companyKey, one distinct company, one lead with no company name.
const RESULTS2G = { window_days: 30, since: now - 30 * 86400, reply_reading: true, tiles: { leads: 4, contacted: 0, replied: 0, interested: 0 }, by_signal: [{ signal: 'hiring', leads: 4, contacted: 0, replied: 0 }], companies: 2, unnamed_leads: 1,
  latest_leads: [{ id: 'r1', company: 'Dup Inc', signal: 'hiring', job_id: 'a'.repeat(24), created_at: now - 3600 }, { id: 'r2', company: 'Dup Ltd', signal: 'hiring', job_id: 'a'.repeat(24), created_at: now - 3500 }, { id: 'r3', company: 'Solo Co', signal: 'hiring', job_id: 'b'.repeat(24), created_at: now - 3400 }, { id: 'r4', company: 'Unnamed company', signal: 'hiring', job_id: 'b'.repeat(24), created_at: now - 3300 }],
  latest_replies: [] }
const PROFILE = { business_name: 'Brightsmile', sells: 'Online booking and reminders for dental practices', website: 'https://brightsmile.example', buyer: { summary: 'Independent dental practices with 2-10 chairs that are expanding', who: ['Practice owner', 'Office manager'], industries: ['Dental'], sizes: ['2-10 chairs'], where: ['Brooklyn, NY', 'Queens, NY'], signals: ['new location'], exclude: ['DSOs'] } }
const GMAIL = { email: 'dana@brightsmile.example', status: 'active' }, SENDER = { sender_name: 'Dana Smith', postal_address: '1 Main St, Brooklyn NY' }
const job = (id, t, q) => ({ id: id.repeat(24), status: 'done', error: null, query: q, csv_domain: null, created_at: now - t * 86400, lead_count: 0, candidates: 2, verified: 0, needs_review: 0, dropped: 2, test_only: false })
const JOBS = [job('a', 1, 'London B2B SaaS startups hiring sales'), job('b', 2, 'Dental practices in Brooklyn opening a new location'), job('c', 3, 'Queens dentists hiring front desk'), job('d', 4, 'NYC orthodontists expanding'), job('e', 5, 'Brooklyn dental groups raising funding'), job('f', 6, 'New York dental chains hiring')]
const camp = (id, o = {}) => ({ id, status: 'done', qualification: { sourceChecked: o.sc ?? 0, confirmedByYou: 0, needsReview: 0, unverified: 2, held: o.held ?? 0, rejected: 0 }, contact: { withContact: o.contacts ?? 0, readyWithContact: o.ready ?? 0, draftable: o.draftable ?? 0 }, outreach: { drafts: o.drafts ?? 0, approved: 0, sent: 0 } })
const SCENES = {
  fresh: { profile: { ...PROFILE, buyer: null }, key: false, gmail: null, sender: null, jobs: [], camps: [], msgs: [] },
  siteform: { profile: { ...PROFILE, business_name: '' }, key: true, gmail: GMAIL, sender: SENDER, jobs: [], camps: [], msgs: [] },
  manual: { profile: { ...PROFILE, website: undefined }, key: true, gmail: null, sender: null, jobs: [], camps: [], msgs: [] },
  reviewed: { profile: PROFILE, key: true, gmail: GMAIL, sender: { sender_name: '', postal_address: '' }, jobs: JOBS, camps: JOBS.map(j => camp(j.id)), msgs: [] },
  midway: { profile: PROFILE, key: true, gmail: GMAIL, sender: SENDER, jobs: JOBS.slice(0, 2), camps: [camp(JOBS[0].id), camp(JOBS[1].id, { sc: 2, contacts: 1, ready: 1, draftable: 1 })], msgs: [] },
  quota: { profile: PROFILE, key: true, gmail: GMAIL, sender: SENDER, jobs: JOBS, camps: JOBS.map(j => camp(j.id)), msgs: [], used: 50 },
  campsfail: { profile: PROFILE, key: true, gmail: GMAIL, sender: SENDER, jobs: JOBS.slice(0, 2), camps: 'fail', msgs: [] },
  // #1678: a password account with no key: step 2 offers two buttons (Link Google, Add key)
  pwtrial: { profile: PROFILE, key: false, trial: { blocked: 'google_required' }, gmail: null, sender: null, jobs: [], camps: [], msgs: [] },
  done: { profile: PROFILE, key: true, gmail: GMAIL, sender: SENDER, jobs: JOBS.slice(0, 1), camps: [camp(JOBS[0].id, { sc: 2, contacts: 1, ready: 1, drafts: 1 })], msgs: [{ id: 'm1', lead_id: 'x', status: 'draft' }] },
  withresults: { profile: PROFILE, key: true, gmail: GMAIL, sender: SENDER, jobs: JOBS, camps: JOBS.map(j => camp(j.id)), msgs: [], results: RESULTS2G },
}
// #1722: scenario 2c flips the sender mid-scene (filled in elsewhere); null = use the scene's own sender.
let liveSender = null
let settingsSlowUntil = 0
let profileSlowFirst = 0 // one-shot: delays the first /api/settings/profile response (the mount read)
let profileGate = 0 // 2h: holds this many /api/settings/profile GETs until releaseHeldProfiles() (armed BEFORE open, like profileSlowFirst)
let profileSeen = 0 // profile GETs served since the gate was armed; the FIRST is FirstRun's own read and always passes
const profileHeld = []
const profileLog = [] // every profile GET arrival, in order, '#n' or '#n held' - failure forensics for reader order
const releaseHeldProfiles = () => { while (profileHeld.length) profileHeld.shift()() }
const b = await chromium.launch()
async function open(sc, width, height, opts = {}) {
  liveSender = null
  settingsSlowUntil = 0
  const ctx = await b.newContext({ viewport: { width, height } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const writes = []
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
    if (u.origin !== base) return route.abort()
    if (!p.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (m !== 'GET') {
      const body = req.postData() ?? ''
      writes.push(`${m} ${p} ${body}`)
      if (p === '/api/settings/profile') return json({ ok: true }) // 2h inspects the posted body; the save flow reads only .ok and .error
      return json({ error: 'not stubbed' }, 400)
    }
    if (p === '/api/settings/profile') {
      // /app's profile readers land in mount order (each fires its fetch synchronously in its mount effect, and
      // FirstRun renders nothing until its own read resolves): #1 FirstRun (first-run.tsx:127, never held), #2
      // ReadyCard's mount load (ready-card.tsx:15), #3 Journey's loadProfile (journey.tsx:46), #4 the readiness
      // panel's mount read (readiness.tsx:62 - the only read that seeds the form). 2h holds exactly #4 via `> 3`.

      const n = ++profileSeen
      if (profileGate > 0 && n > 3) { profileLog.push(`#${n} held`); profileGate--; await new Promise(r => profileHeld.push(r)) } // 2h: the held readiness mount read
      else profileLog.push(`#${n}`)

      if (profileSlowFirst > 0) { const ms = profileSlowFirst; profileSlowFirst = 0; await new Promise(r => setTimeout(r, ms)) } // #1760 2e/2f: a slow mount read
      return json(sc.profile)
    }
    if (p === '/api/scan/jobs') return json({ jobs: sc.jobs, totals: { searches: sc.jobs.length, finished: sc.jobs.length } })
    if (p === '/api/scan/latest') return json({ query: sc.jobs[0]?.query ?? null, icp: null, icp_source: null })
    if (p === '/api/leads') return json({ leads: [], hidden_count: 0 })
    if (p === '/api/home/results') return sc.results ? json(sc.results) : json({}, 404)
    if (p.startsWith('/api/campaigns/')) return json({ job: sc.jobs[0], leads: [], messages: [] })
    if (p === '/api/watch') return json({ watches: [] })
    if (p === '/api/usage') return json({ plan: 'free', scans_used: sc.used ?? sc.jobs.length, scan_limit: 50, has_key: sc.key, trial: sc.trial ?? null })
    if (p === '/api/settings/llm-key') return json({ keys: sc.key ? [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1 }] : [], rejection: null })
    if (p === '/api/settings/advanced') return json({ available: true, version: '1', platforms: [{ platform: 'reddit', allowed: true, consent: false, connected: false, enabled: false }] })
    if (p === '/api/scan/sources') return json({ web_index: false, news: true, websites: true })
    if (p === '/api/outreach/settings') {
      const snap = liveSender ?? sc.sender // the response snapshot is fixed when the request arrives
      const d = settingsSlowUntil - Date.now()
      if (d > 0) await new Promise(r => setTimeout(r, d + 400)) // #1722 2d: a slow older read
      return json({ gmail: sc.gmail, sender: snap, daily_cap: 20, sent_24h: 0, account_sent_24h: 0, read_notice: [] })
    }
    if (p === '/api/outreach') return json({ messages: sc.msgs })
    if (p === '/api/campaigns') return sc.camps === 'fail' ? json({ error: 'boom' }, 500) : json({ campaigns: sc.camps })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  if (opts.deferProfile) {
    // 2h: profile reads are held behind profileGate, so networkidle would never fire. The observable barrier instead:
    // FirstRun renders nothing until its own (ungated) reads resolve, so setup-details visible = page resolved and mounted.
    await page.goto(`${base}/app`, { waitUntil: 'domcontentloaded' })
    await page.getByTestId('setup-details').waitFor({ timeout: 15000 })
  } else {
    await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
    await page.getByTestId('journey').waitFor({ timeout: 15000 }); await page.waitForLoadState('networkidle')
  }
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
    // 1b. A complete profile saved by hand (sells + buyer, no website): the profile step is done, the search
    // step is next - the card never asks for a website (#420).
    ;({ ctx, page, writes } = await open(SCENES.manual, w, h))
    await card(page).waitFor()
    assert.deepEqual(await states(page), ['profile:done', 'search:done', 'play:todo*', 'qualified:todo', 'contact:todo', 'draft:todo', 'sender:todo'], 'manual profile done, search can run, first search is the actual next prerequisite')
    assert.deepEqual(await fixes(page), ['', '', 'Run a search>/app/leads', '', '', '', 'Connect>/app/settings#gmail'], 'no Add website fix anywhere on the manual path')
    assert.ok((await card(page).textContent()).includes('saved by hand'), 'the done detail names the manual profile')
    // The full checklist on the same page must agree (#420 whole contract): the business-details row completes
    // from the manual profile and never asks for a website.
    const siteRow = await page.getByTestId('ready-site').textContent()
    assert.match(siteRow ?? '', /Brightsmile - Online booking and reminders for dental practices/, 'readiness panel completes from the manual profile')
    assert.ok(!/missing website/.test(siteRow ?? ''), 'readiness panel: no website ask on the manual path')
    await shot(page, `manual-${tag}`)
    assert.deepEqual(writes, []); await ctx.close()
    // 1b. #1722: on tab return the sender status re-reads but the open business-details form keeps unsaved input.
    ;({ ctx, page, writes } = await open(SCENES.siteform, w, h))
    await card(page).waitFor()
    await page.getByTestId('setup-details').evaluate(d => { d.open = true })
    await page.getByTestId('ready-site').getByRole('button', { name: 'Add' }).click()
    const nameField = page.getByLabel('Business name')
    await nameField.fill('Typed Unsaved Name')
    await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')) })
    await page.waitForTimeout(500)
    assert.equal(await nameField.inputValue(), 'Typed Unsaved Name', 'unsaved form input survives the wake re-read')
    assert.deepEqual(writes, []); await ctx.close()
    // 2. The reviewed account.
    ;({ ctx, page, writes } = await open(SCENES.reviewed, w, h))
    await card(page).waitFor()
    assert.deepEqual(await states(page), ['profile:done', 'search:done', 'play:done', 'qualified:todo*', 'contact:todo', 'draft:todo', 'sender:todo'])
    assert.equal(await page.getByTestId('rc-progress').textContent(), '3 of 7 done')
    assert.deepEqual(await fixes(page), ['', '', '', `Review leads>/app/leads?job_id=${A}`, '', '', 'Add sender details>/app/settings#gmail'])
    assert.match(await page.getByTestId('rc-qualified').innerText(), /no lead has passed the source check yet/)
    assert.match(await page.getByTestId('rc-sender').innerText(), /sending from dana@brightsmile\.example; your sender name and mailing address are missing/)
    assert.match(await page.getByTestId('rc-search').innerText(), /Sources: News articles/)
    assert.doesNotMatch(await card(page).innerText(), /Web search index|Reddit/, 'sources that cannot run are not shown as available')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll (${tag})`)
    await shot(page, `reviewed-${tag}`)
    if (tag === 'desktop') {
      await page.getByTestId('rc-sender').getByRole('link', { name: 'Add sender details' }).click()
      await page.waitForURL('**/app/settings#gmail')
    }
    assert.deepEqual(writes, []); await ctx.close()
    // 2c. #1722: the sender details get filled in (another tab or a settings visit); using this tab again
    // re-reads the status and flips the sender step to done without a reload.
    ;({ ctx, page, writes } = await open(SCENES.reviewed, w, h))
    await card(page).waitFor()
    assert.match(await page.getByTestId('rc-sender').innerText(), /sending from dana@brightsmile\.example; your sender name and mailing address are missing/)
    assert.equal(await page.getByTestId('rc-progress').textContent(), '3 of 7 done')
    liveSender = SENDER
    await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')) })
    await page.getByTestId('rc-sender').filter({ hasText: 'as Dana Smith' }).waitFor({ timeout: 15000 })
    assert.match(await page.getByTestId('rc-sender').innerText(), /sending from dana@brightsmile\.example, as Dana Smith/)
    assert.equal(await page.getByTestId('rc-progress').textContent(), '4 of 7 done')
    assert.deepEqual(writes, []); await ctx.close()
    // 2d. #1722: a slow older settings read must not revert the newer sender status. The wake's read starts
    // first but is delayed; the sender is filled in and a second wake read lands first. The delayed older
    // response must be discarded, not re-applied.
    ;({ ctx, page, writes } = await open(SCENES.reviewed, w, h))
    await card(page).waitFor()
    assert.match(await page.getByTestId('rc-sender').innerText(), /sender name and mailing address are missing/)
    settingsSlowUntil = Date.now() + 200
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))) // older read starts, gets delayed
    await page.waitForTimeout(300) // it is in flight now
    liveSender = SENDER
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))) // newer read starts, returns at once
    await page.getByTestId('rc-sender').filter({ hasText: 'as Dana Smith' }).waitFor({ timeout: 15000 })
    await page.waitForTimeout(900) // the delayed older response lands here
    assert.match(await page.getByTestId('rc-sender').innerText(), /sending from dana@brightsmile\.example, as Dana Smith/, 'the delayed older read must not revert the sender status')
    assert.equal(await page.getByTestId('rc-progress').textContent(), '4 of 7 done')
    assert.deepEqual(writes, []); await ctx.close()
    // 2e. #1760: a wake re-read that wins the race refreshes only the status - the discarded older mount read
    // must still seed the business-details form once, or a later save would post its empty initial fields over the
    // stored profile (capy review 4700171286).
    profileSlowFirst = 800
    ;({ ctx, page, writes } = await open(SCENES.siteform, w, h))
    await page.waitForTimeout(200) // the mount read is in flight, delayed
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))) // the wake's read starts and lands first
    await card(page).waitFor()
    await page.waitForTimeout(1200) // the delayed older read lands here
    await page.getByTestId('setup-details').locator('summary').click() // the readiness panel lives in this drawer
    await page.getByTestId('ready-site').getByRole('button').click()
    assert.equal(await page.getByLabel('Your website').inputValue(), 'https://brightsmile.example', 'the discarded older read still seeds the form')
    assert.equal(await page.getByLabel('What you sell').inputValue(), 'Online booking and reminders for dental practices')
    assert.deepEqual(writes, []); await ctx.close()
    // 2f. #1760: that late seed never overwrites what the user already typed into the form.
    profileSlowFirst = 1500
    ;({ ctx, page, writes } = await open(SCENES.siteform, w, h))
    await page.waitForTimeout(200)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await card(page).waitFor()
    await page.getByTestId('setup-details').locator('summary').click()
    await page.getByTestId('ready-site').getByRole('button').click()
    await page.getByLabel('Your website').fill('typed.example')
    await page.waitForTimeout(2000) // the delayed older read lands here
    assert.equal(await page.getByLabel('Your website').inputValue(), 'typed.example', 'a late seed never overwrites typed input')
    assert.deepEqual(writes, []); await ctx.close()
    // 2h. #1836: typing into one field before the saved profile loads must not keep
    // the untouched website blank - the seed fills every field the user did not touch, and Save then posts the
    // stored website, not an empty string that would erase it.
    // Exact ordering, all observable (no sleeps standing in for state): /app fires FOUR profile reads on load, in
    // mount order - FirstRun's (ungated, or the page renders nothing), ReadyCard's mount load, Journey's loadProfile,
    // then the readiness panel's mount read, the only read that seeds the form (the focus wake uses load(false),
    // which never seeds). profileGate holds exactly the readiness mount read, so the page is up with the form
    // UNSEEDED. The preconditions below pin that order: a shifted reader order fails loudly there, never green here.
    // A wake re-read (focus) then lands first - the card rendering is the barrier that it did - and it never seeds.
    // Typing happens before the gate opens; releasing it lands the stale mount read, which must still seed the
    // untouched fields. The Save POST is awaited with a request wait armed BEFORE the click, never a fixed sleep.
    profileGate = 1; profileSeen = 0; profileLog.length = 0
    ;({ ctx, page, writes } = await open(SCENES.siteform, w, h, { deferProfile: true }))
    const pageErrors = [], reqFailed = []
    page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0].slice(0, 200)))
    page.on('requestfailed', r => reqFailed.push(`${r.method()} ${new URL(r.url()).pathname} ${r.failure()?.errorText}`.slice(0, 200)))
    try {
      // Reader-order preconditions, each observable: the card and the journey render only when their own reads (#2,
      // #3) resolved, and exactly one held read among exactly four arrivals pins the hold to the readiness mount
      // read (#4). If the reader order ever shifts, one of these fails loudly instead of passing green below.
      await card(page).waitFor({ timeout: 15000 })
      await page.getByTestId('journey').waitFor({ timeout: 15000 })
      const held0 = Date.now() // the held mount read must ARRIVE before it can be counted
      while (!profileHeld.length && Date.now() - held0 < 5000) await page.waitForTimeout(50)
      assert.equal(profileSeen, 4, `${tag}: exactly the four mount readers arrived before the wake (arrivals: ${profileLog.join(', ')})`)
      assert.equal(profileHeld.length, 1, `${tag}: exactly one profile read is held - the readiness mount read (arrivals: ${profileLog.join(', ')})`)
      // readiness.tsx renders nothing until its first load applies (`if (!input) return null`), so a ready-site row
      // in the DOM is the observable barrier that a readiness read landed; the mount read is held, so that was the wake's.
      const wake0 = Date.now() // hydration timing varies: re-dispatch focus until the barrier holds
      while (!(await page.getByTestId('ready-site').count()) && Date.now() - wake0 < 15000) { await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.waitForTimeout(250) }
      assert.ok((await page.getByTestId('ready-site').count()) > 0, `${tag}: the wake read never landed (no readiness rows while the mount read was held)`)
      await page.getByTestId('setup-details').locator('summary').click()
      await page.getByTestId('ready-site').getByRole('button').click()
      assert.equal(await page.getByLabel('Your website').inputValue(), '', `${tag}: the form is unseeded while the mount read is held`)
      await page.getByLabel('What you sell').fill('Typed sells line')
      releaseHeldProfiles() // the stale mount read lands here
      const seed0 = Date.now() // observable barrier: the seed actually arrived, bounded
      while ((await page.getByLabel('Your website').inputValue()) === '' && Date.now() - seed0 < 15000) await page.waitForTimeout(50)
      assert.equal(await page.getByLabel('Your website').inputValue(), 'https://brightsmile.example', `${tag}: the untouched website still seeds when another field was typed`)
      assert.equal(await page.getByLabel('What you sell').inputValue(), 'Typed sells line', `${tag}: the typed field keeps its input`)
      const businessName = page.getByLabel('Business name')
      assert.equal(await businessName.inputValue(), '', `${tag}: the saved fixture has no business name`)
      await businessName.fill(PROFILE.business_name)
      // The browser's own verdict that every required control is populated (the source fixture alone is not proof).
      const validity = await page.evaluate(() => { const f = document.querySelector('[data-testid="ready-site"] form'); return f ? { valid: f.checkValidity(), invalid: [...f.querySelectorAll('input')].filter(i => !i.validity.valid).map(i => i.getAttribute('aria-label')) } : null })
      assert.ok(validity && validity.valid, `${tag}: the populated form is valid before Save (${JSON.stringify(validity)})`)
      const savePosted = page.waitForRequest(r => r.method() === 'POST' && new URL(r.url()).pathname === '/api/settings/profile', { timeout: 15000 })
      await page.getByRole('button', { name: 'Save' }).click()
      await savePosted // armed before the click: the browser provably issued the POST
      const w0 = Date.now(); let saveCall // the harness ledger carries the body; the route handler runs just after the request event
      while (!(saveCall = writes.find(x => x.startsWith('POST /api/settings/profile '))) && Date.now() - w0 < 5000) await page.waitForTimeout(50)
      assert.ok(saveCall, `${tag}: the save posted`)
      const posted = JSON.parse(saveCall.slice('POST /api/settings/profile '.length))
      assert.equal(posted.website, 'https://brightsmile.example', `${tag}: the POST keeps the stored website`)
      assert.equal(posted.sells, 'Typed sells line', `${tag}: the POST keeps the typed sells`)
      assert.equal(posted.business_name, PROFILE.business_name, `${tag}: the POST includes the filled business name`)
      assert.deepEqual(writes.filter(x => !x.startsWith('POST /api/settings/profile')), [])
    } catch (e) {
      const diag = await page.evaluate(() => { const f = document.querySelector('[data-testid="ready-site"] form'); const save = f?.querySelector('button'); return { formPresent: !!f, formValid: f ? f.checkValidity() : null, invalidFields: f ? [...f.querySelectorAll('input')].filter(i => !i.validity.valid).map(i => i.getAttribute('aria-label')) : null, saveEnabled: save ? !save.disabled : null, siteMsg: f?.querySelector('[role="status"]')?.textContent ?? null } }).catch(err => ({ diagError: String(err).split('\n')[0].slice(0, 120) }))
      throw new Error(`${e.message} | diag=${JSON.stringify(diag)} writes=${JSON.stringify(writes).slice(0, 400)} pageErrors=${JSON.stringify(pageErrors)} requestFailed=${JSON.stringify(reqFailed)} profileLog=${profileLog.join(', ')}`, { cause: e }) // a fresh Error: reassigning AssertionError.message never reaches node's uncaught output
    }
    await ctx.close()
    // 2g. #1772: the by-signal table's footnote reads '<leads> leads from <companies> companies' and names the
    // leads with no company name - rendered on the real Home page from the stubbed /api/home/results answer
    // (RESULTS2G), at both widths.
    ;({ ctx, page, writes } = await open(SCENES.withresults, w, h))
    await card(page).waitFor()
    const foot = page.getByTestId('by-signal-companies')
    await foot.waitFor()
    assert.equal((await foot.innerText()).trim(), '4 leads from 2 companies; 1 without a company name', `${tag}: the by-signal footnote`)
    if (process.env.SHOTS) { await foot.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(process.env.SHOTS, `home-results-1772-${tag}.png`) }) }
    assert.deepEqual(writes, []); await ctx.close()
    // 2b. #1678 (before the desktop-only scenes below, so it runs at phone width too): the step with two buttons stays readable. At phone width its text keeps the row and the buttons sit underneath it;
    // nothing is pushed off the side of the page, and the card does not scroll inside itself.
    ;({ ctx, page, writes } = await open(SCENES.pwtrial, w, h))
    await card(page).waitFor()
    const step = page.getByTestId('rc-search')
    assert.equal(await step.locator('a').count(), 2, 'two ways forward on this step')
    const text = await step.locator(':scope > div').boundingBox()
    const buttons = await step.locator('a').evaluateAll(as => as.map(a => { const r = a.getBoundingClientRect(); return { top: r.top, right: r.right } }))
    assert.ok(text.width >= 180, `${tag}: the step's title and detail have room to be read (${Math.round(text.width)}px wide)`)
    if (tag === 'mobile') for (const bt of buttons) assert.ok(bt.top >= text.y + text.height - 1, 'mobile: each button sits under the text, not beside it')
    for (const bt of buttons) assert.ok(bt.right <= w + 1, `${tag}: no button runs off the side`)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, `${tag}: no sideways scroll`)
    assert.equal(await card(page).evaluate(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1), true, `${tag}: the card does not scroll inside itself`)
    await shot(page, `password-trial-${tag}`)
    await ctx.close()
    if (tag !== 'desktop') continue
    // 3. Midway.
    ;({ ctx, page, writes } = await open(SCENES.midway, w, h))
    await card(page).waitFor()
    assert.deepEqual(await states(page), ['profile:done', 'search:done', 'play:done', 'qualified:done', 'contact:done', 'draft:todo*', 'sender:done'])
    // The qualified lead with a contact is in the OLDER search: the draft fix opens that one, not the newest (Instinct #341).
    assert.deepEqual((await fixes(page))[5], `Review leads>/app/leads?job_id=${JOBS[1].id}`)
    await shot(page, `midway-${tag}`)
    await ctx.close()
    // 3b. This month's scan allowance used up (50 of 50) with a working key: the search step says so and opens the plan.
    ;({ ctx, page, writes } = await open(SCENES.quota, w, h))
    await card(page).waitFor()
    assert.equal((await states(page))[1], 'search:todo*', 'the allowance is the next thing to act on')
    assert.match(await page.getByTestId('rc-search').innerText(), /this month's scan allowance is used up \(50 of 50\)/)
    assert.equal((await fixes(page))[1], 'See your plan>/app/settings#plan')
    await shot(page, `quota-${tag}`)
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
