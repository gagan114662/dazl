// Rendered check for the Campaigns view. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/campaigns.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build and the REAL /api/campaigns route over a seeded throwaway SQLite file (campaigns-seed.mts);
// the server runs under test/helpers/net-fence.ts and every other /api/* call is stubbed in the browser. It proves:
//   1. the nav has Campaigns; the page shows one card per own search (newest first), never another tenant's;
//   2. each card shows discovery, qualification, contact, outreach, sequence and replies counts as stored;
//   2b. qualification uses the server's evidence states: a legacy row (confidence, contact, no excerpt) is unverified
//      and never offered as ready to draft;
//   3. the next action follows the pipeline (review before drafts, drafts before sending) and links to the page where
//      that step and its checks live;
//   3b. a run that produced no leads says how it ended, in the same words as its page and the Leads history: Austin
//      extracted nothing (not "failed") and offers "See what the scan read"; Leeds is a technical failure (key
//      rejected) and offers "Check your AI key in Settings";
//   4. loading the page writes nothing.
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import path from 'node:path'
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(dir, 'package.json'))
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? ' (allowed by SMOKE_ALLOW_SKIP=1)' : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
let chromium
try { ({ chromium } = require('playwright')) } catch (e) { notRun(e.message.split('\n')[0]) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-campaigns-')); const DB = path.join(tmp, 'app.db')
const token = randomBytes(32).toString('hex')
execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(dir, 'test/ui/campaigns-seed.mts'), DB, token], { cwd: dir, stdio: 'inherit' })
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }
const b = await chromium.launch()
try {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const writes = []
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url())
    if (u.origin !== base) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    if (req.method() !== 'GET') writes.push(`${req.method()} ${u.pathname}`)
    if (u.pathname === '/api/campaigns' || u.pathname.startsWith('/api/campaigns/')) return route.continue() // the real routes and the seeded database
    if (u.pathname === `/api/leads/${'8'.repeat(24)}/quarantine`) return route.continue() // the real reject (quarantine) route, #350
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/app/campaigns`, { waitUntil: 'networkidle' })
  const cards = page.getByTestId('campaign')
  await cards.first().waitFor({ timeout: 15000 })
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'campaigns.png'), fullPage: true })
  assert.equal(await page.locator('aside').getByRole('link', { name: 'Campaigns' }).getAttribute('href'), '/app/campaigns')
  assert.equal(await cards.count(), 6)
  assert.doesNotMatch(await page.locator('main').textContent(), /B-ONLY SEARCH/, "another tenant's search never shows")
  const [dental, leeds, legacy, austin, nyc, ohio] = [cards.nth(0), cards.nth(1), cards.nth(2), cards.nth(3), cards.nth(4), cards.nth(5)]
  const text = async (card, s) => (await card.getByTestId(`stage-${s}`).textContent())
  assert.match(await austin.textContent(), /Orthodontists in Austin/)
  // 3b. Austin extracted nothing: it never reads "failed" (the London report), and its next step matches its page.
  assert.equal(await austin.getByTestId('run-tag').textContent(), 'Nothing extracted')
  assert.equal(await austin.getByTestId('run-label').textContent(), 'No candidates were extracted')
  assert.doesNotMatch(await austin.textContent(), /failed/i)
  assert.equal(await austin.getByTestId('next-action').textContent(), 'See what the scan read')
  assert.equal(await austin.getByTestId('next-action').getAttribute('href'), `/app/leads?job_id=${'c'.repeat(24)}`)
  assert.equal(await leeds.getByTestId('run-tag').textContent(), 'Technical failure')
  assert.equal(await leeds.getByTestId('run-label').textContent(), 'Failed - the AI provider rejected the key this scan used')
  assert.equal(await leeds.getByTestId('next-action').textContent(), 'Check your AI key in Settings')
  assert.equal(await ohio.getByTestId('run-tag').textContent(), 'Leads found (counts not recorded)', 'an older run that saved leads but not its check counts')
  assert.equal(await ohio.getByTestId('run-label').count(), 0, 'a run with results keeps the pipeline\'s next action, no extra line')
  // NYC's two stored drafts are for leads whose timing is not confirmed: the approve gate refuses them, so the card
  // recommends the source review, never "approve" (Instinct #239, 60176be).
  assert.equal(await nyc.getByTestId('next-action').textContent(), 'Review the source of 2 leads to confirm timing')
  assert.equal(await nyc.getByTestId('next-action').getAttribute('href'), `/app/leads?job_id=${'b'.repeat(24)}`)
  assert.equal(await text(nyc, 'outreach'), 'Outreach2 draft, 0 approved, 0 sent2 held, 0 waiting on setup')
  assert.match(await ohio.textContent(), /Dental owners in Ohio/)
  assert.equal(await text(ohio, 'discovery'), 'Discovery4 foundfrom 9 candidates')
  assert.equal(await text(ohio, 'qualification'), 'Qualification2 source-checked, 0 confirmed by you, 1 to review2 timing not confirmed, 0 unverified, 1 rejected')
  assert.equal(await text(ohio, 'contact'), 'Contact2 with a contact')
  assert.equal(await text(ohio, 'outreach'), 'Outreach1 draft, 0 approved, 1 sent1 held, 0 waiting on setup')
  assert.equal(await text(ohio, 'sequence'), 'Sequence0 running0 finished or stopped')
  assert.equal(await text(ohio, 'replies'), 'Replies1 replied, 1 interested0 bounced, 0 opted out')
  assert.equal(await ohio.getByTestId('next-action').textContent(), 'Check 1 lead that needs your review', 'review comes before the waiting draft')
  assert.equal(await ohio.getByTestId('next-action').getAttribute('href'), `/app/leads?job_id=${'a'.repeat(24)}`)
  // The legacy row is unverified (no stored excerpt) and is never offered as ready to draft.
  assert.match(await legacy.textContent(), /Legacy search/)
  assert.equal(await text(legacy, 'qualification'), 'Qualification0 source-checked, 0 confirmed by you, 0 to review0 timing not confirmed, 1 unverified, 0 rejected')
  assert.equal(await text(legacy, 'contact'), 'Contact1 with a contact')
  assert.equal(await legacy.getByTestId('next-action').textContent(), 'Check 1 unverified lead against their sources', 'an honest research step, never "nothing waiting"')
  if (process.env.SHOTS) {
    await page.screenshot({ path: path.join(process.env.SHOTS, 'campaigns-desktop.png') })
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scroll at 390px')
    for (const c of await cards.all()) { const cb = await c.boundingBox(); for (const el of [c.getByTestId('next-action'), c.getByTestId('campaign-link')]) { const bb = await el.boundingBox(); assert.ok(bb.x >= cb.x && bb.x + bb.width <= cb.x + cb.width + 0.5, 'the title and next action stay inside the card at 390px') } }
    await page.screenshot({ path: path.join(process.env.SHOTS, 'campaigns-mobile.png') })
  }
  assert.deepEqual(writes, [], 'loading the page writes nothing')
  // #350: the scan recorded 1 found, 1 source-checked. Before any review the card says leads found, from the lead as it is.
  assert.equal(await dental.getByTestId('run-tag').textContent(), 'Leads found')
  assert.equal(await dental.getByTestId('run-tag').getAttribute('title'), '1 lead found: 1 source-checked, 0 confirmed by you, 0 need your review, 0 rejected')
  // Reject the final lead through the real route, then reload: every surface of the card follows the current state.
  await page.setViewportSize({ width: 1280, height: 900 })
  const rej = await page.evaluate(id => fetch(`/api/leads/${id}/quarantine`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Rejected: Not a fit' }) }).then(r => r.status), '8'.repeat(24))
  assert.equal(rej, 200)
  const nonePassed = async (w) => {
    await page.setViewportSize({ width: w, height: w > 500 ? 900 : 844 })
    await page.reload({ waitUntil: 'networkidle' }); await cards.first().waitFor({ timeout: 15000 })
    const d = page.getByTestId('campaign').first()
    assert.match(await d.textContent(), /Dental practices in a big city/)
    assert.equal(await d.getByTestId('run-tag').textContent(), 'None passed', 'status')
    assert.equal(await d.getByTestId('run-tag').getAttribute('title'), 'None passed: you rejected the 1 lead this search found', 'tooltip: not the scan-time "1 source-checked"')
    assert.equal(await d.getByTestId('run-label').textContent(), 'None passed: you rejected the 1 lead this search found')
    assert.equal(await text(d, 'discovery'), 'Discovery1 foundfrom 1 candidates')
    assert.equal(await text(d, 'qualification'), 'QualificationNone passed: 1 rejected0 timing not confirmed, 0 unverified, 1 rejected', 'funnel')
    assert.equal(await d.getByTestId('next-action').textContent(), 'Try a broader search', 'next step')
    assert.equal(await d.getByTestId('next-action').getAttribute('href'), `/app/leads?q=${encodeURIComponent('Dental practices in a big city - opening a new location')}`)
    assert.doesNotMatch(await d.textContent(), /Leads found|Nothing waiting on you/)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll at ${w}px`)
    if (process.env.SHOTS) await d.screenshot({ path: path.join(process.env.SHOTS, `none-passed-card-${w > 500 ? 'desktop' : 'mobile'}.png`) })
  }
  await nonePassed(1280); await nonePassed(390)
  // The campaign's own page (real route) says the same after a reload.
  for (const w of [1280, 390]) {
    await page.setViewportSize({ width: w, height: w > 500 ? 900 : 844 })
    await page.goto(`${base}/app/campaigns/${'7'.repeat(24)}`, { waitUntil: 'networkidle' })
    await page.getByTestId('run-tag').waitFor({ timeout: 15000 })
    assert.equal(await page.getByTestId('run-tag').textContent(), 'None passed')
    assert.match(await page.getByTestId('campaign-status').textContent(), /^Scan: None passed: you rejected the 1 lead this search found/)
    assert.equal(await page.getByTestId('next-step').textContent(), 'Try a broader search')
    assert.equal(await page.getByTestId('lead-status').textContent(), 'Rejected: Not a fit')
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `none-passed-page-${w > 500 ? 'desktop' : 'mobile'}.png`), fullPage: true })
  }
  assert.deepEqual(writes, [`POST /api/leads/${'8'.repeat(24)}/quarantine`], 'the only write is the one reject')
  console.log('campaigns UI check passed: 6 own campaigns (run states: nothing extracted, technical failure, leads found, none passed after rejecting the last lead, after reload, card + page) (incl. a legacy unverified lead), stage counts and next actions from the real route')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
