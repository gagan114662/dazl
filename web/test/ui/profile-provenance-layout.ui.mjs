// #1016 rendered check: the Leads "Profile used" summary keeps the profile text AND its provenance note readable beside a
// long profile, on mobile and desktop. The defect (staging, 390x844, reviewer 2026-11-09): the summary was one
// `flex items-center` row, so the long profile and the "(profile origin and approval not recorded)" note shared it and
// the note was squeezed into a one-word-wide column. This harness pins, on the production build with production styles:
//  - for a long profile and EACH origin/approval label, at 390 and 1280: neither the profile text nor the note is
//    squeezed below its natural width (or the full row width when it is longer than the row), the note sits on one line
//    whenever it shares the profile's row, nothing overflows the summary, main or the viewport, and the full wording
//    is on the page (nothing hidden, truncated or shortened);
//  - a short profile at 1280 keeps both on one row (the layout only breaks the line when it has to);
//  - the <details> still opens and closes by click and by keyboard (Enter and Space on the focused summary);
//  - zero hydration errors.
// Fails on the pre-fix layout (the 390 long-profile cases: the note is a narrow multi-line column).
// Run:  cd web && npm run build && node test/ui/profile-provenance-layout.ui.mjs   (SHOTS=<dir> saves screenshots)
// Production build, throwaway database, server under test/helpers/net-fence.ts, /api/* stubbed in the browser (GET only;
// nothing is scanned, saved or sent). Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2
// (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-profile-prov-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','c@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const fence = pathToFileURL(path.join(dir, 'test/helpers/net-fence.ts')).href
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${fence}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const shot = async (page, name) => {
  if (!process.env.SHOTS) return
  // The whole summary block with its surrounding layout: full viewport width, a band above and below the <details>.
  const r = await page.locator('details', { has: page.getByTestId('profile-used-summary') }).boundingBox()
  const vp = page.viewportSize()
  const y = Math.max(0, r.y - 80); const h = Math.min(vp.height - y, r.height + 160)
  await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), clip: { x: 0, y, width: vp.width, height: h } })
}
const HYDRATION = /#41[89]|#42[23]|Hydration|did not match/i
// A long saved profile (synthetic; the editor caps the summary at 300 characters) and a short one.
const LONG = 'Independent dental practices in New York City and the surrounding boroughs with two to ten chairs, run by an owner-dentist or a practice manager, that recently opened, moved or added a location and still book appointments by phone or a paper calendar.'
const SHORT = 'NYC dental practices'
// Every origin/approval label the summary can show, keyed by the icp_source the restore path receives.
const LABELS = { inferred: 'worked out by dazl', user: 'stored profile; approval not recorded', request_only: 'request fallback; interpretation not verified', carried: 'profile origin and approval not recorded' }
let latest = null

const b = await chromium.launch()
const ctx = await b.newContext()
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
  if (u.origin !== base) return route.abort()
  if (!p.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (m !== 'GET') return json({ error: 'not stubbed' }, 400)
  if (p === '/api/scan/latest') return json(latest)
  if (p === '/api/scan/jobs') return json({ jobs: [] })
  if (p === '/api/settings/profile') return json({ business_name: 'Brightsmile', sells: 'Online booking for dental practices', website: 'https://brightsmile.example', buyer: null })
  if (p === '/api/usage') return json({ plan: 'pro', scans_used: 1, scan_limit: 10, has_key: true, trial: null })
  return json({}, 404)
})

// The real geometry of the summary row: each part's rendered box, its natural one-line width, the summary's content
// width, overflow, the line count of the note, and the bounds it must stay inside (main and the viewport).
const geometry = page => page.evaluate(() => {
  const s = document.querySelector('[data-testid="profile-used-summary"]')
  const t = s?.querySelector('[data-testid="profile-used-text"]'); const n = s?.querySelector('[data-testid="profile-provenance"]')
  if (!s || !t || !n) return null
  const natural = el => { const c = el.cloneNode(true); c.removeAttribute('data-testid'); c.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;width:auto;max-width:none'; s.appendChild(c); const w = c.getBoundingClientRect().width; c.remove(); return w }
  const cs = getComputedStyle(s)
  const content = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  const box = el => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height } }
  const lh = parseFloat(getComputedStyle(n).lineHeight) || parseFloat(getComputedStyle(n).fontSize) * 1.5
  const main = document.getElementById('main')?.getBoundingClientRect()
  return { text: box(t), note: box(n), textNat: natural(t), noteNat: natural(n), content, sScroll: s.scrollWidth, sClient: s.clientWidth,
    noteLines: Math.round(n.getBoundingClientRect().height / lh), textStr: t.innerText, noteStr: n.innerText,
    mainR: main ? main.right : window.innerWidth, vw: window.innerWidth }
})
const assertReadable = (g, label) => {
  assert.ok(g, `${label}: the Profile used summary renders its text and provenance parts`)
  const d = JSON.stringify(g)
  // Not squeezed: each part gets its natural one-line width, or the whole row when it is longer than the row.
  assert.ok(g.note.w >= Math.min(g.noteNat, g.content) - 1, `${label}: provenance note is not squeezed (width ${g.note.w} < min(natural ${g.noteNat}, row ${g.content})) :: ${d}`)
  assert.ok(g.text.w >= Math.min(g.textNat, g.content) - 1, `${label}: profile text is not squeezed (width ${g.text.w} < min(natural ${g.textNat}, row ${g.content})) :: ${d}`)
  // Sharing a row is allowed only when the note fits on that row in one line; otherwise it starts below the profile.
  const sameRow = g.note.t < g.text.b - 1
  if (sameRow) assert.equal(g.noteLines, 1, `${label}: a note beside the profile text stays on one line (${g.noteLines} lines) :: ${d}`)
  else assert.ok(g.note.t >= g.text.b - 1, `${label}: a note that does not fit beside the profile starts below it :: ${d}`)
  // Nothing hidden or clipped: no overflow of the summary, main or the viewport.
  assert.ok(g.sScroll <= g.sClient + 1, `${label}: summary does not overflow horizontally (${g.sScroll} > ${g.sClient}) :: ${d}`)
  for (const [k, r] of [['text', g.text], ['note', g.note]]) assert.ok(r.r <= Math.min(g.mainR, g.vw) + 1 && r.l >= -1, `${label}: ${k} inside main and the viewport :: ${d}`)
  return sameRow
}

