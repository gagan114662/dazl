// #1043 rendered check: "Your business" on the REAL production build and CSS, with a session and every /api/* call answered
// from a stub (no scan, no provider call). It proves, at 1280 and 390 px:
//   1. the nav has "Your business"; the page shows each section from the stored profile, Memory and Competitors;
//   2. a source-backed item links to its page ("from your site: ..."); a flat profile field says "saved in your profile";
//      an empty section says "dazl did not find this";
//   3. editing the profile POSTs the changed field and KEEPS the stored research block;
//   4. a suggested play opens Leads with the search filled in and starts nothing (no POST /api/scan);
//   5. no horizontal scroll.
// NOT part of `npm test`. Run:  cd web && npm run build && node test/ui/business-1043.ui.mjs   (SHOTS=<dir> saves screenshots)
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-business-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), email_verified_at INTEGER); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt,email_verified_at) VALUES ('u1','s@example.test','x','y',1)").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
// a port nothing else is listening on (a random one can land on a server an earlier CI step is still shutting down)
const { createServer } = await import('node:net')
const free = p => new Promise(ok => { const t = createServer().once('error', () => ok(false)).once('listening', () => t.close(() => ok(true))); t.listen(p, '127.0.0.1') })
let port = pickUiPort(); for (let i = 0; i < 50 && !(await free(port)); i++) port = pickUiPort()
const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
// wait until OUR server answers (and has not exited); fail with the reason instead of a refused page load
let up = false
for (let i = 0; i < 300 && srv.exitCode === null; i++) { try { await fetch(base + '/sign-in'); up = srv.exitCode === null; if (up) break } catch { /* not up yet */ } await new Promise(r => setTimeout(r, 200)) }
if (!up) { srv.kill(); rmSync(tmp, { recursive: true, force: true }); throw new Error(`the production server on ${base} did not come up (exit code ${srv.exitCode})`) }


const research = { v: 1, site: 'https://brightsmile.example', offers: [{ i: 'o1', n: 'Online booking' }], q: null, ans: null, hyps: [
  { i: 'h1', o: 'o1', k: 'persona', t: 'Office manager', s: 'sourced', u: 'https://brightsmile.example/for-practices', q: 'built for office managers', at: 1 }] }
