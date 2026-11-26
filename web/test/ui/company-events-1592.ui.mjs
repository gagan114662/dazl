// Rendered check for #1592: a discovery-lane company-event lead shows its event kind and the funding amount as the
// page printed it, beside the why-now line and the dated proof; a non-event discover lead keeps today's line.
// NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/company-events-1592.ui.mjs   (SHOTS=<dir> saves 1280 and 390 px screenshots)
// Real production build, throwaway SQLite database seeded by company-events-1592-seed.mts, REAL /api routes, server
// under test/helpers/net-fence.ts, off-host requests aborted. No scan, no provider call, nothing written by loading
// the page. Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 -> 0).
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-r1592-')); const DB = path.join(tmp, 'app.db')
const token = randomBytes(32).toString('hex')
execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(dir, 'test/ui/company-events-1592-seed.mts'), DB, token], { cwd: dir, stdio: 'inherit' })
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const fence = pathToFileURL(path.join(dir, 'test/helpers/net-fence.ts')).href
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${fence}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const JOB = 'f'.repeat(24)
const shot = async (target, name) => { if (process.env.SHOTS) await target.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) }
const b = await chromium.launch()
try {
  for (const w of [1280, 390]) {
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

    await page.goto(`${base}/app/leads?job_id=${JOB}`, { waitUntil: 'networkidle' })
    // The lead cards keep the detail lines collapsed behind a "Details" disclosure; open them before asserting.
    for (const s of await page.locator('summary', { hasText: 'Details' }).all()) await s.click()
    // 1. The event lead's card line: the kind and the amount exactly as the page printed them, before the confidence.
    const eventRow = page.getByTestId('discover-confidence').filter({ hasText: 'Funding round US$4.2 million' })
    await eventRow.waitFor({ timeout: 20000 })
    const text = (await eventRow.textContent()) ?? ''
    assert.match(text, /Funding round US\$4\.2 million\. Confidence: high/, 'the event line leads the discover card line')
    assert.doesNotMatch(text, /Missing/, 'a dated, proven event names its person and website')
    // 2. The why-now line rides the saved grade disclosure inside the same card.
    const card = eventRow.locator('xpath=ancestor::details[1]').first()
    await card.locator('summary', { hasText: 'Saved historical grade' }).click()
    assert.match((await card.textContent()) ?? '', /a first round pays for the fit-out the seller quotes/, 'why-now is shown')
    // 3. The buyer the run recorded for this event is named on the card.
    const buyer = page.getByText('Dana Ruiz').first()
    await buyer.waitFor({ timeout: 10000 })
    // 4. The control lead keeps today's line: no event words, no amount.
    assert.equal(await page.getByTestId('discover-confidence').count(), 2, 'one line per discover lead')
    assert.equal(await page.getByTestId('discover-confidence').filter({ hasText: /Funding|US\$/ }).count(), 1, 'exactly one event line: the non-event lead keeps today\'s wording')
    assert.equal(writes.length, 0, 'loading the page writes nothing')

    await shot(page, `1592-${w}`)
    await ctx.close()
  }
  console.log('OK: 1280 and 390 - the funding event card shows kind, printed amount, why-now and buyer; the control row keeps its line')
  srv.kill(); process.exit(0)
} catch (e) {
  console.error(String(e && e.message ? e.message : e))
  srv.kill(); process.exit(1)
} finally { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* already gone */ } }