try {
  for (const [w, h, tag] of [[390, 844, 'mobile'], [1280, 800, 'desktop']]) {
    for (const [summary, size] of [[LONG, 'long'], [SHORT, 'short']]) {
      for (const [source, words] of Object.entries(LABELS)) {
        latest = { query: 'Find NYC dental practices that opened in the past 90 days', icp: { summary, who: ['Practice owner'], industries: [], sizes: [], where: ['New York'], signals: [], exclude: [] }, icp_source: source }
        const label = `${tag} ${size} ${source}`
        const page = await ctx.newPage()
        await page.setViewportSize({ width: w, height: h })
        const hydrationErrors = []
        page.on('console', m => { if (m.type() === 'error' && HYDRATION.test(m.text())) hydrationErrors.push(m.text().slice(0, 140)) })
        page.on('pageerror', e => { if (HYDRATION.test(String(e))) hydrationErrors.push('pageerror: ' + String(e).slice(0, 140)) })
        await page.goto(base + '/app/leads', { waitUntil: 'load' })
        const sum = page.getByTestId('profile-used-summary')
        await sum.waitFor({ timeout: 15000 })
        await page.waitForTimeout(300)
        assert.deepEqual(hydrationErrors, [], `${label}: zero hydration errors (got ${JSON.stringify(hydrationErrors)})`)
        const g = await geometry(page)
        // The complete wording, exactly: nothing truncated, shortened or replaced.
        assert.equal(g?.textStr, `Profile used: ${summary}`, `${label}: the whole profile text is on the page`)
        assert.equal(g?.noteStr, `(${words})`, `${label}: the whole origin/approval note is on the page`)
        const sameRow = assertReadable(g, label)
        // A short profile at desktop width keeps both parts on one row: the layout breaks the line only when it must.
        if (tag === 'desktop' && size === 'short') assert.ok(sameRow, `${label}: short profile and note share one row at 1280`)
        // Disclosure semantics unchanged: closed by default; click opens/closes; Enter and Space on the focused summary toggle.
        const details = page.locator('details', { has: sum })
        const isOpen = () => details.evaluate(d => d.open)
        assert.equal(await isOpen(), false, `${label}: closed by default`)
        await sum.focus()
        assert.equal(await sum.evaluate(el => document.activeElement === el), true, `${label}: the summary is keyboard-focusable`)
        await page.keyboard.press('Enter')
        assert.equal(await isOpen(), true, `${label}: Enter opens`)
        assert.ok(await page.getByText('Edit and run again').isVisible(), `${label}: the opened profile shows its actions`)
        assertReadable(await geometry(page), `${label} (open)`)
        if (source === 'carried' && size === 'long') await shot(page, `profile-provenance-${tag}-long-open`)
        await page.keyboard.press(' ')
        assert.equal(await isOpen(), false, `${label}: Space closes`)
        await sum.click()
        assert.equal(await isOpen(), true, `${label}: click opens`)
        await sum.click()
        assert.equal(await isOpen(), false, `${label}: click closes`)
        if (source === 'carried') await shot(page, `profile-provenance-${tag}-${size}-closed`)
        await page.close()
      }
    }
  }
  console.log('PASS profile-provenance-layout: long and short profiles x every origin/approval label at 390 and 1280 - profile text and provenance note keep their natural width (or the full row), the note never sits beside the profile on more than one line, nothing overflows or is truncated, click + Enter + Space still toggle the details, zero hydration errors')
} finally {
  srv.kill(); await b.close()
  // Windows can hold the db file briefly after the server exits (EBUSY); never let cleanup mask the real result.
  await new Promise(r => setTimeout(r, 500)); try { rmSync(tmp, { recursive: true, force: true }) } catch { /* temp dir: best effort */ }
}