const buyer = { summary: 'Independent dental practices', who: ['Practice owner'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['opened a new location', 'hiring a front desk coordinator'], exclude: [], research }
const b = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {})
const out = []
try {
  for (const width of [1280, 390]) {
    const ctx = await b.newContext({ viewport: { width, height: 900 } })
    await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
    const posts = []
    await ctx.route('**/*', async route => {
      const req = route.request(); const u = new URL(req.url()); const p = u.pathname; const m = req.method()
      if (u.origin !== base) return route.abort()
      if (!p.startsWith('/api/')) return route.continue()
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (m !== 'GET') posts.push({ m, p, body: req.postDataJSON?.() ?? null })
      if (p === '/api/settings/profile' && m === 'POST') return json({ ok: true })
      if (p === '/api/settings/profile') return json({ business_name: 'Bright Smile', sells: 'Online booking for dental practices', website: 'https://brightsmile.example', buyer, new_play_offer: null })
      if (p === '/api/settings/memory') return json({ memory: { icp: '', positioning: '', tone: '', exclusions: [], objections: [] } })
      if (p === '/api/settings/competitors') return json({ competitors: ['Zocdoc'] })
      if (p === '/api/scan/jobs') return json({ jobs: [] })
      if (p === '/api/scan/latest') return json({ query: 'An older dental play', icp: { summary: 'OLD REVIEWED PROFILE', who: ['Old role'], industries: [], sizes: [], where: [], signals: [], exclude: [] }, icp_source: 'user' })
      if (p === '/api/scan/estimate') return json({ error: 'stub: estimate not needed' }, 400)
      if (p === '/api/usage') return json({ plan: 'free', scans_used: 0, scan_limit: 10, has_key: true, trial: null })
      return json({}, 404)
    })
    const page = await ctx.newPage()
    await page.goto(base + '/app/business', { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: 'Your business', level: 1 }).waitFor({ timeout: 20000 })
    // 1. nav + sections
    if (width >= 1024) assert.ok(await page.getByRole('link', { name: 'Your business' }).first().isVisible(), 'the nav has Your business')
    for (const id of ['company', 'customer', 'roles', 'signals', 'competitors', 'objections', 'voice']) assert.ok(await page.getByTestId(`section-${id}`).isVisible(), `${width}: section ${id}`)
    // 2. provenance and empty sections
    const roles = page.getByTestId('section-roles')
    assert.match(await roles.textContent(), /Role: Practice ownersaved in your profile/)
    const siteLink = roles.getByRole('link', { name: 'from your site: brightsmile.example/for-practices' })
    assert.equal(await siteLink.getAttribute('href'), 'https://brightsmile.example/for-practices')
    assert.match(await page.getByTestId('section-voice').textContent(), /dazl did not find this/)
    assert.match(await page.getByTestId('section-objections').textContent(), /dazl did not find this/)
    assert.match(await page.getByTestId('section-competitors').textContent(), /Zocdoc/)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}: no horizontal scroll`)
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `business-${width}.png`), fullPage: true })
    // 3. edit the buyer roles: the POST carries the change and keeps the research block
    await roles.getByRole('button', { name: 'Edit Buyer roles' }).click()
    const who = roles.getByRole('textbox', { name: 'Buyer roles (one per line)' })
    await who.fill('Practice owner\nOffice manager')
    await roles.getByRole('button', { name: 'Save' }).click()
    await roles.getByRole('status').filter({ hasText: 'Saved' }).waitFor({ timeout: 10000 })
    const save = posts.find(x => x.p === '/api/settings/profile' && x.m === 'POST')
    assert.deepEqual(save?.body?.buyer?.who, ['Practice owner', 'Office manager'])
    assert.deepEqual(save?.body?.buyer?.research, research, 'the stored research is kept')
    // 4. a play opens Leads with the search filled in and starts nothing
    const play = page.getByTestId('play').first()
    const q = (await play.textContent()).trim()
    const before = posts.length
    await play.click()
    await page.waitForURL(/\/app\/leads\?q=.*&fresh=1/, { timeout: 20000 })
    await page.waitForFunction(v => document.querySelector('#play')?.value === v, q, { timeout: 20000 }).catch(() => {})
    assert.equal(await page.locator('#play').inputValue(), q, 'Leads opens with the play filled in')
    await page.waitForTimeout(500)
    assert.deepEqual(posts.slice(before).filter(x => x.m !== 'GET'), [], 'opening the play writes nothing and starts nothing (no scan, estimate or profile call)')
    // pressing Find leads for the play: the estimate is asked with the play's own sentence, never the older reviewed profile
    await page.getByRole('button', { name: /Find leads/ }).first().click()
    await page.waitForTimeout(800)
    const est = posts.slice(before).find(x => x.p === '/api/scan/estimate')
    assert.ok(est, 'Find leads asked for the estimate')
    assert.equal(est.body.query, q)
    assert.notEqual(est.body.icp?.summary, 'OLD REVIEWED PROFILE', 'the older reviewed play profile is not carried onto the new sentence')
    // every OTHER ?q= link (Home's widen/recover paths) still carries the reviewed profile, as before
    if (width === 1280) {
      const mark = posts.length
      await page.goto(`${base}/app/leads?q=${encodeURIComponent('An older dental play')}`, { waitUntil: 'networkidle' })
      await page.waitForFunction(v => document.querySelector('#play')?.value === v, 'An older dental play', { timeout: 20000 })
      await page.getByRole('button', { name: /Find leads/ }).first().click()
      await page.waitForTimeout(800)
      const est2 = posts.slice(mark).find(x => x.p === '/api/scan/estimate')
      assert.equal(est2?.body?.icp?.summary, 'OLD REVIEWED PROFILE', 'a plain ?q= link keeps carrying the reviewed profile')
    }
    out.push(`${width}: 7 sections, site link, empty sections, save keeps research, play prefilled "${q}"`)
    await ctx.close()
  }
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
    await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
    const writes = []
    await ctx.route('**/*', async route => {
      const req = route.request(); const u = new URL(req.url()); const p = u.pathname
      if (u.origin !== base) return route.abort()
      if (!p.startsWith('/api/')) return route.continue()
      if (req.method() !== 'GET') writes.push(p)
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (p === '/api/settings/profile' || p === '/api/settings/memory') return json({ error: 'unavailable' }, 500)
      if (p === '/api/settings/competitors') return json({})   // 200 without its key: a failed read, never "empty"
      return json({}, 404)
    })
    const page = await ctx.newPage()
    await page.goto(base + '/app/business', { waitUntil: 'networkidle' })
    await page.getByTestId('load-failed').waitFor({ timeout: 20000 })
    assert.match(await page.getByTestId('no-plays').textContent(), /Could not load your profile/)
    for (const id of ['company', 'customer', 'roles', 'signals']) {
      const sec = page.getByTestId(`section-${id}`)
      assert.match(await sec.textContent(), /Could not load your profile/); assert.doesNotMatch(await sec.textContent(), /dazl did not find this/)
      assert.equal(await sec.getByRole('button', { name: /^Edit / }).count(), 0, `${id}: no editor from a profile that did not load`)
    }
    assert.match(await page.getByTestId('section-voice').textContent(), /Could not load Memory/)
    assert.doesNotMatch(await page.getByTestId('section-voice').textContent(), /dazl did not find this/)
    assert.match(await page.getByTestId('section-competitors').textContent(), /Could not load Competitors/)
    for (const id of ['competitors', 'voice', 'objections']) assert.equal(await page.getByTestId(`section-${id}`).getByRole('button', { name: /^Edit / }).count(), 0, `${id}: no editor over a source that did not load`)
    assert.doesNotMatch(await page.getByTestId('section-competitors').textContent(), /dazl did not find this/)
    assert.deepEqual(writes, [])
    out.push('failed reads: "Could not load", no profile editor')
    await ctx.close()
  }
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
    await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
    let profileGets = 0; const writes = []
    await ctx.route('**/*', async route => {
      const req = route.request(); const u = new URL(req.url()); const p = u.pathname; const m = req.method()
      if (u.origin !== base) return route.abort()
      if (!p.startsWith('/api/')) return route.continue()
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (m !== 'GET') { writes.push(p); return json({ ok: true, buyer }) }
      if (p === '/api/settings/profile') return ++profileGets === 1 ? json({ business_name: 'Bright Smile', sells: 'Online booking', website: 'https://brightsmile.example', buyer, new_play_offer: null }) : json({ error: 'unavailable' }, 500)
      if (p === '/api/settings/memory') return json({ memory: { icp: '', positioning: '', tone: '', exclusions: [], objections: [] } })
      if (p === '/api/settings/competitors') return json({ competitors: [] })
      return json({}, 404)
    })
    const page = await ctx.newPage()
    await page.goto(base + '/app/business', { waitUntil: 'networkidle' })
    const company = page.getByTestId('section-company')
    await company.getByRole('button', { name: 'Edit Company & offer' }).click()
    await company.getByRole('button', { name: 'Save' }).click()
    await company.getByText(/Could not load your profile/).waitFor({ timeout: 10000 })   // the reload after the save failed
    assert.equal(await page.locator('#edit-company').count(), 0, 'no editor over a profile that did not reload')
    assert.equal(writes.length, 1, 'only the one save; nothing posted from a blank form')
    out.push('a failed reload after a save removes the editor')
    await ctx.close()
  }
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
    await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
    const writes = []
    await ctx.route('**/*', async route => {
      const req = route.request(); const u = new URL(req.url()); const p = u.pathname
      if (u.origin !== base) return route.abort()
      if (!p.startsWith('/api/')) return route.continue()
      if (req.method() !== 'GET') writes.push(p)
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (p === '/api/settings/profile') return json({})   // 200 without the profile: a failed read, never a blank profile to save over
      if (p === '/api/settings/memory') return json({ memory: { icp: '', positioning: '', tone: '', exclusions: [], objections: [] } })
      if (p === '/api/settings/competitors') return json({ competitors: [] })
      return json({}, 404)
    })
    const page = await ctx.newPage()
    await page.goto(base + '/app/business', { waitUntil: 'networkidle' })
    await page.getByTestId('load-failed').waitFor({ timeout: 20000 })
    assert.equal(await page.getByTestId('section-company').getByRole('button', { name: /^Edit / }).count(), 0)
    assert.match(await page.getByTestId('section-company').textContent(), /Could not load your profile/)
    assert.deepEqual(writes, [])
    out.push('a 200 without the profile is a failed read')
    await ctx.close()
  }
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
    await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
    await ctx.route('**/*', async route => {
      const req = route.request(); const u = new URL(req.url()); const p = u.pathname
      if (u.origin !== base) return route.abort()
      if (!p.startsWith('/api/')) return route.continue()
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (p === '/api/settings/profile') return json({ business_name: 'NewCo', sells: '', website: null, buyer: null, new_play_offer: null })
      if (p === '/api/settings/memory') return json({ memory: null })   // what the route sends when nothing is saved yet
      if (p === '/api/settings/competitors') return json({ competitors: [] })
      return json({}, 404)
    })
    const page = await ctx.newPage()
    await page.goto(base + '/app/business', { waitUntil: 'networkidle' })
    await page.getByTestId('section-voice').waitFor({ timeout: 20000 })
    assert.equal(await page.getByTestId('load-failed').count(), 0, 'a new workspace with no Memory is not a failed read')
    assert.match(await page.getByTestId('section-voice').textContent(), /dazl did not find this/)
    assert.equal(await page.getByTestId('section-voice').getByRole('button', { name: 'Edit Voice' }).count(), 1)
    out.push('a new workspace (memory: null) reads as empty, editable')
    await ctx.close()
  }
  {
    // the page's own reads succeed; the editor's own read (a second request when Edit opens) fails: no blank form to save
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
    await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
    const writes = []; const gets = { memory: 0, competitors: 0 }
    await ctx.route('**/*', async route => {
      const req = route.request(); const u = new URL(req.url()); const p = u.pathname
      if (u.origin !== base) return route.abort()
      if (!p.startsWith('/api/')) return route.continue()
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (req.method() !== 'GET') { writes.push(p); return json({ ok: true }) }
      if (p === '/api/settings/profile') return json({ business_name: 'Bright Smile', sells: 'Online booking', website: null, buyer: null, new_play_offer: null })
      if (p === '/api/settings/memory') return ++gets.memory === 1 ? json({ memory: { icp: '', positioning: '', tone: 'Plain', exclusions: [], objections: [] } }) : json({ error: 'unavailable' }, 500)
      if (p === '/api/settings/competitors') return ++gets.competitors === 1 ? json({ competitors: ['Zocdoc'] }) : json({ error: 'unavailable' }, 500)
      return json({}, 404)
    })
    const page = await ctx.newPage()
    await page.goto(base + '/app/business', { waitUntil: 'networkidle' })
    await page.getByTestId('section-voice').getByRole('button', { name: 'Edit Voice' }).click()
    await page.getByTestId('memory-unread').waitFor({ timeout: 10000 })
    assert.equal(await page.getByTestId('section-voice').getByRole('button', { name: /Save/ }).count(), 0, 'no Memory form to save after its own read failed')
    // switching straight to another editor (one open at a time) - 'Done' would reload the page data, which this stub fails
    await page.getByTestId('section-competitors').getByRole('button', { name: 'Edit Competitors' }).click()
    await page.getByTestId('competitors-unread').waitFor({ timeout: 10000 })
    assert.equal(await page.getByTestId('section-competitors').getByRole('button', { name: /Save/ }).count(), 0, 'no Competitors form to save after its own read failed')
    assert.deepEqual(writes, [])
    out.push("an editor whose own read fails offers no form")
    await ctx.close()
  }
  {
    // a Memory read with the wrong shape (an array) is a failed read: no Voice editor, no writes; and the Settings page,
    // which mounts the same editors, shows "cannot be edited" instead of blank forms
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
    await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
    const writes = []; let memShape = 0
    await ctx.route('**/*', async route => {
      const req = route.request(); const u = new URL(req.url()); const p = u.pathname
      if (u.origin !== base) return route.abort()
      if (!p.startsWith('/api/')) return route.continue()
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (req.method() !== 'GET') { writes.push(p); return json({ ok: true }) }
      if (p === '/api/settings/profile') return json({ business_name: 'Bright Smile', sells: '', website: null, buyer: null, new_play_offer: null })
      if (p === '/api/settings/memory') return json(u.searchParams.has('x') ? {} : (memShape++ === 0 ? { memory: [] } : { memory: { icp: 'x', positioning: 'y', tone: 'z' } }))   // an array, then an object without its lists
      if (p === '/api/settings/competitors') return json({})
      return json({}, 404)
    })
    const page = await ctx.newPage()
    await page.goto(base + '/app/business', { waitUntil: 'networkidle' })
    await page.getByTestId('load-failed').waitFor({ timeout: 20000 })
    assert.match(await page.getByTestId('section-voice').textContent(), /Could not load Memory/)
    assert.equal(await page.getByTestId('section-voice').getByRole('button', { name: /^Edit / }).count(), 0)
    await page.goto(base + '/app/settings', { waitUntil: 'networkidle' })
    await page.getByTestId('memory-unread').waitFor({ timeout: 20000 })
    await page.getByTestId('competitors-unread').waitFor({ timeout: 20000 })
    assert.equal(await page.getByRole('button', { name: /Save memory/i }).count(), 0, 'Settings: no Memory form after a failed read')
    assert.equal(await page.locator('#competitors textarea').count(), 0, 'Settings: no Competitors form after a failed read')
    assert.deepEqual(writes.filter(p => /settings\/(memory|competitors)/.test(p)), [])
    out.push('a Memory array and the Settings page fail closed too')
    await ctx.close()
  }
  console.log(`business page UI check passed (real build): ${out.join('; ')}`)
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
