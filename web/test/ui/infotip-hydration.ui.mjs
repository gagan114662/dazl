// InfoTip ids must be hydration-stable (production defect: React #418 on authed /app/leads and /app/settings).
// The old module-level counter (let seq = 0; useState(() => `tip-${++seq}`)) is shared across SSR requests, so the
// server emits inflated ids (tip-35, tip-36, ...) while the client re-renders from 0: an aria-describedby/id
// mismatch on every tooltip. React then discards the server markup and client-renders - a full re-render and a
// transient aria mismatch (a real if minor accessibility defect), plus one allowlisted error record per page load.
// React's useId is tree-position based: identical on every SSR pass and across hydration.
// Run:  cd web && npm run build && node test/ui/infotip-hydration.ui.mjs
// Production build, throwaway database, server under test/helpers/net-fence.ts, every /api/* stubbed in the browser.
// Covers the whole InfoTip/Caveat mount class: /app (journey, feature-discovery, first-run), /app/leads,
// /app/settings, /app/outcomes, /app/outreach. It proves, per page:
//   1. two successive SSR fetches emit IDENTICAL tooltip aria-describedby values (the old counter fails this: ids
//      increment with every request);
//   2. the exact SSR HTML the browser consumed and the hydrated DOM carry the SAME tooltip ids - catches the
//      mismatch even where React recovers silently (a Suspense/PPR subtree can skip the console error);
//   3. ZERO hydration errors (React #418/#419/#423 or pageerror hydration text) in console/pageerror;
//   4. every tooltip button's aria-describedby resolves to its own tooltip text element, and click/Escape still
//      toggle aria-expanded (aria behavior unchanged).
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-infotip-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const PAGES = ['/app', '/app/leads', '/app/settings', '/app/outcomes', '/app/outreach']
const describedBy = html => [...html.replace(/\\"/g, '"').matchAll(/aria-describedby="([^"]+)"/g)].map(m => m[1])
const HYDRATION = /#41[89]|#42[23]|Hydration|did not match/i
const authed = { headers: { cookie: `dazl_session=${token}` } }

// 1. SSR id stability across successive requests, per page (the old module counter fails this).
let ssrSeen = 0
for (const p of PAGES) {
  const ids1 = describedBy(await (await fetch(base + p, authed)).text())
  const ids2 = describedBy(await (await fetch(base + p, authed)).text())
  if (ids1.length === 0) continue
  ssrSeen++
  assert.deepEqual(ids2, ids1, `${p}: tooltip ids must be identical across SSR requests (got ${JSON.stringify(ids1)} then ${JSON.stringify(ids2)})`)
}
assert.ok(ssrSeen >= 2, `expected at least 2 mount-class pages with SSR tooltips, saw ${ssrSeen}`)

const b = await chromium.launch()
const ctx = await b.newContext()
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
const ssrBodies = new Map()
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
  if (u.origin !== base) return route.abort()
  if (req.resourceType() === 'document' && PAGES.includes(p)) {
    const resp = await route.fetch()
    ssrBodies.set(p, await resp.text())
    return route.fulfill({ response: resp })
  }
  if (!p.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (m !== 'GET') return json({ error: 'not stubbed' }, 400)
  if (p === '/api/settings/profile') return json({ business_name: 'Brightsmile', sells: 'Online booking for dental practices', website: 'https://brightsmile.example', buyer: null })
  if (p === '/api/usage') return json({ plan: 'pro', scans_used: 1, scan_limit: 10, has_key: true, trial: null })
  if (p === '/api/leads') return json({ leads: [], hidden_count: 0 })
  if (p === '/api/scan/jobs') return json({ jobs: [], totals: { searches: 0, finished: 0 } })
  if (p === '/api/scan/latest') return json({ query: null, icp: null, icp_source: null })
  if (p === '/api/campaigns') return json({ campaigns: [] })
  if (p.startsWith('/api/campaigns/')) return json({ job: null, leads: [], messages: [] })
  if (p === '/api/watch') return json({ watches: [] })
  if (p === '/api/settings/advanced') return json({ available: true, version: '1', platforms: [] })
  if (p === '/api/settings/llm-key') return json({ keys: [], rejection: null })
  if (p === '/api/scan/sources') return json({ web_index: false, news: true, websites: true })
  if (p === '/api/outreach/settings') return json({ gmail: null, sender: null, daily_cap: 20, sent_24h: 0, account_sent_24h: 0, read_notice: [] })
  if (p === '/api/outreach') return json({ messages: [] })
  if (p === '/api/leads/play-research') return json({ research: null })
  if (p === '/api/leads/verification-fixture') return json({ fixture: null })
  return json({}, 404)
})
let mountedPages = 0
for (const p of PAGES) {
  const page = await ctx.newPage()
  const hydrationErrors = []
  page.on('console', m => { if (m.type() === 'error' && HYDRATION.test(m.text())) hydrationErrors.push(m.text().slice(0, 140)) })
  page.on('pageerror', e => { if (HYDRATION.test(String(e))) hydrationErrors.push('pageerror: ' + String(e).slice(0, 140)) })
  await page.goto(base + p, { waitUntil: 'load' })
  await page.waitForTimeout(1500)
  assert.deepEqual(hydrationErrors, [], `${p}: zero hydration errors expected (got ${JSON.stringify(hydrationErrors)})`)
  const domIds = new Set(await page.evaluate(() => [...document.querySelectorAll('[data-testid="infotip"] button')].map(btn => btn.getAttribute('aria-describedby'))))
  const ssrIds = describedBy(ssrBodies.get(p) ?? '')
  // Every id the server emitted must survive hydration unchanged; a mismatch (loud #418 or silent boundary
  // recovery) re-renders the tooltip with a client-side id, so the SSR id disappears from the DOM. Tooltips that
  // only render after data loads are legitimately DOM-only - the reverse direction does not apply.
  if (domIds.size > 0) mountedPages++
  for (const id of ssrIds) assert.ok(domIds.has(id), `${p}: SSR tooltip id ${id} must survive hydration (dom has ${JSON.stringify([...domIds])})`)
  const wiring = await page.evaluate(() => {
    const tips = [...document.querySelectorAll('[data-testid="infotip"]')]
    return tips.map(t => {
      const btn = t.querySelector('button'); const text = t.querySelector('[data-testid="infotip-text"]')
      return { has: !!btn && !!text, paired: !!btn && !!text && btn.getAttribute('aria-describedby') === text.id }
    })
  })
  for (const w of wiring) assert.ok(w.has && w.paired, `${p}: every tooltip button's aria-describedby must point at its own tooltip text`)
  if (wiring.length > 0) {
    const first = page.locator('[data-testid="infotip"] button').first()
    await first.click(); assert.equal(await first.getAttribute('aria-expanded'), 'true', `${p}: click still opens the tooltip`)
    await first.press('Escape'); assert.equal(await first.getAttribute('aria-expanded'), 'false', `${p}: Escape still closes the tooltip`)
  }
  await page.close()
}
assert.ok(mountedPages >= 2, `expected at least 2 pages mounting tooltips in the hydrated DOM, saw ${mountedPages}`)
await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
console.log(`OK infotip-hydration: ${PAGES.length} mount-class pages, SSR-stable ids, SSR=hydrated ids, zero hydration errors, aria wiring unchanged`)
