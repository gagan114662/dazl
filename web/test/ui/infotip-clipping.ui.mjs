// #1010 rendered check: an open InfoTip is never clipped by the scrolling container. The defect (grounded on the
// /app/settings Memory tooltip pixel): <main> is overflow-auto, the tooltip centers under the (i) with
// translateX(-50%), and the old edge-shift measured only the viewport - so a tooltip whose center sits within
// half its width of main's left box was clipped by the container at every scroll position.
// This harness pins the fix: on desktop AND mobile, EVERY settings tooltip opens fully inside main's visible box
// (and the viewport), via hover and via keyboard focus; a tooltip at the bottom edge opens UPWARD (asserted, not
// assumed) when there is room; placement re-runs on resize while open, including a size small enough to engage
// the capped-box path; Escape still closes; zero hydration errors. Fails on the pre-fix component (the desktop
// horizontal check reproduces the clipped pixel exactly).
// Run:  cd web && npm run build && node test/ui/infotip-clipping.ui.mjs   (SHOTS=<dir> saves screenshots)
// Production build, throwaway database, server under test/helpers/net-fence.ts, /api/* stubbed in the browser.
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-infotip-clip-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','c@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) }
const HYDRATION = /#41[89]|#42[23]|Hydration|did not match/i

const b = await chromium.launch()
const ctx = await b.newContext()
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
  if (u.origin !== base) return route.abort()
  if (!p.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (m !== 'GET') return json({ error: 'not stubbed' }, 400)
  if (p === '/api/settings/profile') return json({ business_name: 'Brightsmile', sells: 'Online booking for dental practices', website: 'https://brightsmile.example', buyer: null })
  if (p === '/api/usage') return json({ plan: 'pro', scans_used: 1, scan_limit: 10, has_key: true, trial: null })
  if (p === '/api/settings/advanced') return json({ available: true, version: '1', platforms: [] })
  if (p === '/api/settings/llm-key') return json({ keys: [], rejection: null })
  if (p === '/api/outreach/settings') return json({ gmail: null, sender: null, daily_cap: 20, sent_24h: 0, account_sent_24h: 0, read_notice: [] })
  return json({}, 404)
})

// The open tooltip's box, with the clipping container's (main) visible box and the viewport.
// The open tooltip's box, the anchor BUTTON's box, the clipping container's (main) box and scroll, the viewport,
// and the placement styles actually applied - so a failure log carries the real geometry, not a hypothesis.
const openBox = page => page.evaluate(() => {
  const wrap = document.querySelector('.infotip[data-open="true"]')
  const tip = wrap?.querySelector('[role="tooltip"]')
  const btn = wrap?.querySelector('button')
  if (!tip || !btn) return null
  const r = tip.getBoundingClientRect(); const br = btn.getBoundingClientRect()
  const main = document.getElementById('main'); const m = main.getBoundingClientRect()
  return { l: r.left, r: r.right, t: r.top, b: r.bottom, bt: br.top, bb: br.bottom, bl: br.left, br: br.right,
    ml: m.left, mr: m.right, mt: m.top, mb: m.bottom, msl: main.scrollLeft, mst: main.scrollTop,
    vw: window.innerWidth, vh: window.innerHeight,
    top: tip.style.top || '(css)', bot: tip.style.bottom || '(css)', tf: tip.style.transform || '(css)', mh: tip.style.maxHeight || '(css)' }
})
const assertContained = (box, label) => {
  assert.ok(box, `${label}: a tooltip is open`)
  const d = JSON.stringify(box)
  assert.ok(box.l >= box.ml - 1 && box.l >= -1, `${label}: left edge ${box.l} inside the container ${box.ml} and the viewport :: ${d}`)
  assert.ok(box.r <= box.mr + 1 && box.r <= box.vw + 1, `${label}: right edge ${box.r} inside the container ${box.mr} and the viewport :: ${d}`)
  assert.ok(box.b <= box.mb + 1 && box.b <= box.vh + 1, `${label}: bottom edge ${box.b} inside the container ${box.mb} and the viewport :: ${d}`)
  assert.ok(box.t >= box.mt - 1, `${label}: top edge ${box.t} inside the container ${box.mt} :: ${d}`)
}

