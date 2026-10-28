// Home's "Before your play runs" card with realistic seeded tenant data. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/ready-card.ui.mjs   (SHOTS=<dir> saves desktop and 390px screenshots)
// Production build, throwaway database, server under test/helpers/net-fence.ts, EVERY /api/* call stubbed in the browser:
// no scan, no send. It proves:
//   1. new tenant (website saved, no brain, no key, Gmail not connected): 0 of 4 ready; each missing item has exactly one
//      button straight to its fix (Build brain -> /app?setup=brain, Add key -> Settings#model-key, Connect ->
//      Settings#gmail); sources say none can run until the key works and name nothing;
//   2. midway (brain + key, Gmail not connected): 3 of 4; sources name only what can run here (the operator-off web index
//      and the unconsented Reddit are not named); the Gmail button opens Settings at Gmail;
//   3. Gmail settings unreadable: that item is "could not check" with no button, and the card stays;
//   4. everything ready: no card;
//   5. the card is above the journey, uses no primary button, writes nothing, no horizontal scroll at 390px.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-readycard-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const PROFILE = { business_name: 'Brightsmile', sells: 'Online booking and reminders for dental practices', website: 'https://brightsmile.example', buyer: { summary: 'Independent dental practices with 2-10 chairs that are expanding', who: ['Practice owner', 'Office manager'], industries: ['Dental'], sizes: ['2-10 chairs'], where: ['Brooklyn', 'Queens'], signals: ['new location'], exclude: ['DSOs'] } }
const GMAIL = { email: 'dana@brightsmile.example', status: 'active' }
const SCENES = {
  fresh: { profile: { ...PROFILE, buyer: null }, key: false, gmail: null },
  midway: { profile: PROFILE, key: true, gmail: null },
  gmailfail: { profile: PROFILE, key: true, gmail: 'fail' },
  ready: { profile: PROFILE, key: true, gmail: GMAIL },
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
    if (p === '/api/scan/jobs') return json({ jobs: [], totals: { searches: 0, finished: 0 } })
    if (p === '/api/scan/latest') return json({ query: null, icp: null, icp_source: null })
    if (p === '/api/leads') return json({ leads: [], hidden_count: 0 })
    if (p === '/api/watch') return json({ watches: [] })
    if (p === '/api/usage') return json({ plan: 'free', scans_used: 0, scan_limit: 50, has_key: sc.key, trial: null })
    if (p === '/api/settings/llm-key') return json({ keys: sc.key ? [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1 }] : [], rejection: null })
    if (p === '/api/settings/advanced') return json({ available: true, version: '1', platforms: [{ platform: 'reddit', allowed: true, consent: false, connected: false, enabled: false }] })
    if (p === '/api/scan/sources') return json({ web_index: false, news: true, websites: true })
    if (p === '/api/outreach/settings') return sc.gmail === 'fail' ? json({ error: 'boom' }, 500) : json({ gmail: sc.gmail, sender: { sender_name: 'Dana Smith', postal_address: '1 Main St, Brooklyn NY' }, daily_cap: 20, sent_24h: 0, account_sent_24h: 0, read_notice: [] })
    if (p === '/api/outreach') return json({ messages: [] })
    if (p === '/api/campaigns') return json({ campaigns: [] })
    return json({}, 404)
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
  await page.getByTestId('journey').waitFor({ timeout: 15000 }); await page.waitForLoadState('networkidle')
  return { ctx, page, writes }
}
const card = page => page.getByTestId('ready-card')
const states = page => card(page).locator('li').evaluateAll(ls => ls.map(l => `${l.dataset.testid.slice(3)}:${l.dataset.rcState}`))
const fixes = page => card(page).locator('li').evaluateAll(ls => ls.map(l => [...l.querySelectorAll('a,button')].map(a => `${a.textContent}>${a.getAttribute('href')}`)))
const shot = async (page, name) => { if (process.env.SHOTS) { await page.waitForTimeout(300); await card(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) } }
try {
  for (const [w, h, tag] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
    // 1. New tenant.
    let { ctx, page, writes } = await open(SCENES.fresh, w, h)
    await card(page).waitFor()
    assert.deepEqual(await states(page), ['brain:todo', 'key:todo', 'gmail:todo', 'sources:todo'])
    assert.equal(await page.getByTestId('rc-progress').textContent(), '0 of 4 ready')
    assert.deepEqual(await fixes(page), [['Build brain>/app?setup=brain'], ['Add key>/app/settings#model-key'], ['Connect>/app/settings#gmail'], ['Add key>/app/settings#model-key']], 'one button per missing item, straight to its fix')
    assert.match(await page.getByTestId('rc-sources').innerText(), /none can run until your AI key works/)
    assert.equal(await card(page).locator('.btn-primary').count(), 0, 'Home keeps one primary action')
    const yCard = (await card(page).boundingBox()).y, yJourney = (await page.getByTestId('journey').boundingBox()).y
    assert.ok(yCard < yJourney, 'the card sits above the journey')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll (${tag})`)
    await shot(page, `new-${tag}`)
    assert.deepEqual(writes, []); await ctx.close()
    // 2. Midway.
    ;({ ctx, page, writes } = await open(SCENES.midway, w, h))
    await card(page).waitFor()
    assert.deepEqual(await states(page), ['brain:done', 'key:done', 'gmail:todo', 'sources:done'])
    assert.equal(await page.getByTestId('rc-progress').textContent(), '3 of 4 ready')
    assert.match(await page.getByTestId('rc-sources').innerText(), /3 available: Web research with your AI key, News articles, Company websites/)
    assert.doesNotMatch(await card(page).innerText(), /Web search index|Reddit/, 'sources that cannot run are not shown as available')
    assert.deepEqual(await fixes(page), [[], [], ['Connect>/app/settings#gmail'], []])
    await shot(page, `midway-${tag}`)
    if (tag === 'desktop') {
      await page.getByTestId('rc-gmail').getByRole('link', { name: 'Connect' }).click()
      await page.waitForURL('**/app/settings#gmail')
    }
    assert.deepEqual(writes, []); await ctx.close()
    if (tag !== 'desktop') continue
    // 3. Gmail settings unreadable.
    ;({ ctx, page, writes } = await open(SCENES.gmailfail, w, h))
    await card(page).waitFor()
    assert.equal((await states(page))[2], 'gmail:unknown')
    assert.match(await page.getByTestId('rc-gmail').innerText(), /could not check/)
    assert.deepEqual((await fixes(page))[2], [], 'nothing to press for a check that failed')
    await ctx.close()
    // 4. All ready: no card.
    ;({ ctx, page, writes } = await open(SCENES.ready, w, h))
    await page.waitForTimeout(800)
    assert.equal(await card(page).count(), 0, 'gone once everything is ready')
    assert.deepEqual(writes, []); await ctx.close()
  }
  console.log('ready card UI check passed: 4 items from tenant state, one fix button each (brain, key, Gmail, sources), only usable sources named, could-not-check has no button, hidden when all ready; above the journey, no primary button, no writes, no horizontal scroll at 390px')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
