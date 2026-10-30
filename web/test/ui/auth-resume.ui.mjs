// Rendered check for #416 on a real production build over a throwaway SQLite file. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/auth-resume.ui.mjs   (SHOTS=<dir> also saves desktop and mobile screenshots)
// 1. Signed out, a deep /app link goes to sign-in carrying the page; signing up there lands on that page.
// 2. An unsafe ?next= is never followed: signing in lands on /app.
// 3. An invitation link (/app/claim) made for this account opens its page; one for another address, or edited, is
//    refused with the reason and changes nothing.
// The network fence drops every *KEY* variable; the synthetic master key comes back through test/smoke/stripe-test-env.mjs.
// Synthetic accounts and keys only; no network beyond the local server. Exit 1 on a failed expectation; missing
// playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-resume-')); const DB = path.join(tmp, 'app.db')
const MASTER = randomBytes(32).toString('base64')
const mint = (to, p, exp = Math.floor(Date.now() / 1000) + 3600) => execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e',
  `import('${path.join(dir, 'lib/preview-claim.ts')}').then(m => process.stdout.write(m.mintClaim(Buffer.from(process.env.K, 'base64'), { to: ${JSON.stringify(to)}, path: ${JSON.stringify(p)}, exp: ${exp} })))`], { env: { ...process.env, K: MASTER }, encoding: 'utf8' })
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SMOKE_MASTER_B64: MASTER, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')} --import ${path.join(dir, 'test/smoke/stripe-test-env.mjs')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }
const b = await chromium.launch()
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
try {
  for (const [vp, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const ctx = await b.newContext({ viewport })
    const page = await ctx.newPage()
    // 1. deep link while signed out -> sign-in with the page kept -> "Create an account" keeps it -> sign up -> that page
    await page.goto(`${base}/app/plays?id=demo-7`)
    await page.waitForURL(/\/sign-in\?next=/)
    assert.equal(new URL(page.url()).searchParams.get('next'), '/app/plays?id=demo-7')
    assert.equal(await page.getByRole('link', { name: 'Continue with Google' }).getAttribute('href'), '/api/auth/google?next=%2Fapp%2Fplays%3Fid%3Ddemo-7')
    await shot(page, `416-sign-in-${vp}`)
    await page.getByRole('link', { name: 'Create an account' }).click()
    await page.waitForURL(/\/sign-up\?next=/)
    const email = `owner-${vp}@prospect.example`
    await page.getByPlaceholder('Your name').fill('Pat Synthetic')
    for (const input of await page.locator('form input').all()) {
      const n = await input.getAttribute('name')
      if (n === 'business_name') await input.fill('Synthetic Roofing')
      if (n === 'email') await input.fill(email)
      if (n === 'password') await input.fill('horse-battery-42-' + vp)
    }
    await page.locator('form button[type=submit]').click()
    await page.waitForURL(u => u.pathname === '/app/plays', { timeout: 20000 }).catch(async e => { console.log('URL', page.url(), 'ALERT', await page.getByRole('alert').allInnerTexts()); throw e })
    assert.equal(new URL(page.url()).search, '?id=demo-7', 'landed on the page it was going to')
    // 3. invitation links
    await page.goto(`${base}/app/claim?t=${encodeURIComponent(mint(email, '/app/leads?job_id=demo'))}`)
    await page.waitForURL(u => u.pathname === '/app/leads', { timeout: 15000 }).catch(async e => { console.log('URL', page.url(), 'TEXT', await page.getByTestId('claim-refused').getAttribute('data-reason').catch(() => '')); throw e })
    assert.equal(new URL(page.url()).searchParams.get('job_id'), 'demo')
    await page.goto(`${base}/app/claim?t=${encodeURIComponent(mint('someone@else.example', '/app/leads'))}`)
    await page.getByTestId('claim-refused').waitFor()
    assert.match(await page.getByTestId('claim-refused').innerText(), /made for a different email address/)
    await shot(page, `416-claim-other-${vp}`)
    const good = mint(email, '/app/leads')
    await page.goto(`${base}/app/claim?t=${encodeURIComponent(good.slice(0, -2) + (good.endsWith('A') ? 'BB' : 'AA'))}`)
    await page.getByTestId('claim-refused').waitFor()
    assert.match(await page.getByTestId('claim-refused').innerText(), /This link is not valid/)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${vp}: no horizontal scroll`)
    await ctx.close()
  }
  // 2. an unsafe destination is never followed
  { const ctx = await b.newContext(); const page = await ctx.newPage()
    await page.goto(`${base}/sign-in?next=${encodeURIComponent('//evil.example/app')}`)
    assert.equal(await page.getByRole('link', { name: 'Continue with Google' }).getAttribute('href'), '/api/auth/google')
    await page.getByPlaceholder('you@company.com').fill('owner-desktop@prospect.example')
    await page.getByPlaceholder('Password').fill('horse-battery-42-desktop')
    await page.locator('form button[type=submit]').click()
    await page.waitForURL(u => u.pathname === '/app')
    assert.equal(new URL(page.url()).origin, base)
    await ctx.close() }
  console.log('auth-resume UI check passed: deep link kept through sign-in and sign-up, unsafe destination dropped, invitation link opens only for its recipient')
} finally { await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true }) }
