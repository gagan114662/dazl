// Rendered check for the marketing homepage. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/landing.ui.mjs   (SHOTS=<dir> also saves desktop + mobile screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts; signed out; every /api/* call
// answered from a stub and off-host requests aborted. It proves, on the rendered page:
//   1. the hero is one line, the owner's subhead (#1428), one "Start free" (to sign-up) and a secondary "See how it works";
//   2. the demo plays the flow (five businesses in five countries, picked by chips or one per loop; the local dental one
//      first): a URL typed, the four checks tick, "3 leads ready" (2 more kept out, with the reason) with 3 lead cards (name,
//      title, company, quoted signal with date), then the saved search "Live · runs every day"; labelled as an example;
//   3. the 3 steps, the proof strip, the free-beta card (no Pro) and the footer with the support address are there;
//   4. none of the old page is left: no FIND/VERIFY/REVIEW/SEND tabs, monospace, "Illustration only", BYOK or trial
//      scans in the hero, or "site blocked our check"; no horizontal scroll at 390px.
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-landing-')); const DB = path.join(tmp, 'app.db')
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

// visible text without the demo's example names (a made-up company could contain any word)
const all0 = t => t
const b = await chromium.launch()
try {
  for (const [kind, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const ctx = await b.newContext({ viewport })
    await ctx.route('**/*', route => { const u = new URL(route.request().url()); if (u.origin !== base) return route.abort(); if (u.pathname.startsWith('/api/')) return route.fulfill({ status: 404, body: '{}' }); return route.continue() })
    const page = await ctx.newPage()
    await page.goto(base + '/', { waitUntil: 'networkidle' })
    const main = page.locator('main')
    // 1. Hero.
    assert.equal((await page.locator('h1').innerText()).replace(/\s+/g, ' '), 'Your website in. Verified leads out.')
    assert.equal(await page.getByTestId('hero-sub').innerText(), 'Paste your website. dazl finds businesses that need what you sell right now, shows you the proof, and drafts the email from your Gmail.')
    const cta = page.getByTestId('hero-cta')
    assert.equal(await cta.innerText(), 'Start free'); assert.equal(await cta.getAttribute('href'), '/sign-up', 'Start free goes to sign-up')
    assert.equal(await page.getByRole('link', { name: 'See how it works' }).getAttribute('href'), '#how')
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${kind}-hero.png`) })
    // 2. The demo plays through to the live Play.
    const demo = page.getByTestId('landing-demo')
    await page.waitForFunction(() => document.querySelector('[data-testid=landing-demo]')?.getAttribute('data-step') === 'checks', null, { timeout: 10000 })
    assert.match(await demo.innerText(), /brightsmile-dental\.example/, 'the first (local dental) business\'s website is typed')
    await page.waitForFunction(() => document.querySelector('[data-testid=landing-demo]')?.getAttribute('data-step') === 'live', null, { timeout: 15000 })
    const dt = await demo.innerText()
    for (const c of ['Reading your site', 'Building your profile', 'Searching hiring & funding news', 'Checking evidence', '3 leads ready', '2 more kept out, with the reason', 'Live · runs every day']) assert.ok(dt.includes(c), c)
    assert.equal(await demo.locator('[data-state=done]').count(), 4, 'all four checks ticked')
    assert.equal(await page.getByTestId('demo-label').innerText(), 'Illustrative example · made-up companies and people', 'the demo says it is an example, on screen')
    assert.match(await demo.getAttribute('aria-label'), /^Illustrative example/, 'and to screen readers')
    const leads = demo.getByTestId('demo-lead'); assert.equal(await leads.count(), 3)
    for (let i = 0; i < 3; i++) {
      assert.match(await leads.nth(i).innerText(), /^[A-Z]{2}\n.+ .+ · .+\n?“.+”/s, 'name, title · company, quoted line')
      assert.doesNotMatch(await leads.nth(i).innerText(), /fit \d\/5/, 'no fit score (#1428)')
      assert.match(await leads.nth(i).getByTestId('demo-evidence').innerText(), /^\S+\.example\s+\d{1,2} \w{3} 2026\s+✓ Company and date checked$/, 'source, date and the checked mark')
    }
    assert.equal(await page.getByTestId('hero-contrast').innerText(), 'Proof behind every lead, not a database dump.')
    assert.match(await page.locator('main').innerText(), /You approve each send, unless you turn on Autopilot/)
    assert.doesNotMatch(await page.locator('main').innerText(), /Nothing sends until you approve it/)
    await demo.scrollIntoViewIfNeeded(); await page.waitForTimeout(600)
    // Any business, any country: five very different businesses to pick from; picking one replays the run for it.
    assert.deepEqual(await page.getByTestId('demo-chips').getByRole('button').allTextContents(), ['Dental · New York', 'B2B SaaS · London', 'Marketing agency · Toronto', 'Commercial real estate · Gurugram', 'Logistics · Dubai'])
    assert.equal(await page.getByTestId('demo-chips').getByRole('button', { name: 'Dental · New York' }).getAttribute('aria-pressed'), 'true', 'the local dental example is the default tab')
    await page.getByTestId('demo-chips').getByRole('button', { name: 'Logistics · Dubai' }).click()
    assert.equal(await page.getByTestId('demo-scenario').getAttribute('data-scenario'), 'logistics-dubai')
    assert.equal(await page.getByTestId('demo-chips').getByRole('button', { name: 'Logistics · Dubai' }).getAttribute('aria-pressed'), 'true')
    await page.waitForFunction(() => document.querySelector('[data-testid=landing-demo]')?.getAttribute('data-step') === 'live', null, { timeout: 15000 })
    assert.match(await demo.innerText(), /gulfroute-freight\.example[\s\S]*Desert Bloom Home[\s\S]*UAE retailers and e-commerce brands scaling deliveries/)
    await page.waitForTimeout(600)
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${kind}-demo.png`) })
    // 3. Steps, proof, pricing, footer.
    assert.deepEqual((await page.getByTestId('step').locator('h3').allInnerTexts()), ['Paste your website', 'Get new leads every day', 'Approve and send'])
    assert.match(await page.getByTestId('proof').innerText(), /Quoted and linked[\s\S]*Company and date checked/)
    // Every proof heading and body stays inside the card's padded content box (Instinct #338, 390px): element bounds,
    // not only the document width.
    const inside = await page.getByTestId('proof').locator('.lp-card').evaluate(card => {
      const cs = getComputedStyle(card), r = card.getBoundingClientRect()
      const left = r.left + parseFloat(cs.paddingLeft) - 0.5, right = r.right - parseFloat(cs.paddingRight) + 0.5
      return [...card.querySelectorAll('*')].filter(n => { const b = n.getBoundingClientRect(); return b.width > 0 && (b.left < left || b.right > right || n.scrollWidth > n.clientWidth + 1) }).map(n => n.textContent.slice(0, 40))
    })
    assert.deepEqual(inside, [], `proof text stays inside its card (${kind})`)
    if (process.env.SHOTS) await page.getByTestId('proof').screenshot({ path: path.join(process.env.SHOTS, `${kind}-proof.png`) })
    const pricing = await page.locator('#pricing').innerText()
    assert.match(pricing, /Free while in beta[\s\S]*Free beta[\s\S]*\$0[\s\S]*Start free/)
    assert.doesNotMatch(pricing, /\$49|\bPro\b|own AI key|fair-use/i, 'free beta only (#1428)')
    assert.match(await page.locator('footer').innerText(), /About[\s\S]*Contact[\s\S]*Terms[\s\S]*Privacy[\s\S]*support@dazl\.ai/)
    assert.doesNotMatch(all0(await main.innerText()), /\bPlays?\b|held for (your )?review/, 'plain words (#1428)')
    // 4. Nothing of the old page.
    const all = await main.innerText()
    for (const gone of [/Illustration only/i, /site blocked/i, /BYOK/, /\bFIND\b|\bVERIFY\b/]) assert.doesNotMatch(all, gone, String(gone))
    assert.doesNotMatch(await page.locator('section').first().innerText(), /trial scan|own key/i, 'no BYOK or trial scans in the hero')
    assert.equal(await page.locator('main .mono, main .tab, main .badge').count(), 0, 'no monospace tabs or badges')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll (${kind})`)
    if (process.env.SHOTS) { await page.locator('#how').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(process.env.SHOTS, `${kind}-steps.png`) }); await page.screenshot({ path: path.join(process.env.SHOTS, `${kind}-full.png`), fullPage: true }) }
    await ctx.close()
  }
  // #1428: /pricing, /plans, /contact and /about answer 200 with the same wordmark; pricing shows the same free-beta card
  for (const p of ['/pricing', '/plans', '/contact', '/about']) {
    const page = await b.newPage({ viewport: { width: 390, height: 844 } })
    const r = await page.goto(base + p, { waitUntil: 'networkidle' })
    assert.equal(r.status(), 200, p); assert.equal(new URL(page.url()).pathname, p, `${p} is a page, not a redirect`)
    assert.equal(await page.getByTestId('wordmark').first().innerText(), 'dazl', p)
    if (p === '/pricing' || p === '/plans') assert.match(await page.getByTestId('free-beta-card').innerText(), /Free beta[\s\S]*\$0/, p)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${p}: no horizontal scroll at 390px`)
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `page${p.replace('/', '-')}-390.png`), fullPage: true })
    await page.close()
  }
  console.log('landing UI check passed: one-line hero + owner subhead + Start free (sign-up) + See how it works; demo (dental first) types a URL, ticks 4 checks, 3 ready leads (2 kept out, with the reason) with 3 cards, labelled as an example, saved search live every day; 3 steps, proof, free-beta card, footer with support address; /pricing /plans /contact /about answer; old tabs/monospace/disclaimer/BYOK gone; no horizontal scroll at 390px')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
