// Rendered first-run check (Home onboarding + inline sender details on Outreach). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/onboarding.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Runs the real production build with a throwaway database. /api/settings/profile goes to the REAL route (and that
// temporary database); every other /api/* call is answered from a stub in the browser: no scan, no model call, no key
// check, no email. Off-host requests are aborted. It proves:
//   1. a first-run account sees the website step, and a keyless site read asks for the key inline (one field);
//   2. the site read builds the brain and opens "Your brain is ready." (no scan starts on its own); "Edit what dazl
//      inferred" opens the editable profile, filled from the read, including "what you sell";
//   3. the play step is one "Who do you want to find?" box and three one-click suggested plays, with no caveat paragraphs;
//      after Back -> Ohio changed to NYC -> continue, the plays and the sentence are the NYC ones, and ONE click on a
//      suggestion sends exactly one POST /api/scan with that sentence and the edited profile, then lands on live progress;
//   3b. every edited profile field (who buys, roles, industries, where, signals, sizes, skip) reaches that request,
//      and a sentence the user typed is kept as typed;
//   3c. the reviewed profile is saved by the real profile route: after a full reload, "Describe your business" shows
//      the same buyer, roles, industries, place, signals, sizes and skip;
//   4. Outreach asks for sender name and address inline, saves them via PUT /api/outreach/settings, and then shows them.
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
// The server runs under test/helpers/net-fence.ts, so it cannot reach any non-loopback host either.
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
let chromium
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? ' (allowed by SMOKE_ALLOW_SKIP=1)' : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
try { ({ chromium } = require('playwright')) } catch (e) { notRun(e.message.split('\n')[0]) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const Database = require('better-sqlite3'); const { createHash, randomBytes } = require('crypto')
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-onboarding-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), email_verified_at INTEGER); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt,email_verified_at) VALUES ('u1','s@example.test','x','y',1)").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'),'u1',Math.floor(Date.now()/1000)+3600)
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'),'start','-p',String(port),'-H','127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED:'0', NEWS_SEARCH_ENABLED:'0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i=0;i<100;i++){ try { await fetch(base+'/sign-in'); break } catch { await new Promise(r=>setTimeout(r,200)) } }
const calls = []; const scanBodies = []; const realProfile = []
const state = { hasKey: false, sender: null, oldFirstPlayServer: false, searchResponse: null }
const ICP = { summary: 'Independent dental practices with 2-10 chairs that are growing.', who: ['Practice owners', 'Office managers'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['Opened a new location', 'Hiring front-desk staff', 'Switched practice software'], exclude: [], language: 'en' }
const b = await chromium.launch(process.env.DAZL_UI_CHROMIUM ? { executablePath: process.env.DAZL_UI_CHROMIUM } : {}); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
await ctx.addCookies([{ name:'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method()
  if (u.origin !== base) return route.abort()
  if (!u.pathname.startsWith('/api/')) return route.continue()
  calls.push(`${m} ${u.pathname}`)
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  const p = u.pathname
  if (p === '/api/scan/jobs') return json({ jobs: [] })
  // NOT stubbed: the real profile route on the production server and its temporary SQLite database.
  if (p === '/api/settings/profile') { calls.pop(); realProfile.push(m); return route.continue() }
  if (p === '/api/usage') return json({ plan: 'free', scans_used: 0, scan_limit: 10, has_key: state.hasKey, trial: state.hasKey ? null : { funded: false, remaining: 0, cap: 3 } })
  if (p === '/api/scan/icp-from-url') return state.hasKey ? json({ icp: ICP, source: 'https://brightsmile.example/', sells: 'Online booking and reminders for dental practices' }) : json({ error: 'no_api_key' }, 400)
  if (p === '/api/settings/llm-key' && m === 'PUT') { state.hasKey = true; return json({ ok: true, vendor: 'anthropic', last4: 'abcd' }) }
  if (p === '/api/scan' && m === 'POST') {
    const body = JSON.parse(req.postData()); scanBodies.push(body)
    assert.ok(body.mode === undefined || body.mode === 'first5', 'production onboarding never posts a QA mode')
    if (body.budget) assert.equal(body.mode, 'first5', 'only an explicit first play can opt into Web Search')
    if (state.oldFirstPlayServer && Object.hasOwn(body, 'budget')) return json({ error: 'invalid_budget' }, 400)
    if (body.budget?.web_search === 'anthropic_estimated_v1') {
      if (state.searchResponse === 'no-key') return json({ error: 'qa_search_requires_own_key' }, 400)
      return json({ job_id: 'c'.repeat(24), provider_policy: 'claude_only_v1', execution: 'local_once_v1',
        ...(['confirmed','missing-target'].includes(state.searchResponse) ? { web_search_policy: 'anthropic_estimated_v1' } : {}),
        ...(state.searchResponse === 'confirmed' ? {accepted_target:{...body.icp,query:body.query,who:['Operations manager']}} : {}) }, 202)
    }
    return json({ job_id: 'c'.repeat(24) }, 202)
  }
  if (p === '/api/scan/status') return json({ status: 'running' })
  if (p === '/api/outreach/settings' && m === 'GET') return json({ gmail: { email: 'me@brightsmile.example', status: 'active', read_granted: false }, sender: state.sender, daily_cap: 20, sent_24h: 0 })
  if (p === '/api/outreach/settings' && m === 'PUT') { state.sender = JSON.parse(req.postData()); return json({ ok: true }) }
  if (p === '/api/outreach') return json({ messages: [{ id: 'm1', to_email: 'owner@dentist.example', subject: 'Your new Dublin location', body: 'Hi Dr. Lee,\n\nCongrats on opening the Dublin office...', status: 'draft', error: null, sent_at: null, send_footer: state.sender ? `${state.sender.sender_name}\n${state.sender.postal_address}\nUnsubscribe: https://dazl.ai/u/...` : null, evidence_state: 'machine', provenance: null }] })
  if (p === '/api/outreach/sequences') return json({ sequences: [], test_addresses: [], status: {}, campaigns: [] })
  return json({}, 404)
})
const page = await ctx.newPage()
const shot = async name => { await page.waitForTimeout(400); if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) }
const plays = () => page.getByRole('group', { name: 'Suggested plays' }).getByRole('button')
const sentence = () => page.getByLabel('Who do you want to find?')
const cont = async () => { await page.getByRole('button', { name: 'Looks right, continue' }).click(); await page.getByText('Who do you want to find?').waitFor() }
const back = async () => { await page.getByRole('button', { name: 'Back' }).click(); await page.getByText("Here's what we think you sell").waitFor() }
const findLeads = async () => { await page.getByRole('button', { name: 'Find leads' }).click(); await page.waitForURL(/\/app\/leads\?job_id=/) }
const PROFILE = { summary: ICP.summary, who: ICP.who, industries: ICP.industries, sizes: [], where: ['Ohio'], signals: ICP.signals, exclude: [], language: 'en' }

// Scenario 1: website -> inline key -> profile -> plays; then Back, change Ohio to NYC, continue, Find leads.
await page.goto(base + '/app', { waitUntil: 'networkidle' }); await shot('home')
await page.getByText("What's your website?").waitFor()
await page.getByLabel('Your website').fill('brightsmile.example'); await page.getByRole('button', { name: 'Read my site' }).click(); await page.getByLabel('Your AI key').waitFor(); await shot('key-needed')
assert.ok(!calls.includes('POST /api/scan'), 'nothing is scanned before Find leads')
await page.getByLabel('Your AI key').fill('sk-ant-api03-' + 'x'.repeat(30)); await page.getByRole('button', { name: 'Save key' }).click()
// The read builds the brain, saves what it inferred and opens "Your brain is ready."; the profile stays editable.
await page.getByTestId('ready-step').waitFor({ timeout: 15000 }); await shot('ready')
const registryNote = page.getByTestId('ready-step').getByTestId('optional-registry-note')
await registryNote.waitFor({state:'visible'})
assert.match(await registryNote.textContent(), /bonus evidence where available.*not checked by default or required to run a search/)

assert.ok(!calls.includes('POST /api/scan'), 'the ready screen starts nothing on its own')
await page.getByRole('button', { name: 'Edit what dazl inferred' }).click()
await page.getByText("Here's what we think you sell").waitFor(); await shot('brain')
assert.equal(await page.getByLabel('What you sell').inputValue(), 'Online booking and reminders for dental practices')
await cont(); await shot('ask')
assert.equal(await plays().count(), 3)
assert.equal(await sentence().inputValue(), '', 'the box starts empty under its three suggestions')
// One input, three plays, no caveat paragraphs on this screen (the profile summary sits behind its (i)).
assert.equal(await page.locator('form:has(#ask) p:visible').count(), 0, 'no paragraphs on the play step')
assert.equal(await page.getByText('Leads arrive on the Leads page').count(), 0)
assert.equal(await page.locator('form:has(#ask) textarea').count(), 1, 'one input')
await back()
await page.getByLabel('Where').fill('NYC')
await cont()
assert.deepEqual(await plays().allTextContents(), ['Practice owners in NYC - opened a new location', 'Office managers in NYC - hiring front-desk staff', 'Practice owners in NYC - switched practice software'])
assert.equal(await sentence().inputValue(), '', 'nothing from the old profile is kept in the box')
assert.match(await page.getByLabel('Search profile').textContent(), /in NYC/)
// One click on a suggested play starts the scan and goes straight to its live progress.
await plays().nth(1).click(); await page.waitForURL(/\/app\/leads\?job_id=/)
assert.deepEqual(scanBodies, [{ query: 'Office managers in NYC - hiring front-desk staff', icp: { ...PROFILE, where: ['NYC'] } }], 'exactly one request: the picked play and the edited profile')

// Scenario 2: every edited profile field reaches the request; a sentence the user typed survives Back/continue as typed.
scanBodies.length = 0
// Once the business is saved, Home is the journey (not the steps again); ?setup=site reopens the steps on purpose.
await page.goto(base + '/app', { waitUntil: 'networkidle' })
await page.getByTestId('journey-understanding').waitFor({ timeout: 15000 })
assert.equal(await page.getByText("What's your website?").count(), 0)
await page.goto(base + '/app?setup=site', { waitUntil: 'networkidle' })
await page.getByLabel('Your website').fill('brightsmile.example'); await page.getByRole('button', { name: 'Read my site' }).click()
await page.getByTestId('ready-step').waitFor({ timeout: 15000 }); await page.getByRole('button', { name: 'Edit what dazl inferred' }).click()
await page.getByText("Here's what we think you sell").waitFor()
await page.getByLabel('Who buys it').fill('Group dental practices opening new offices')
await page.getByLabel('Buyer roles').fill('Practice owners; COO')
await page.getByLabel('Industries').fill('Dental; Orthodontics')
await page.getByLabel('Where').fill('Austin, TX')
await page.getByLabel('Signs they need you now').fill('Opened a new location')
await page.getByLabel('Company sizes').fill('10-50 employees')
await page.getByLabel('Skip').fill('Dental schools')
await cont()
await sentence().fill('Orthodontists in Austin opening a second office')
await back(); await cont()
assert.equal(await sentence().inputValue(), 'Orthodontists in Austin opening a second office', "the user's own sentence is kept")
await findLeads()
assert.deepEqual(scanBodies, [{ query: 'Orthodontists in Austin opening a second office', icp: { summary: 'Group dental practices opening new offices', who: ['Practice owners', 'COO'], industries: ['Dental', 'Orthodontics'], sizes: ['10-50 employees'], where: ['Austin, TX'], signals: ['Opened a new location'], exclude: ['Dental schools'], language: 'en' } }])

// Scenario 3: full reload; the saved profile comes back from the real route, not from page memory.
await page.goto(base + '/app?setup=site', { waitUntil: 'networkidle' })
await page.getByText("What's your website?").waitFor()
assert.equal(await page.getByLabel('Your website').inputValue(), 'https://brightsmile.example')
await page.getByRole('button', { name: 'No website? Describe your business yourself' }).click()
await page.getByText("Here's what we think you sell").waitFor()
const val = l => page.getByLabel(l).inputValue()
assert.deepEqual({ sells: await val('What you sell'), who: await val('Who buys it'), roles: await val('Buyer roles'), industries: await val('Industries'), where: await val('Where'), signals: await val('Signs they need you now'), sizes: await val('Company sizes'), skip: await val('Skip') },
  { sells: 'Online booking and reminders for dental practices', who: 'Group dental practices opening new offices', roles: 'Practice owners; COO', industries: 'Dental; Orthodontics', where: 'Austin, TX', signals: 'Opened a new location', sizes: '10-50 employees', skip: 'Dental schools' })
assert.ok(realProfile.includes('POST') && realProfile.filter(m => m === 'GET').length >= 3, 'the profile went through the real route')
// Claude Web Search is an additional, per-play opt-in; nothing starts by checking it or following a refusal.
await page.goto(base + '/app?setup=brain', { waitUntil: 'networkidle' })
await cont()
await sentence().fill('Oxford accounting practices recruiting an office manager')
const optIn = page.getByTestId('claude-search-opt-in')
const startSearch = page.getByRole('button', { name: 'Find leads' })
await optIn.waitFor()
assert.equal(await optIn.isChecked(), false)
scanBodies.length = 0
await optIn.check()
assert.equal(scanBodies.length, 0)
await page.getByText(/actual Anthropic charges can vary/).waitFor()
const review = page.getByRole('region', {name:'Review targets for this search'})
const openReview = async () => {
  await startSearch.click()
  await review.waitFor({state:'visible'})
}
const submitReviewed = async () => {
  await openReview()
  await review.getByRole('button',{name:'Confirm targets and find leads'}).click()
}
const profileWritesBefore = realProfile.filter(m => m === 'POST').length
const preflightsBefore = calls.filter(m => m === 'POST /api/scan/icp').length
await openReview()
assert.match(await review.getByLabel('Unchanged search criteria').textContent(), /Exclude: Dental schools/)
await review.getByLabel('Locations').fill('Durham, England')
await review.getByLabel('Search request').fill('Canceled query for Durham')
await review.getByRole('button',{name:'Cancel',exact:true}).click()
assert.equal(scanBodies.length,0,'cancel never starts a search')
await openReview()
assert.equal(await review.getByLabel('Locations').inputValue(),'Austin, TX','canceled fields were not saved')
assert.equal(await review.getByLabel('Search request').inputValue(),'Oxford accounting practices recruiting an office manager')
await review.getByLabel('Locations').fill('')
await review.getByRole('button',{name:'Confirm targets and find leads'}).click()
assert.equal(scanBodies.length,0,'clearing a constraint never submits a broader search')
await review.getByRole('button',{name:'Cancel',exact:true}).click()
state.oldFirstPlayServer = true
await submitReviewed()
await page.getByRole('alert').filter({ hasText: 'does not support Claude Web Search' }).waitFor()
assert.equal(scanBodies.length, 1, 'older server refuses, without starting or retrying an ordinary scan')
state.oldFirstPlayServer = false
await optIn.check()
state.searchResponse = 'no-key'
await submitReviewed()
await page.getByRole('alert').filter({ hasText: 'cannot use the free trial' }).waitFor()
assert.equal(await optIn.isChecked(), false)
assert.equal(scanBodies.length, 2, 'key refusal does not submit a fallback')
assert.deepEqual(scanBodies[1].budget, { web_search: 'anthropic_estimated_v1',target_review:'manual_v1' })
state.searchResponse = 'missing-policy'
await optIn.check()
await openReview()
await review.getByLabel('Buyer description').fill('Local accountancy practices')
await review.getByLabel('Buyer roles').fill('Practice managers')
await review.getByLabel('Locations').fill('Oxford, England')
await review.getByLabel('Country restriction', {exact:false}).fill('GB')
await review.getByLabel('Industries').fill('Accounting')
await review.getByLabel('Buying signals').fill('Hiring an office manager')
await review.getByRole('button',{name:'Confirm targets and find leads'}).click()
await page.getByRole('alert').filter({ hasText: 'did not confirm the Claude Web Search policy' }).waitFor()
assert.equal(scanBodies.length, 3, 'incomplete success never redirects or retries')
assert.equal(await page.getByTestId('ready-step').count(), 0)
state.searchResponse = 'missing-target'
await optIn.check()
await openReview()
const pageLanguage = review.getByLabel('Page language', {exact:false})
assert.equal(await pageLanguage.inputValue(),'en')
await pageLanguage.fill('')
await review.getByRole('button',{name:'Confirm targets and find leads'}).click()
await page.getByRole('alert').filter({hasText:'Could not verify the accepted target'}).waitFor()
assert.equal(Object.hasOwn(scanBodies.at(-1).icp,'language'),false,'explicitly clearing does not carry saved language')
assert.equal(await page.getByTestId('ready-step').count(),0,'a successful response without target cannot display raw state')
state.searchResponse = 'confirmed'
await sentence().fill('Find machine shops in Oxford installing new equipment')
await optIn.check()
await openReview()
assert.equal(await review.getByLabel('Locations').inputValue(),'Austin, TX','a prior play never rewrote the saved draft')
assert.equal(await review.getByLabel('Search request').inputValue(),'Find machine shops in Oxford installing new equipment')
await review.getByLabel('Search request').fill('Find machine shops in Wellington installing new equipment')
await review.getByLabel('Buyer description').fill('Local machine shops')
await review.getByLabel('Buyer roles').fill('Operations managers')
await review.getByLabel('Locations').fill('Wellington, New Zealand')
await review.getByLabel('Country restriction', {exact:false}).fill('NZ')
assert.equal(await pageLanguage.inputValue(),'en','the previous play never changed the saved language')
await pageLanguage.fill('mi')
await review.getByLabel('Industries').fill('Metalworking')
await review.getByLabel('Buying signals').fill('Installing new equipment')
await review.getByRole('button',{name:'Confirm targets and find leads'}).click()
await page.getByTestId('ready-step').waitFor()
const target = await page.getByTestId('first-submitted-target').textContent()
for (const value of ['Search request: Find machine shops in Wellington installing new equipment','Local machine shops','Operations manager','Wellington, New Zealand','NZ','Metalworking','Installing new equipment']) assert.ok(target.includes(value),value)
assert.doesNotMatch(target,/Oxford|Operations managers/,'display uses effective receipt, not original query or raw roles')
assert.equal(scanBodies.at(-1).query,'Find machine shops in Wellington installing new equipment')
assert.equal(scanBodies.at(-1).icp.language,'mi')
assert.match(target,/Page language:\s*mi\b/)
assert.deepEqual(scanBodies.map(({ mode, budget }) => ({ mode, budget })), Array(5).fill({ mode: 'first5', budget: { web_search: 'anthropic_estimated_v1',target_review:'manual_v1' } }))
assert.deepEqual([scanBodies[2],scanBodies[4]].map(({icp})=>[icp.where,icp.country,icp.industries,icp.signals,icp.exclude]),[
  [['Oxford, England'],'GB',['Accounting'],['Hiring an office manager'],['Dental schools']],
  [['Wellington, New Zealand'],'NZ',['Metalworking'],['Installing new equipment'],['Dental schools']],
])
assert.equal(realProfile.filter(m => m === 'POST').length, profileWritesBefore)
assert.equal(calls.filter(m => m === 'POST /api/scan/icp').length, preflightsBefore)


await page.goto(base + '/app/outreach', { waitUntil: 'networkidle' }); await shot('outreach')
{
  await page.getByPlaceholder('Your name, as recipients will see it').fill('Dana Smith'); await page.getByPlaceholder(/Mailing address/).fill('1 Main St, Columbus, OH 43004, USA')
  await page.getByRole('button', { name: 'Save sender details' }).click(); await page.getByText(/Ready to send from/).waitFor(); await shot('outreach-after-sender')
}
assert.deepEqual(state.sender, { sender_name: 'Dana Smith', postal_address: '1 Main St, Columbus, OH 43004, USA', booking_url: '' })
await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
console.log('onboarding UI check passed:', calls.filter(c => !c.startsWith('GET')).join(', '), '| real profile route:', realProfile.join(', '))
