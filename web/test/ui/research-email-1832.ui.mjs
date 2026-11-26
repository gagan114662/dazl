// Rendered check for #1832: a Research-only row shows the email the company published - even a restricted inbox,
// even under a hold that is not a searchable one - with its source link, and stays not approvable. NOT part of
// `npm test`.
// Run:  cd web && npm run build && node test/ui/research-email-1832.ui.mjs   (SHOTS=<dir> saves 1280 and 390 px screenshots)
// Real production build, throwaway SQLite database seeded by research-email-1832-seed.mts, REAL /api routes, server
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-r1832-')); const DB = path.join(tmp, 'app.db')
const token = randomBytes(32).toString('hex')
execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(dir, 'test/ui/research-email-1832-seed.mts'), DB, token], { cwd: dir, stdio: 'inherit' })
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const fence = pathToFileURL(path.join(dir, 'test/helpers/net-fence.ts')).href
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${fence}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const JOB = 'e'.repeat(24)
const shot = async (target, name) => { if (process.env.SHOTS) await target.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) }
const b = await chromium.launch()
let failed = false
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
    const tag = w >= 1000 ? 'desktop' : 'mobile'

    await page.goto(`${base}/app/leads?job_id=${JOB}`, { waitUntil: 'networkidle' })
    const research = page.getByTestId('research-list'); await research.waitFor({ timeout: 20000 })
    const rows = research.getByTestId('review-row')
    assert.equal(await rows.count(), 3, 'the three research-only leads, all in the Research list')
    const rowOf = name => rows.filter({ hasText: name })

    // 1. A hold that is not a searchable one: the published-email line renders at all, display only, with the cited page as its source.
    const r1 = rowOf('Synthetic Counterparty Co')
    const line1 = r1.getByTestId('published-work-email'); await line1.waitFor({ timeout: 10000 })
    const t1 = await line1.textContent()
    assert.match(t1, /press@synthetic\.example/)
    assert.match(t1, /display only/)
    assert.match(t1, /press inbox, not a sales contact/)
    assert.equal(await line1.getByRole('link').getAttribute('href'), 'https://news.example/x', 'the source link is the cited page that prints the address')
    assert.equal(await r1.getByRole('button', { name: /approve/i }).count(), 0, 'no approve control on a research row')

    // 2. A searchable hold with a restricted inbox: the address shows instead of "unavailable".
    const line2 = rowOf('Synthetic Support Co').getByTestId('published-work-email')
    const t2 = await line2.textContent()
    assert.match(t2, /support@synthetic\.example/)
    assert.match(t2, /support inbox, not a sales contact/)
    assert.doesNotMatch(t2, /unavailable/)

    // 3. No address: says so plainly, and never invents one.
    assert.match(await rowOf('Synthetic No Email Co').getByText('Published work email unavailable').textContent(), /Published work email unavailable/)
    assert.equal(await rowOf('Synthetic No Email Co').getByTestId('published-work-email').count(), 0, 'no email line is invented for a lead with none')

    // Display only: the line holds no control of its own, and loading the page writes nothing.
    for (const l of [line1, line2]) assert.equal(await l.getByRole('button').count(), 0, 'the email line has no button')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll at ${w}px`)
    await shot(research, `research-email-${tag}`)
    assert.deepEqual(writes, [], 'loading the page writes nothing')
    await ctx.close()
    console.log(`ok ${w}px: research rows show the published email with its source link, display only, not approvable`)
  }
} catch (e) { failed = true; console.error(e) } finally {
  await b.close(); srv.kill()
  await new Promise(r => setTimeout(r, 1500)); try { rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows may hold the db file briefly */ }
}
process.exit(failed ? 1 : 0)