try {
  for (const [w, h, tag] of [[1280, 720, 'desktop'], [390, 844, 'mobile']]) {
    const page = await ctx.newPage()
    await page.setViewportSize({ width: w, height: h })
    const hydrationErrors = []
    page.on('console', m => { if (m.type() === 'error' && HYDRATION.test(m.text())) hydrationErrors.push(m.text().slice(0, 140)) })
    page.on('pageerror', e => { if (HYDRATION.test(String(e))) hydrationErrors.push('pageerror: ' + String(e).slice(0, 140)) })
    await page.goto(base + '/app/settings', { waitUntil: 'load' })
    await page.waitForTimeout(1500)
    assert.deepEqual(hydrationErrors, [], `${tag}: zero hydration errors (got ${JSON.stringify(hydrationErrors)})`)
    const buttons = await page.locator('[data-testid="infotip"] button').all()
    assert.ok(buttons.length >= 2, `${tag}: the settings page mounts tooltips (saw ${buttons.length})`)
    // Every tooltip, both open paths, fully inside the visible bound. The pre-fix component fails this on the
    // Memory tooltip on desktop - the exact clipped pixel that grounded #1010.
    for (const [i, btn] of buttons.entries()) {
      await btn.scrollIntoViewIfNeeded()
      await btn.hover()
      assert.equal(await btn.getAttribute('aria-expanded'), 'true', `${tag} tooltip ${i}: hover opens`)
      await page.waitForTimeout(150) // the edge-shift effect runs after the open render
      assertContained(await openBox(page), `${tag} tooltip ${i} hover`)
      await btn.press('Escape')
      assert.equal(await btn.getAttribute('aria-expanded'), 'false', `${tag} tooltip ${i}: Escape closes`)
      await btn.evaluate(el => el.blur()); await page.mouse.move(0, 0)
      await btn.focus()
      assert.equal(await btn.getAttribute('aria-expanded'), 'true', `${tag} tooltip ${i}: keyboard focus opens`)
      await page.waitForTimeout(150)
      assertContained(await openBox(page), `${tag} tooltip ${i} focus`)
      await btn.press('Escape')
    }
    // The bottom edge: the LAST tooltip opened at the bottom of the visible bound must stay whole (opens upward
    // when there is room above), not run past the container.
    const last = buttons[buttons.length - 1]
    await page.evaluate(() => {
      const tips = [...document.querySelectorAll('[data-testid="infotip"] button')]
      tips[tips.length - 1].scrollIntoView({ block: 'end' })
    })
    await last.hover()
    assert.equal(await last.getAttribute('aria-expanded'), 'true', `${tag}: bottom-edge tooltip opens`)
    await page.waitForTimeout(150)
    const bottomBox = await openBox(page)
    assert.ok(bottomBox.b <= bottomBox.bt + 1, `${tag}: the bottom-edge tooltip opened UPWARD (tooltip bottom ${bottomBox.b} at or above the button top ${bottomBox.bt})`)
    assertContained(bottomBox, `${tag} bottom-edge tooltip`)
    await shot(page, `infotip-clipping-${tag}-settings-open`)
    // Placement re-runs on resize while open: shrink the viewport twice (the second is small enough that the
    // capped box + nudge path engages) - the open tooltip must stay inside the bound at every size. Open via
    // keyboard FOCUS, not hover: a resize relayouts the page under the stationary pointer, the button moves
    // out from under it, Chromium fires mouseleave, and a hover-open tip legitimately closes (pointer intent
    // off) - that close is correct behavior, not the defect under test. Focus survives the relayout, so this
    // pins the effect's resize listener itself.
    await page.mouse.move(0, 0)
    await last.focus()
    assert.equal(await last.getAttribute('aria-expanded'), 'true', `${tag}: the bottom-edge tooltip opens on focus`)
    await page.waitForTimeout(150)
    for (const [rw, rh] of [[500, 400], [280, 220]]) {
      await page.setViewportSize({ width: rw, height: rh })
      await page.waitForTimeout(300)
      assertContained(await openBox(page), `${tag} resized-${rw}x${rh} tooltip`)
    }
    await last.press('Escape')

    // Keyboard consistency on the LONGEST tooltip (#1010's second defect class): a capped tooltip is scrollable
    // and Chromium tabs into it. The old component's button-level onBlur set open=false while :focus-within kept
    // the text displayed - aria-expanded lied, the placement effect and its listeners were torn down while the
    // tip was still on screen, and Escape (button-only) could not close from inside. Pin: tabbing in keeps state
    // true, placement still re-runs while reading, End reaches the last line, Escape from inside closes state
    // AND display, wheel scrolls, and resize retains the reader's scroll position.
    const longestIdx = await page.evaluate(() => {
      const tips = [...document.querySelectorAll('[data-testid="infotip-text"]')]
      let m = 0, mi = 0
      tips.forEach((t, i) => { const n = t.textContent?.length ?? 0; if (n > m) { m = n; mi = i } })
      return mi
    })
    const longBtn = (await page.locator('[data-testid="infotip"] button').all())[longestIdx]
    const scrollState = () => page.evaluate(() => {
      const tip = document.querySelector('.infotip[data-open="true"] [role="tooltip"]')
      return tip ? { top: tip.scrollTop, client: tip.clientHeight, height: tip.scrollHeight } : null
    })
    await page.mouse.move(0, 0) // pointer away: hover must not mask the keyboard state
    await longBtn.focus()
    assert.equal(await longBtn.getAttribute('aria-expanded'), 'true', `${tag}: keyboard focus opens the longest tooltip`)
    await page.setViewportSize({ width: 280, height: 220 }) // small enough to engage the capped scrollable box
    await page.waitForTimeout(300)
    assertContained(await openBox(page), `${tag} capped longest tooltip`)
    const capped = await scrollState()
    assert.ok(capped && capped.height > capped.client, `${tag}: the longest tooltip is capped and scrollable (scrollHeight ${capped?.height} > clientHeight ${capped?.client})`)
    await page.keyboard.press('Tab')
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName)
    assert.equal(focused, 'tooltip', `${tag}: Tab moves focus INTO the scrollable tooltip (focused ${focused})`)
    assert.equal(await longBtn.getAttribute('aria-expanded'), 'true', `${tag}: state stays open while the text is being read (no false-while-visible)`)
    // Placement is still alive while reading: open stayed true, so the effect and its resize listener remain.
    await page.setViewportSize({ width: 300, height: 240 })
    await page.waitForTimeout(300)
    assertContained(await openBox(page), `${tag} resized-while-reading tooltip`)
    await page.setViewportSize({ width: 280, height: 220 })
    await page.waitForTimeout(300)
    // Pointer cross while READING: hover enter+leave must not set state false under the focused tip - CSS
    // :focus-within would keep displaying it, the same state/display lie through the pointer path.
    await longBtn.scrollIntoViewIfNeeded() // the anchor must actually be under the pointer for enter/leave to fire
    const hb = await longBtn.boundingBox()
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.waitForTimeout(100)
    await page.mouse.move(0, 0)
    await page.waitForTimeout(100)
    assert.equal(await longBtn.getAttribute('aria-expanded'), 'true', `${tag}: pointer cross while reading keeps state open (focus owns the tip)`)
    await page.keyboard.press('End')
    await page.waitForTimeout(150) // let the keypress scroll land and any re-place settle before measuring
    const reached = await scrollState()
    const focusAtEnd = await page.evaluate(() => document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName)
    assert.ok(reached.top + reached.client >= reached.height - 2, `${tag}: End reaches the last line (scrollTop ${reached.top} + client ${reached.client} vs height ${reached.height}; focus ${focusAtEnd})`)
    // Escape from INSIDE the tooltip: closes state and display together (focus blurred out of the wrapper, pointer away).
    await page.keyboard.press('Escape')
    assert.equal(await longBtn.getAttribute('aria-expanded'), 'false', `${tag}: Escape from inside the tooltip closes it`)
    const display = await longBtn.evaluate(el => getComputedStyle(el.parentElement.querySelector('[role="tooltip"]')).display)
    assert.equal(display, 'none', `${tag}: after Escape the tooltip is actually hidden (display ${display})`)
    // Raw-pointer reentry + dismiss on the capped overlay (no locator.hover(): its actionability requires the
    // button as hit target, and once the trial move opens the tip the capped overlay covers its own anchor -
    // deadlock, CI run 42471809886, reproduced statically). RAW mouse.move is the real interaction: onto the
    // button reopens, back off dismisses; state AND display must agree both ways (reviewer independently
    // verified this sequence against React+CSS at 280x220).
    await longBtn.scrollIntoViewIfNeeded()
    const bb2 = await longBtn.boundingBox()
    const hit = () => page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName}/${e.getAttribute('role') ?? ''}${e.closest('[data-testid="infotip"]') ? ' in-infotip' : ''}` : 'none' }, [bb2.x + bb2.width / 2, bb2.y + bb2.height / 2])
    await page.mouse.move(bb2.x + bb2.width / 2, bb2.y + bb2.height / 2, { steps: 5 })
    await page.waitForTimeout(150)
    assert.equal(await longBtn.getAttribute('aria-expanded'), 'true', `${tag}: raw pointer reentry opens the capped tooltip (hit ${await hit()})`)
    assertContained(await openBox(page), `${tag} reentered capped tooltip`)
    const reDisp = await longBtn.evaluate(el => getComputedStyle(el.parentElement.querySelector('[role="tooltip"]')).display)
    assert.equal(reDisp, 'block', `${tag}: reentered capped tooltip is displayed (display ${reDisp})`)
    await page.mouse.move(0, 0, { steps: 5 })
    await page.waitForTimeout(150)
    assert.equal(await longBtn.getAttribute('aria-expanded'), 'false', `${tag}: raw pointer dismiss closes the capped tooltip`)
    const disDisp = await longBtn.evaluate(el => getComputedStyle(el.parentElement.querySelector('[role="tooltip"]')).display)
    assert.equal(disDisp, 'none', `${tag}: dismissed capped tooltip is hidden (display ${disDisp})`)

    // Pointer wheel scrolls the capped box, and a resize keeps the reader's place (no scroll reset). Reopen via
    // FOCUS: the capped overlay covers its own anchor, so hover's hit-target requirement cannot be met (above).
    await longBtn.focus()
    assert.equal(await longBtn.getAttribute('aria-expanded'), 'true', `${tag}: focus reopens the longest tooltip`)
    await page.waitForTimeout(150)
    assertContained(await openBox(page), `${tag} reopened capped tooltip`)
    const box = await openBox(page)
    await page.mouse.move((box.l + box.r) / 2, (box.t + box.b) / 2)
    // Reset the reader's position first: the wheel assert proves a real DELTA, never a retained End position.
    await page.evaluate(() => { const t = document.querySelector('.infotip[data-open="true"] [role="tooltip"]'); if (t) t.scrollTop = 0 })
    await page.waitForTimeout(100)
    const beforeWheel = (await scrollState())?.top ?? 0
    await page.mouse.wheel(0, 240)
    await page.waitForTimeout(100)
    const wheeled = await scrollState()
    assert.ok(wheeled && wheeled.top - beforeWheel > 100, `${tag}: pointer wheel scrolls the capped tooltip (scrollTop ${beforeWheel} -> ${wheeled?.top})`)
    await page.setViewportSize({ width: 300, height: 240 })
    await page.waitForTimeout(300)
    const kept = await scrollState()
    assert.ok(kept && kept.top > 0, `${tag}: resize retains the reader's scroll position (scrollTop ${kept?.top})`)
    assertContained(await openBox(page), `${tag} retained-scroll tooltip`)
    await shot(page, `infotip-clipping-${tag}-settings-capped`)
    // Focus owns the tip now: pointer leave must NOT close while the button is focused (the consistency fix) -
    // Escape is the close that matches the focused state.
    await page.mouse.move(0, 0)
    await page.waitForTimeout(100)
    assert.equal(await longBtn.getAttribute('aria-expanded'), 'true', `${tag}: pointer leave with focus inside keeps the capped tooltip open`)
    await longBtn.press('Escape')
    assert.equal(await longBtn.getAttribute('aria-expanded'), 'false', `${tag}: Escape closes the capped tooltip`)
    await page.close()
  }
  console.log('PASS infotip-clipping: every settings tooltip opens whole inside the visible bound, desktop + mobile, hover + keyboard, bottom edge opens upward, placement survives resize while open, keyboard state stays consistent while reading a capped tooltip, End reaches the last line, Escape closes from inside, wheel scrolls and resize retains the position')
} finally { srv.kill(); await b.close(); rmSync(tmp, { recursive: true, force: true }) }
