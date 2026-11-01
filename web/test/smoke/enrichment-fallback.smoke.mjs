// The Apollo -> PDL fallback opt-in (#382), end to end on a production build. NOT part of `npm test`.
// Run after `npm run build`:  npm run test:smoke:enrichment [-- <screenshot dir>]
// A PDL key saved under the original wording is not consent to paid fallback credits: the opt-in must render
// OFF by default only once both keys are connected, toggling it must persist server-side across a reload, and
// the flag must never appear as a connector. Screenshots prove the rendered pixels; DB reads prove persistence.
// The server is net-fenced: no page load or key save can reach Apollo, PDL or any paid API.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { loadPlaywright, newContext, root, startServer } from './harness.mjs'
const { chromium } = loadPlaywright()
const require = createRequire(path.join(root, 'package.json'))

const out = path.resolve(process.argv[2] ?? path.join(root, 'preview', 'enrichment-fallback'))
mkdirSync(out, { recursive: true })
let dbPath
const srv = await startServer({
  env: { DAZL_MASTER_KEY: randomBytes(32).toString('base64') },
  prepare: async p => {
    dbPath = p
    const { migrateAllSqlite } = await import('../../lib/db/sqlite-migrations.ts')
    const d = new (require('better-sqlite3'))(p)
    try { migrateAllSqlite(d) } finally { d.close() }
  },
})
const flagRow = () => {
  const d = new (require('better-sqlite3'))(dbPath)
  try { return d.prepare("SELECT enabled, ciphertext FROM tenant_connectors WHERE tenant_id = 'smoke-user' AND connector = 'enrich:fallback'").get() ?? null } finally { d.close() }
}

let browser
const shots = []
try {
  browser = await chromium.launch()
  const ctx = await newContext(browser, srv)
  const page = await ctx.newPage()
  // Diagnostics whitelist: only the fields a refusal can carry. The route never returns stored keys (status exposes
  // last4 of the FIXTURE key only), but scrub the fixture values anyway and never log request payloads.
  const FIXTURES = ['smoke-apollo-key-0000000000000000', 'smoke-pdl-key-00000000000000000000']
  const scrub = t => FIXTURES.reduce((acc, k) => acc.split(k).join('<fixture-key>'), t)
  page.on('request', r => { if (r.url().includes('/api/settings/enrichment') && r.method() === 'POST') console.log(`[enrichment-api] POST -> ${JSON.stringify(Object.keys(JSON.parse(r.postData() ?? '{}')))}`) })
  page.on('response', async r => {
    if (!r.url().includes('/api/settings/enrichment')) return
    let safe = '?'
    try {
      const j = JSON.parse(await r.text())
      if (Array.isArray(j.connectors)) j.connectors = j.connectors.map(c => ({ connector: c.connector, enabled: c.enabled, last4: c.last4 }))
      if (Array.isArray(j.audit)) j.audit = j.audit.map(a => ({ connector: a.connector, lookup: a.lookup, status: a.status }))
      safe = JSON.stringify({ ok: j.ok, error: j.error, fallback: j.fallback, connectors: j.connectors, audit: j.audit?.slice(0, 5) })
    } catch { safe = '<unparseable body withheld>' }
    console.log(scrub(`[enrichment-api] ${r.request().method()} ${r.status()} ${safe.slice(0, 400)}`))
  })
  page.on('console', m => { if (m.type() === 'error') console.log(`[page-console-error] ${m.text().slice(0, 300)}`) })
  page.on('pageerror', e => console.log(`[pageerror] ${String(e).slice(0, 300)}`))
  await page.goto(`${srv.base}/app/settings`)
  await page.getByText('Enrichment (bring your own key)', { exact: true }).waitFor()

  const card = page.locator('div.card', { hasText: 'Enrichment (bring your own key)' })

  // No keys: the opt-in must not render at all.
  assert.equal(await card.getByText('Also use People Data Labs as a fallback').count(), 0, 'no fallback checkbox before both keys are connected')

  // Save both keys through the real UI (values are invented; the net fence blocks any real provider call).
  await card.getByPlaceholder('Paste your Apollo.io API key').fill('smoke-apollo-key-0000000000000000')
  await card.getByRole('button', { name: 'Save', exact: true }).first().click() // both slots render Save until Apollo shows Connected; PDL's is unique after
  try {
    await card.getByText(/Connected \(key ending 0000\)/).first().waitFor()
  } catch (e) {
    const p = path.join(out, 'first-save-failed.png'); await page.screenshot({ path: p, fullPage: true }); shots.push(p)
    console.log(`[first-save-failed] card text at timeout: ${(await card.textContent())?.slice(0, 400)}`)
    throw e
  }
  await card.getByPlaceholder('Paste your People Data Labs API key').fill('smoke-pdl-key-00000000000000000000')
  await card.getByRole('button', { name: 'Save', exact: true }).click()
  await card.getByText(/Connected \(key ending 0000\)/).nth(1).waitFor()

  // Both keys connected: the opt-in renders, OFF by default, with the paid-credit wording at the control.
  const toggle = card.locator('label', { hasText: 'Also use People Data Labs as a fallback' }).getByRole('checkbox')
  await toggle.waitFor()
  assert.equal(await toggle.isChecked(), false, 'the fallback is OFF by default')
  await card.getByText('Off by default.').waitFor()
  await card.getByText('1 of your PDL credits').waitFor()
  let p = path.join(out, 'fallback-off.png'); await card.screenshot({ path: p }); shots.push(p)
  assert.equal(flagRow(), null, 'no flag row exists before the tenant ever opts in')

  // Opt in through the control; the flag must persist in the DB and across a reload.
  await toggle.click()
  await page.getByText('Saved.').waitFor()
  assert.deepEqual(flagRow(), { enabled: 1, ciphertext: '' }, 'opt-in persisted as a secret-less flag row')
  await page.reload()
  await page.getByText('Enrichment (bring your own key)', { exact: true }).waitFor()
  const toggle2 = card.locator('label', { hasText: 'Also use People Data Labs as a fallback' }).getByRole('checkbox')
  await toggle2.waitFor()
  assert.equal(await toggle2.isChecked(), true, 'the opt-in survives a reload')
  p = path.join(out, 'fallback-on.png'); await card.screenshot({ path: p }); shots.push(p)

  // The flag never surfaces as a connector, and GET reports it under its own field.
  const status = await page.evaluate(async () => (await (await fetch('/api/settings/enrichment')).json()))
  assert.deepEqual(status.connectors.map(c => c.connector).sort(), ['enrich:apollo', 'enrich:pdl'], 'no phantom connector')
  assert.equal(status.fallback, true, 'GET reports the opt-in')

  // Opt out again: the flag flips off, keys untouched.
  await toggle2.click()
  await page.getByText('Saved.').waitFor()
  assert.deepEqual(flagRow(), { enabled: 0, ciphertext: '' }, 'opt-out persisted')
  assert.equal((await page.evaluate(async () => (await (await fetch('/api/settings/enrichment')).json()))).fallback, false)

  console.log('enrichment-fallback smoke OK')
  for (const s of shots) console.log('screenshot:', s)
} finally {
  if (browser) await browser.close()
  srv.stop()
}
