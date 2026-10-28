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
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(dir, 'package.json'))
let chromium
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? ' (allowed by SMOKE_ALLOW_SKIP=1)' : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
try { ({ chromium } = require('playwright')) } catch (e) { notRun(e.message.split('\n')[0]) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const Database = require('better-sqlite3'); const { createHash, randomBytes } = require('crypto')
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-onboarding-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'),'u1',Math.floor(Date.now()/1000)+3600)
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'),'start','-p',String(port),'-H','127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED:'0', NEWS_SEARCH_ENABLED:'0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i=0;i<100;i++){ try { await fetch(base+'/sign-in'); break } catch { await new Promise(r=>setTimeout(r,200)) } }
const calls = []; const scanBodies = []; const realProfile = []
const state = { hasKey: false, sender: null }
const ICP = { summary: 'Independent dental practices with 2-10 chairs that are growing.', who: ['Practice owners', 'Office managers'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['Opened a new location', 'Hiring front-desk staff', 'Switched practice software'], exclude: [] }
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
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
  if (p === '/api/scan' && m === 'POST') { scanBodies.push(JSON.parse(req.postData())); return json({ job_id: 'c'.repeat(24) }, 202) }
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
const PROFILE = { summary: ICP.summary, who: ICP.who, industries: ICP.industries, sizes: [], where: ['Ohio'], signals: ICP.signals, exclude: [] }

// Scenario 1: website -> inline key -> profile -> plays; then Back, change Ohio to NYC, continue, Find leads.
await page.goto(base + '/app', { waitUntil: 'networkidle' }); await shot('home')
await page.getByText("What's your website?").waitFor()
await page.getByLabel('Your website').fill('brightsmile.example'); await page.getByRole('button', { name: 'Read my site' }).click(); await page.getByLabel('Your AI key').waitFor(); await shot('key-needed')
assert.ok(!calls.includes('POST /api/scan'), 'nothing is scanned before Find leads')
await page.getByLabel('Your AI key').fill('sk-ant-api03-' + 'x'.repeat(30)); await page.getByRole('button', { name: 'Save key' }).click()
// The read builds the brain, saves what it inferred and opens "Your brain is ready."; the profile stays editable.
await page.getByTestId('ready-step').waitFor({ timeout: 15000 }); await shot('ready')
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
assert.deepEqual(scanBodies, [{ query: 'Orthodontists in Austin opening a second office', icp: { summary: 'Group dental practices opening new offices', who: ['Practice owners', 'COO'], industries: ['Dental', 'Orthodontics'], sizes: ['10-50 employees'], where: ['Austin, TX'], signals: ['Opened a new location'], exclude: ['Dental schools'] } }])

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
await page.goto(base + '/app/outreach', { waitUntil: 'networkidle' }); await shot('outreach')
{
  await page.getByPlaceholder('Your name, as recipients will see it').fill('Dana Smith'); await page.getByPlaceholder(/Mailing address/).fill('1 Main St, Columbus, OH 43004, USA')
  await page.getByRole('button', { name: 'Save sender details' }).click(); await page.getByText(/Ready to send from/).waitFor(); await shot('outreach-after-sender')
}
assert.deepEqual(state.sender, { sender_name: 'Dana Smith', postal_address: '1 Main St, Columbus, OH 43004, USA', booking_url: '' })
await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
console.log('onboarding UI check passed:', calls.filter(c => !c.startsWith('GET')).join(', '), '| real profile route:', realProfile.join(', '))
