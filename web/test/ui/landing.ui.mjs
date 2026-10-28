// Rendered check for the marketing homepage. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/landing.ui.mjs   (SHOTS=<dir> also saves desktop + mobile screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts; signed out; every /api/* call
// answered from a stub and off-host requests aborted. It proves, on the rendered page:
//   1. the hero is one line, the subhead, one "Start free" (Google sign-in) and a secondary "See how it works";
//   2. the demo plays the flow (five businesses in five countries, picked by chips or one per loop): a URL typed, the four checks tick, "3 leads ready" (2 more held) with 3 lead cards (name, title,
//      company, fit pill, quoted signal with date), then a Play card "Live · runs weekly"; the demo is labelled as an illustrative example;
//   3. the 3 steps, the proof strip, pricing and footer are there;
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
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(dir, 'package.json'))
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? ' (allowed by SMOKE_ALLOW_SKIP=1)' : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
let chromium
try { ({ chromium } = require('playwright')) } catch (e) { notRun(e.message.split('\n')[0]) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-landing-')); const DB = path.join(tmp, 'app.db')
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

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
    assert.match(await main.innerText(), /dazl reads your site and finds companies with a buying signal right now\. Leads marked ready come with the quoted line, the source link and the date, checked against the company\. Leads dazl cannot confirm stay held for your review, with the reason\./)
    const cta = page.getByTestId('hero-cta')
    assert.equal(await cta.innerText(), 'Start free'); assert.equal(await cta.getAttribute('href'), '/api/auth/google', 'Start free is Google sign-in')
    assert.equal(await page.getByRole('link', { name: 'See how it works' }).getAttribute('href'), '#how')
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${kind}-hero.png`) })
    // 2. The demo plays through to the live Play.
    const demo = page.getByTestId('landing-demo')
    await page.waitForFunction(() => document.querySelector('[data-testid=landing-demo]')?.getAttribute('data-step') === 'checks', null, { timeout: 10000 })
    assert.match(await demo.innerText(), /ledgerline\.example/, 'the first business\'s website is typed')
    await page.waitForFunction(() => document.querySelector('[data-testid=landing-demo]')?.getAttribute('data-step') === 'live', null, { timeout: 15000 })
    const dt = await demo.innerText()
    for (const c of ['Reading your site', 'Building your profile', 'Searching hiring & funding news', 'Checking evidence', '3 leads ready', '2 more held for your review', 'Live · runs weekly']) assert.ok(dt.includes(c), c)
    assert.equal(await demo.locator('[data-state=done]').count(), 4, 'all four checks ticked')
    assert.equal(await page.getByTestId('demo-label').innerText(), 'Illustrative example · made-up companies and people', 'the demo says it is an example, on screen')
    assert.match(await demo.getAttribute('aria-label'), /^Illustrative example/, 'and to screen readers')
    const leads = demo.getByTestId('demo-lead'); assert.equal(await leads.count(), 3)
    for (let i = 0; i < 3; i++) {
      assert.match(await leads.nth(i).innerText(), /^[A-Z]{2}\n.+ .+ · .+\n?fit [45]\/5\n?“.+”/s, 'name, title · company, fit pill, quoted line')
      assert.match(await leads.nth(i).getByTestId('demo-evidence').innerText(), /^\S+\.example\s+\d{1,2} \w{3} 2026\s+✓ Company and date checked$/, 'source, date and the checked mark')
    }
    assert.equal(await page.getByTestId('hero-contrast').innerText(), 'Evidence for every ready lead, not a list of guesses.')
    assert.match(await page.locator('main').innerText(), /You approve each send, unless you turn on Autopilot/)
    assert.doesNotMatch(await page.locator('main').innerText(), /Nothing sends until you approve it/)
    await demo.scrollIntoViewIfNeeded(); await page.waitForTimeout(600)
    // Any business, any country: five very different businesses to pick from; picking one replays the run for it.
    assert.deepEqual(await page.getByTestId('demo-chips').getByRole('button').allTextContents(), ['B2B SaaS · London', 'Marketing agency · Toronto', 'Dental group · New York', 'Commercial real estate · Gurugram', 'Logistics · Dubai'])
    assert.equal(await page.getByTestId('hero-any').innerText(), 'Made for any business, anywhere: paste your website and dazl drafts who buys from you. What it finds depends on the public evidence available for your market.')
    await page.getByTestId('demo-chips').getByRole('button', { name: 'Logistics · Dubai' }).click()
    assert.equal(await page.getByTestId('demo-scenario').getAttribute('data-scenario'), 'logistics-dubai')
    assert.equal(await page.getByTestId('demo-chips').getByRole('button', { name: 'Logistics · Dubai' }).getAttribute('aria-pressed'), 'true')
    await page.waitForFunction(() => document.querySelector('[data-testid=landing-demo]')?.getAttribute('data-step') === 'live', null, { timeout: 15000 })
    assert.match(await demo.innerText(), /gulfroute-freight\.example[\s\S]*Desert Bloom Home[\s\S]*UAE retailers and e-commerce brands scaling deliveries/)
    await page.waitForTimeout(600)
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${kind}-demo.png`) })
    // 3. Steps, proof, pricing, footer.
    assert.deepEqual((await page.getByTestId('step').locator('h3').allInnerTexts()), ['Paste your website', 'Get new leads every week', 'Approve and send'])
    assert.match(await page.getByTestId('proof').innerText(), /Quoted and linked[\s\S]*Company and date checked/)
    if (process.env.SHOTS) await page.getByTestId('proof').screenshot({ path: path.join(process.env.SHOTS, `${kind}-proof.png`) })
    assert.match(await page.locator('#pricing').innerText(), /\$0[\s\S]*\$49/)
    assert.match(await page.locator('footer').innerText(), /Terms[\s\S]*Privacy/)
    // 4. Nothing of the old page.
    const all = await main.innerText()
    for (const gone of [/Illustration only/i, /site blocked/i, /BYOK/, /\bFIND\b|\bVERIFY\b/]) assert.doesNotMatch(all, gone, String(gone))
    assert.doesNotMatch(await page.locator('section').first().innerText(), /trial scan|own key/i, 'no BYOK or trial scans in the hero')
    assert.equal(await page.locator('main .mono, main .tab, main .badge').count(), 0, 'no monospace tabs or badges')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll (${kind})`)
    if (process.env.SHOTS) { await page.locator('#how').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(process.env.SHOTS, `${kind}-steps.png`) }); await page.screenshot({ path: path.join(process.env.SHOTS, `${kind}-full.png`), fullPage: true }) }
    await ctx.close()
  }
  console.log('landing UI check passed: one-line hero + one Start free (Google) + See how it works; demo types a URL, ticks 4 checks, 3 ready leads (2 held) with 3 cards, labelled as an example, Play live weekly; 3 steps, proof, pricing, footer; old tabs/monospace/disclaimer/BYOK gone; no horizontal scroll at 390px')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
