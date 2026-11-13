// Rendered check for #683 (part of #352): the live audit's NYC dental zero-ready run shows ZERO actionable review items on
// Campaigns, on the campaign's own page and on Home's checklist; its research-only leads are counted separately, and the
// next step on each page is one that can change the result (a new search), never "review". NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/research-not-review.ui.mjs   (SHOTS=<dir> saves 1280 and 390 px screenshots)
// Real production build, throwaway SQLite database seeded by research-not-review-seed.mts, REAL /api routes, server under
// test/helpers/net-fence.ts, off-host requests aborted. No scan, no provider call, nothing written by loading the pages.
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pickUiPort } from '../helpers/ui-port.mjs'
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(dir, 'package.json'))
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? ' (allowed by SMOKE_ALLOW_SKIP=1)' : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
let chromium
try { ({ chromium } = require('playwright')) } catch (e) { notRun(e.message.split('\n')[0]) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-research683-')); const DB = path.join(tmp, 'app.db')
const token = randomBytes(32).toString('hex')
execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(dir, 'test/ui/research-not-review-seed.mts'), DB, token], { cwd: dir, stdio: 'inherit' })
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const fence = pathToFileURL(path.join(dir, 'test/helpers/net-fence.ts')).href
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${fence}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const NYC = 'a'.repeat(24), QUERY = 'Dental practices in New York hiring front desk staff'
const CHANGE = `/app/leads?q=${encodeURIComponent(QUERY)}`
const shot = async (target, name) => { if (process.env.SHOTS) await target.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) }
const b = await chromium.launch()
let failed = false
try {
  for (const w of [1280, 640, 390]) {
    const ctx = await b.newContext({ viewport: { width: w, height: w > 500 ? 900 : 844 } })
    await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
    const writes = []
    await ctx.route('**/*', async route => {
      const req = route.request(); const u = new URL(req.url())
      if (u.origin !== base) return route.abort()
      if (u.pathname.startsWith('/api/') && req.method() !== 'GET') writes.push(`${req.method()} ${u.pathname}`)
      return route.continue()
    })
    const page = await ctx.newPage()
    const tag = w >= 1000 ? 'desktop' : w >= 600 ? 'tablet' : 'mobile'

    // 1. Campaigns: the NYC card asks for no review; its research leads are counted as research, its next step changes the search.
    await page.goto(`${base}/app/campaigns`, { waitUntil: 'networkidle' })
    const card = page.getByTestId('campaign').first(); await card.waitFor({ timeout: 20000 })
    assert.equal(await page.getByTestId('campaign').count(), 1, "only A's search; B's never shows")
    assert.equal(await card.getByTestId('stage-qualification').textContent(), 'Qualification0 source-checked, 0 confirmed by you, 0 to review0 timing not confirmed, 2 research only, 0 unverified, 0 rejected')
    assert.equal(await card.getByTestId('run-tag').textContent(), 'Research only')
    assert.equal(await card.getByTestId('next-action').textContent(), '2 research-only leads: checking them cannot make them ready. Change the search')
    assert.equal(await card.getByTestId('next-action').getAttribute('href'), CHANGE)
    assert.doesNotMatch(await card.textContent(), /need(s)? your review|Needs your review|Check \d+ lead/)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll at ${w}px`)
    await shot(card, `campaigns-card-${tag}`)

    // 2. The campaign's own page: tag, status line, next step and every lead row say research only.
    await page.goto(`${base}/app/campaigns/${NYC}`, { waitUntil: 'networkidle' })
    await page.getByTestId('lead-status').first().waitFor({ timeout: 20000 })
    assert.equal(await page.getByTestId('run-tag').textContent(), 'Research only')
    assert.match(await page.getByTestId('campaign-status').textContent(), /^Scan: 2 leads found: 0 source-checked, 0 confirmed by you, 0 need your review, 2 research only, 0 rejected/)
    assert.equal(await page.getByTestId('next-step').textContent(), 'Change the search')
    assert.equal(await page.getByTestId('next-step').getAttribute('href'), CHANGE)
    assert.match(await page.getByTestId('outcome-detail').textContent(), /cannot make them ready/)
    const rows = await page.getByTestId('campaign-lead').evaluateAll(els => els.map(e => [e.children[0].textContent, e.children[1].textContent]))
    assert.deepEqual(rows, [['Synthetic Smiles NYC', 'Research only - checking the source cannot make it ready'], ['Example Dental Group', 'Research only - checking the source cannot make it ready']])
    // Hermes-PC review at feeda320/f65e2a95: on a phone each row keeps its company name and the status stays inside the row
    const boxes = await page.getByTestId('campaign-lead').evaluateAll(els => els.map(e => { const li = e.getBoundingClientRect(), n = e.children[0].getBoundingClientRect(), st = e.children[1].getBoundingClientRect(); return { li: [li.left, li.right], name: [n.left, n.right, n.width], nameFull: e.children[0].scrollWidth, status: [st.left, st.right], spill: e.children[1].scrollWidth - e.children[1].clientWidth } }))
    for (const [i, x] of boxes.entries()) {
      assert.ok(x.name[2] >= Math.min(60, x.nameFull), `${w}px row ${i}: the company name is visible (${x.name[2]}px of ${x.nameFull}px)`)
      assert.ok(x.spill <= 1, `${w}px row ${i}: the status text stays inside its own box (spills ${x.spill}px)`)
      assert.ok(x.status[1] <= x.li[1] + 0.5 && x.status[0] >= x.li[0] - 0.5, `${w}px row ${i}: the status stays inside the row (${JSON.stringify(x)})`)
      assert.ok(x.name[1] <= x.li[1] + 0.5, `${w}px row ${i}: the name stays inside the row`)
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll at ${w}px`)
    await shot(page, `campaign-page-${tag}`)

    // 3. Home's checklist: the Qualified-lead step names the research, links to a new search, and offers no Review leads button.
    await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
    const q = page.getByTestId('rc-qualified'); await q.waitFor({ timeout: 20000 })
    const qt = await q.textContent()
    assert.match(qt, /2 leads in this search are research only - checking them cannot make them ready/)
    assert.doesNotMatch(qt, /need your review|Review leads/)
    assert.equal(await q.getByRole('link', { name: 'Change the search' }).getAttribute('href'), CHANGE)
    await q.scrollIntoViewIfNeeded(); await shot(page.getByTestId('ready-card'), `home-ready-card-${tag}`)

    assert.deepEqual(writes, [], 'loading the pages writes nothing')
    await ctx.close()
    console.log(`ok ${w}px: Campaigns, campaign page and Home show 0 review items, 2 research only, next step Change the search`)
  }
} catch (e) { failed = true; console.error(e) } finally {
  await b.close(); srv.kill()
  await new Promise(r => setTimeout(r, 1500)); try { rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows may hold the db file briefly */ }
}
process.exit(failed ? 1 : 0)
