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
  await page.goto(`${srv.base}/app/settings`)
  await page.getByText('Enrichment (bring your own key)', { exact: true }).waitFor()

  // No keys: the opt-in must not render at all.
  assert.equal(await page.getByRole('checkbox').count(), 0, 'no fallback checkbox before both keys are connected')

  // Save both keys through the real UI (values are invented; the net fence blocks any real provider call).
  await page.getByPlaceholder('Paste your Apollo.io API key').fill('smoke-apollo-key-0000000000000000')
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await page.getByText('Connected (key ending 0000)', { exact: false }).first().waitFor()
  await page.getByPlaceholder('Paste your People Data Labs API key').fill('smoke-pdl-key-00000000000000000000')
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await page.getByText('Connected (key ending 0000)').nth(1).waitFor()

  // Both keys connected: the opt-in renders, OFF by default, with the paid-credit wording at the control.
  const toggle = page.getByRole('checkbox')
  await toggle.waitFor()
  assert.equal(await toggle.isChecked(), false, 'the fallback is OFF by default')
  await page.getByText('Off by default.').waitFor()
  await page.getByText('1 of your PDL credits').waitFor()
  let p = path.join(out, 'fallback-off.png'); await page.getByText('Enrichment (bring your own key)').locator('xpath=ancestor::div[contains(@class,"card")]').screenshot({ path: p }); shots.push(p)
  assert.equal(flagRow(), null, 'no flag row exists before the tenant ever opts in')

  // Opt in through the control; the flag must persist in the DB and across a reload.
  await toggle.click()
  await page.getByText('Saved.').waitFor()
  assert.deepEqual(flagRow(), { enabled: 1, ciphertext: '' }, 'opt-in persisted as a secret-less flag row')
  await page.reload()
  await page.getByText('Enrichment (bring your own key)', { exact: true }).waitFor()
  await page.getByRole('checkbox').waitFor()
  assert.equal(await page.getByRole('checkbox').isChecked(), true, 'the opt-in survives a reload')
  p = path.join(out, 'fallback-on.png'); await page.getByText('Enrichment (bring your own key)').locator('xpath=ancestor::div[contains(@class,"card")]').screenshot({ path: p }); shots.push(p)

  // The flag never surfaces as a connector, and GET reports it under its own field.
  const status = await page.evaluate(async () => (await (await fetch('/api/settings/enrichment')).json()))
  assert.deepEqual(status.connectors.map(c => c.connector).sort(), ['enrich:apollo', 'enrich:pdl'], 'no phantom connector')
  assert.equal(status.fallback, true, 'GET reports the opt-in')

  // Opt out again: the flag flips off, keys untouched.
  await page.getByRole('checkbox').click()
  await page.getByText('Saved.').waitFor()
  assert.deepEqual(flagRow(), { enabled: 0, ciphertext: '' }, 'opt-out persisted')
  assert.equal((await page.evaluate(async () => (await (await fetch('/api/settings/enrichment')).json()))).fallback, false)

  console.log('enrichment-fallback smoke OK')
  for (const s of shots) console.log('screenshot:', s)
} finally {
  if (browser) await browser.close()
  srv.stop()
}
