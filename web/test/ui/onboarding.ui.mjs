// Rendered first-run check (Home onboarding + inline sender details on Outreach). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/onboarding.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Runs the real production build with a throwaway database and ANSWERS EVERY /api/* CALL FROM A STUB in the browser:
// no scan, no model call, no key check, no email. Off-host requests are aborted. It proves:
//   1. a first-run account sees the website step, and a keyless site read asks for the key inline (one field);
//   2. the editable profile is filled from the site read, including "what you sell";
//   3. three suggested plays are shown; the chosen one is sent as the only POST /api/scan, which lands on Leads;
//   4. Outreach asks for sender name and address inline, saves them via PUT /api/outreach/settings, and then shows them.
// Exit 1 on a failed expectation; exit 0 with "SKIP" when playwright or the build is missing.
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
try { ({ chromium } = require('playwright')) } catch (e) { console.log(`SKIP: ${e.message.split('\n')[0]}`); process.exit(0) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) { console.log('SKIP: no production build (run npm run build first)'); process.exit(0) }
const Database = require('better-sqlite3'); const { createHash, randomBytes } = require('crypto')
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-onboarding-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'),'u1',Math.floor(Date.now()/1000)+3600)
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'),'start','-p',String(port),'-H','127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED:'0', NEWS_SEARCH_ENABLED:'0' }, stdio: 'ignore' })
for (let i=0;i<100;i++){ try { await fetch(base+'/sign-in'); break } catch { await new Promise(r=>setTimeout(r,200)) } }
const calls = []; const scanBodies = []
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
  if (p === '/api/settings/profile' && m === 'GET') return json({ sells: '', website: '', business_name: '' })
  if (p === '/api/settings/profile') return json({ ok: true, ...JSON.parse(req.postData()) })
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
await page.goto(base + '/app', { waitUntil: 'networkidle' }); await shot('home')
await page.getByText("What's your website?").waitFor()
{
  await page.getByLabel('Your website').fill('brightsmile.example'); await page.getByRole('button', { name: 'Read my site' }).click(); await page.getByLabel('Your AI key').waitFor(); await shot('key-needed')
  assert.ok(!calls.includes('POST /api/scan'), 'nothing is scanned before Find leads')
  await page.getByLabel('Your AI key').fill('sk-ant-api03-' + 'x'.repeat(30)); await page.getByRole('button', { name: 'Save key' }).click()
  await page.getByText("Here's what we think you sell").waitFor(); await shot('brain')
  assert.equal(await page.getByLabel('What you sell').inputValue(), 'Online booking and reminders for dental practices')
  await page.getByRole('button', { name: 'Looks right, continue' }).click(); await page.getByText('Who do you want to reach?').waitFor(); await shot('ask')
  assert.equal(await page.getByRole('group', { name: 'Suggested plays' }).getByRole('button').count(), 3)
  await page.getByRole('group', { name: 'Suggested plays' }).getByRole('button').nth(1).click()
  const asked = await page.getByLabel('Who do you want to reach').inputValue()
  await page.getByRole('button', { name: 'Find leads' }).click(); await page.waitForURL(/\/app\/leads\?job_id=/)
  assert.equal(asked, 'Office managers in Ohio - hiring front-desk staff')
  assert.equal(calls.filter(c => c === 'POST /api/scan').length, 1, 'exactly one scan request')
  assert.deepEqual(scanBodies, [{ query: asked }], 'the scan gets the chosen sentence only')
}
await page.goto(base + '/app/outreach', { waitUntil: 'networkidle' }); await shot('outreach')
{
  await page.getByPlaceholder('Your name, as recipients will see it').fill('Dana Smith'); await page.getByPlaceholder(/Mailing address/).fill('1 Main St, Columbus, OH 43004, USA')
  await page.getByRole('button', { name: 'Save sender details' }).click(); await page.getByText(/Ready to send from/).waitFor(); await shot('outreach-after-sender')
}
assert.deepEqual(state.sender, { sender_name: 'Dana Smith', postal_address: '1 Main St, Columbus, OH 43004, USA', booking_url: '' })
await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
console.log('onboarding UI check passed:', calls.filter(c => !c.startsWith('GET')).join(', '))
