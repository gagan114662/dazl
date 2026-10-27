// Rendered check for the Campaigns view. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/campaigns.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build and the REAL /api/campaigns route over a seeded throwaway SQLite file (campaigns-seed.mts);
// the server runs under test/helpers/net-fence.ts and every other /api/* call is stubbed in the browser. It proves:
//   1. the nav has Campaigns; the page shows one card per own search (newest first), never another tenant's;
//   2. each card shows discovery, qualification, contact, outreach, sequence and replies counts as stored;
//   3. the next action follows the pipeline (review before drafts, drafts before sending) and links to the page where
//      that step and its checks live; a failed search says so;
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
    if (u.pathname === '/api/campaigns') return route.continue() // the real route and the seeded database
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  })
  const page = await ctx.newPage()
  await page.goto(`${base}/app/campaigns`, { waitUntil: 'networkidle' })
  const cards = page.getByTestId('campaign')
  await cards.first().waitFor({ timeout: 15000 })
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'campaigns.png'), fullPage: true })
  assert.equal(await page.locator('aside').getByRole('link', { name: 'Campaigns' }).getAttribute('href'), '/app/campaigns')
  assert.equal(await cards.count(), 3)
  assert.doesNotMatch(await page.locator('main').textContent(), /B-ONLY SEARCH/, "another tenant's search never shows")
  const [austin, nyc, ohio] = [cards.nth(0), cards.nth(1), cards.nth(2)]
  assert.match(await austin.textContent(), /Orthodontists in Austin/)
  assert.equal(await austin.getByTestId('next-action').textContent(), 'Search failed. Open it to see why')
  assert.equal(await nyc.getByTestId('next-action').textContent(), 'Review and approve 2 drafts')
  assert.equal(await nyc.getByTestId('next-action').getAttribute('href'), '/app/outreach')
  assert.match(await ohio.textContent(), /Dental owners in Ohio/)
  const text = async (card, s) => (await card.getByTestId(`stage-${s}`).textContent())
  assert.equal(await text(ohio, 'discovery'), 'Discovery4 leadsfrom 9 candidates')
  assert.equal(await text(ohio, 'qualification'), 'Qualification2 source-checked, 1 to review1 rejected')
  assert.equal(await text(ohio, 'contact'), 'Contact2 with a contact')
  assert.equal(await text(ohio, 'outreach'), 'Outreach1 draft, 0 approved, 1 sent')
  assert.equal(await text(ohio, 'sequence'), 'Sequence0 running0 finished or stopped')
  assert.equal(await text(ohio, 'replies'), 'Replies1 replied, 1 interested0 bounced, 0 opted out')
  assert.equal(await ohio.getByTestId('next-action').textContent(), 'Check 1 lead that needs your review', 'review comes before the waiting draft')
  assert.equal(await ohio.getByTestId('next-action').getAttribute('href'), `/app/leads?job_id=${'a'.repeat(24)}`)
  assert.deepEqual(writes, [], 'loading the page writes nothing')
  console.log('campaigns UI check passed: 3 own campaigns, stage counts and next actions from the real route')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
