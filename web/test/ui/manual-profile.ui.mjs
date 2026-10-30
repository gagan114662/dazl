// Rendered check for #420 on a real production build over a throwaway SQLite file. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/manual-profile.ui.mjs   (SHOTS=<dir> also saves desktop and mobile screenshots)
// Two synthetic accounts sign up through the real routes. A saves a complete manual business profile (no website) through
// the real POST /api/settings/profile; after a reload Home's "Get to your first useful result" shows the business profile
// done and the next step is the one actually unmet (a search can run: no AI key here), never "Add website". B, with no
// profile, still has it to do (Home shows the first-run setup): nothing of A's shows for B. An edit that empties A's buyer profile reopens the step.
// No AI key, no scan, no network beyond the local server. Missing playwright or build: NOT RUN, exit 2
// (SMOKE_ALLOW_SKIP=1 makes it exit 0).
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-manual-')); const DB = path.join(tmp, 'app.db')
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }
const b = await chromium.launch()
const BUYER = { summary: 'Plumbing and electrical firms with 5-50 staff in Ontario', who: ['Owner', 'Office manager'], industries: ['Plumbing', 'Electrical'], sizes: ['5-50'], where: ['Ontario'], signals: [], exclude: ['Franchises'] }
const account = async (name, viewport) => {
  const ctx = await b.newContext({ viewport })
  const page = await ctx.newPage()
  await page.goto(`${base}/sign-in`)
  const r = await post(page, '/api/auth/signup', { email: `${name}@ledgerly.example`, password: 'ledger-books-42', name: 'Pat Synthetic', business_name: name.startsWith('a') ? 'Ledgerly' : 'Other Co' })
  assert.equal(r.status, 200, r.body)
  return { ctx, page }
}
// Calls the real routes from the page, so the browser keeps and sends the session cookie as it would for the app.
const post = (page, url, data) => page.evaluate(async ([u, d]) => { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(d) }); return { status: r.status, body: await r.text() } }, [url, data])
// The business profile step on Home, or 'setup' when Home shows the first-run setup instead (an account with no profile).
const profileStep = async page => {
  await page.goto(`${base}/app`)
  const s = page.getByTestId('rc-profile'), setup = page.getByTestId('onboarding-screen')
  await s.or(setup).first().waitFor({ timeout: 20000 })
  if (!(await s.count())) return { state: 'setup', text: '', next: null }
  return { state: await s.getAttribute('data-rc-state'), text: await s.innerText(), next: await page.locator('[data-rc-next="true"]').first().getAttribute('data-testid') }
}
try {
  for (const [vp, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const A = await account(`a-${vp}`, viewport), B = await account(`b-${vp}`, viewport)
    const save = await post(A.page, '/api/settings/profile', { sells: 'Bookkeeping for trades businesses', buyer: BUYER })
    assert.equal(save.status, 200, save.body)
    let a = await profileStep(A.page)
    assert.equal(a.state, 'done', `${vp}: manual profile completes the step`); assert.doesNotMatch(a.text, /Add website/)
    assert.equal(a.next, 'rc-search', `${vp}: the next step is the one actually unmet`)
    await A.page.reload(); a = await profileStep(A.page)
    assert.equal(a.state, 'done', `${vp}: still done after a reload`)
    if (process.env.SHOTS) await A.page.getByTestId('ready-card').screenshot({ path: path.join(process.env.SHOTS, `420-manual-profile-${vp}.png`) })
    assert.equal(await A.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${vp}: no horizontal scroll`)
    const bStep = await profileStep(B.page)
    assert.notEqual(bStep.state, 'done', `${vp}: B has no profile of its own: nothing of A's counts for B`)
    // A later edit that clears the buyer profile reopens the step.
    assert.equal((await post(A.page, '/api/settings/profile', { buyer: null })).status, 200)
    assert.notEqual((await profileStep(A.page)).state, 'done', `${vp}: emptied buyer profile reopens the step`)
    await A.ctx.close(); await B.ctx.close()
  }
  console.log('manual-profile UI check passed: a saved manual profile completes the business profile step across reloads, per account, and reopens when emptied')
} finally { await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true }) }
