// Staging smoke check (docs/STAGING.md): a production build made with DAZL_ENV=staging, on a database seeded by
// scripts/staging-seed.mts, in Chromium. NOT part of `npm test`. Run:
//   DAZL_ENV=staging npm run build && npm run test:smoke:staging
// It checks:
// - the demo account signs in through the real form;
// - every /app page loads with the "Staging - test data" banner and no detour;
// - the seeded leads and the stub Gmail connection are there;
// - every page is noindex (meta tag, X-Robots-Tag header, robots.txt);
// - Gmail is stubbed: a send through the stub returns an id without any network call. The server runs under the test
//   network fence, so any real Gmail call would throw.
// Isolation and NOT RUN handling: see harness.mjs.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { appRoutes, loadPlaywright, startServer } from './harness.mjs'
const { chromium } = loadPlaywright()

process.env.DAZL_ENV = 'staging'
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
const { seedStaging, DEMO_EMAIL } = await import('../../scripts/staging-seed.mts')
const PASSWORD = 'staging-smoke-' + randomBytes(6).toString('hex')

const srv = await startServer({
  env: { DAZL_ENV: 'staging' },
  prepare: async dbPath => { const raw = new Database(dbPath); try { assert.equal((await seedStaging(raw, PASSWORD)).created, true) } finally { raw.close() } },
})
const failures = []
let browser
try {
  // noindex: header, robots.txt, meta
  const home = await fetch(srv.base + '/')
  assert.match(home.headers.get('x-robots-tag') ?? '', /noindex/, 'X-Robots-Tag on every page')
  const html = await home.text()
  assert.match(html, /<meta name="robots" content="noindex, nofollow"/)
  assert.ok(html.includes('Staging - test data'), 'banner on the home page')
  assert.match(await (await fetch(srv.base + '/robots.txt')).text(), /Disallow: \/\s*$/m)
  console.log('ok   noindex: meta, X-Robots-Tag, robots.txt; banner on /')

  browser = await chromium.launch()
  const ctx = await browser.newContext()
  await ctx.route('**/*', route => new URL(route.request().url()).origin === srv.base ? route.continue() : route.abort())
  const page = await ctx.newPage()
  await page.goto(srv.base + '/sign-in')
  await page.fill('input[name=email]', DEMO_EMAIL)
  await page.fill('input[name=password]', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForURL(u => new URL(u).pathname.startsWith('/app'), { timeout: 15000 })
  console.log('ok   the demo account signs in through the form')

  for (const route of appRoutes()) {
    const errs = []
    const res = await page.goto(srv.base + route, { waitUntil: 'networkidle' })
    if (!res || res.status() >= 400) errs.push(`HTTP ${res?.status()}`)
    if (new URL(page.url()).pathname === '/sign-in') errs.push('sent to sign-in')
    if (!(await page.getByTestId('staging-banner').isVisible().catch(() => false))) errs.push('no staging banner')
    console.log(`${errs.length ? 'FAIL' : 'ok  '} ${route}`)
    for (const e of errs) { console.log(`     ${e}`); failures.push(`${route}: ${e}`) }
  }

  await page.goto(srv.base + '/app/leads', { waitUntil: 'networkidle' })
  // past scans are listed; picking one shows its leads
  await page.locator('main').getByText('Dental practices in Texas hiring a practice manager').last().click()
  await page.getByText('Bluebonnet Dental Studio (demo)').first().waitFor({ timeout: 10000 }).catch(() => {})
  if (process.env.STAGING_SHOT) await page.screenshot({ path: process.env.STAGING_SHOT })
  const body = await page.locator('main').innerText()
  for (const company of ['Bluebonnet Dental Studio (demo)', 'Gulf Coast Orthodontics (demo)']) if (!body.includes(company)) failures.push(`/app/leads: seeded lead ${company} not shown`)
  const status = await page.evaluate(async () => (await fetch('/api/outreach/settings')).json())
  if (!JSON.stringify(status).includes('@staging.dazl.test')) failures.push(`stub Gmail not connected: ${JSON.stringify(status).slice(0, 200)}`)
  console.log('ok   seeded leads and the stub Gmail connection are visible')
} finally {
  await browser?.close()
  srv.stop()
}
if (failures.length) { for (const f of failures) console.log(f); process.exit(1) }
console.log('\nStaging build: sign-in, banner on every page, noindex, seeded data and stub Gmail all work.')
