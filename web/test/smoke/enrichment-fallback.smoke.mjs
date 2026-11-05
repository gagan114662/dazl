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
  env: {
    // The net fence scrubs *KEY* vars before Next starts. Restore ONLY this generated fixture afterwards.
    SMOKE_MASTER_B64: randomBytes(32).toString('base64'),
    NODE_OPTIONS: `--experimental-strip-types --import ${path.join(root, 'test/helpers/net-fence.ts')} --import ${path.join(root, 'test/smoke/stripe-test-env.mjs')}`,
  },
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
  await card.getByRole('button', { name: 'Save Apollo.io key' }).click() // every Save in this card has its own accessible name (#594)
  try {
    await card.getByText(/Connected \(key ending 0000\)/).first().waitFor()
  } catch (e) {
    const p = path.join(out, 'first-save-failed.png'); await page.screenshot({ path: p, fullPage: true }); shots.push(p)
    console.log(`[first-save-failed] card text at timeout: ${(await card.textContent())?.slice(0, 400)}`)
    throw e
  }
  await card.getByPlaceholder('Paste your People Data Labs API key').fill('smoke-pdl-key-00000000000000000000')
  await card.getByRole('button', { name: 'Save People Data Labs key' }).click()
  await card.getByText(/Connected \(key ending 0000\)/).nth(1).waitFor()

  // Both keys connected: the opt-in renders, OFF by default, with the paid-credit wording at the control.
  const toggle = card.locator('label', { hasText: 'Also use People Data Labs as a fallback' }).getByRole('checkbox')
  await toggle.waitFor()
  assert.equal(await toggle.isChecked(), false, 'the fallback is OFF by default')
  await card.getByText('Off by default.').waitFor()
  await card.getByText(/1 PDL credit \(up to 5 per scan - documented terms; the cost on your account is not verified\)/).waitFor()
  let p = path.join(out, 'fallback-off.png'); await card.screenshot({ path: p }); shots.push(p)
  assert.equal(flagRow(), null, 'no flag row exists before the tenant ever opts in')

  // Opt in through the control; the flag must persist in the DB and across a reload.
  const [onResp] = await Promise.all([ // wait for the save itself, not the stale 'Saved.' left by the key save
    page.waitForResponse(r => r.url().includes('/api/settings/enrichment') && r.request().method() === 'POST' && (r.request().postData() || '').includes('fallback')),
    toggle.click()
  ])
  assert.ok(onResp.ok(), 'opt-in save accepted')
  assert.deepEqual(flagRow(), { enabled: 1, ciphertext: '' }, 'opt-in persisted as a secret-less flag row')
  await page.reload()
  await page.getByText('Enrichment (bring your own key)', { exact: true }).waitFor()
  const toggle2 = card.locator('label', { hasText: 'Also use People Data Labs as a fallback' }).getByRole('checkbox')
  await toggle2.waitFor()
  assert.equal(await toggle2.isChecked(), true, 'the opt-in survives a reload')
  p = path.join(out, 'fallback-on.png'); await card.screenshot({ path: p }); shots.push(p)

  // Workspace credit limits through the real UI (#363): set, used-of-N, clear. The controls are per provider+window.
  const monthRow = card.locator('div.flex', { hasText: 'Apollo per month' })
  const monthInput = card.getByRole('textbox', { name: 'apollo month credit limit' }) // role-scoped: the Save button's accessible name contains the input's label, so a bare getByLabel matches both (#594 CI red)
  p = path.join(out, 'credit-limit-unset.png'); await card.screenshot({ path: p }); shots.push(p)
  const [limResp] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/settings/enrichment') && r.request().method() === 'POST' && (r.request().postData() || '').includes('credit_limit')),
    (async () => { await monthInput.fill('5'); await card.getByRole('button', { name: 'Save apollo month credit limit' }).click() })(),
  ])
  assert.ok(limResp.ok(), 'credit limit save accepted')
  await monthRow.getByText('0 credits used of 5').waitFor()
  p = path.join(out, 'credit-limit-set.png'); await card.screenshot({ path: p }); shots.push(p)
  let st = await page.evaluate(async () => (await (await fetch('/api/settings/enrichment')).json()))
  assert.equal(st.credits.find(c => c.provider === 'apollo' && c.window === 'month').limit, 5, 'GET reports the saved limit')
  // Reload with an existing limit: the field shows it, an unchanged Save is disabled (never a silent clear), the limit survives.
  await page.reload(); await page.getByText('Enrichment (bring your own key)', { exact: true }).waitFor()
  await monthRow.getByText('0 credits used of 5').waitFor()
  assert.equal(await monthInput.inputValue(), '5', 'the saved limit hydrates the field after a reload')
  assert.equal(await card.getByRole('button', { name: 'Save apollo month credit limit' }).isDisabled(), true, 'unchanged Save is disabled')
  await monthInput.fill('')
  assert.equal(await card.getByRole('button', { name: 'Save apollo month credit limit' }).isDisabled(), true, 'blank Save is disabled: it never clears')
  p = path.join(out, 'credit-limit-after-reload.png'); await card.screenshot({ path: p }); shots.push(p)
  await page.setViewportSize({ width: 390, height: 900 }); p = path.join(out, 'credit-limit-mobile-390.png'); await card.screenshot({ path: p }); shots.push(p)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal overflow at 390px')
  await page.setViewportSize({ width: 1280, height: 900 })
  await monthInput.fill('5')
  const [clrResp] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/settings/enrichment') && r.request().method() === 'POST' && (r.request().postData() || '').includes('credit_limit')),
    (async () => { await card.getByRole('button', { name: 'Clear apollo month credit limit' }).click() })(),
  ])
  assert.ok(clrResp.ok(), 'credit limit clear accepted')
  await monthRow.getByText('0 credits used, no limit set').waitFor()
  p = path.join(out, 'credit-limit-cleared.png'); await card.screenshot({ path: p }); shots.push(p)
  st = await page.evaluate(async () => (await (await fetch('/api/settings/enrichment')).json()))
  assert.equal(st.credits.find(c => c.provider === 'apollo' && c.window === 'month').limit, null, 'GET reports the cleared limit')

  // The flag never surfaces as a connector, and GET reports it under its own field.
  const status = await page.evaluate(async () => (await (await fetch('/api/settings/enrichment')).json()))
  assert.deepEqual(status.connectors.map(c => c.connector).sort(), ['enrich:apollo', 'enrich:pdl'], 'no phantom connector')
  assert.equal(status.fallback, true, 'GET reports the opt-in')

  // Opt out again: the flag flips off, keys untouched.
  const [offResp] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/settings/enrichment') && r.request().method() === 'POST' && (r.request().postData() || '').includes('fallback')),
    toggle2.click()
  ])
  assert.ok(offResp.ok(), 'opt-out save accepted')
  assert.deepEqual(flagRow(), { enabled: 0, ciphertext: '' }, 'opt-out persisted')
  assert.equal((await page.evaluate(async () => (await (await fetch('/api/settings/enrichment')).json()))).fallback, false)

  // Scan stop statuses (#363): a scan that ended because a paid step's cost could not be recorded, or because it was interrupted while a
  // paid step was in flight, says so on the real page (never "nothing found"), at desktop and 390px, with no horizontal overflow.
  const { createQueryJob } = await import('../../lib/scan/store.ts')
  const seedJob = error => {
    const d = new (require('better-sqlite3'))(dbPath)
    try {
      const id = createQueryJob(d, 'smoke-user', { query: `Smoke stop status ${error}. Find founders of small Ohio payroll and HR software companies that recently hired a controller, opened a second office, or posted three or more finance roles in the last ninety days, and show the evidence for each one` })
      d.prepare("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), id)
      d.prepare("UPDATE scan_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(error, Math.floor(Date.now() / 1000), id)
      return id
    } finally { d.close() }
  }
  for (const [error, shot, text] of [
    ['accounting_failed', 'stop-accounting-failed', /the cost of one paid step could not be recorded/],
    ['accounting_uncertain', 'stop-accounting-uncertain', /may be charged again/],
    ['provider_rate_limited', 'stop-provider-rate-limited', /rate-limited a request in this run[\s\S]*may be charged again/],
    ['provider_rejected', 'stop-provider-rejected', /refused a request in this run[\s\S]*may be charged again/],
  ]) {
    const id = seedJob(error)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`${srv.base}/app/leads?job_id=${id}`)
    await page.getByText(text).first().waitFor()
    for (const [w, tag] of [[1280, 'desktop'], [390, 'mobile-390']]) {
      await page.setViewportSize({ width: w, height: 900 })
      p = path.join(out, `${shot}-${tag}.png`); await page.screenshot({ path: p, fullPage: true }); shots.push(p)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${error}: no horizontal overflow at ${w}px`)
      assert.ok(await page.evaluate(() => { const t = document.getElementById('play'); return !!t && t.scrollHeight <= t.clientHeight + 1 }), `${error}: the long play text is not clipped in its box at ${w}px`)
    }
    assert.equal(await page.getByText(/nothing found/i).count(), 0, `${error} is not reported as an empty search`)
  }
  await page.setViewportSize({ width: 1280, height: 900 })

  console.log('enrichment-fallback smoke OK')
  for (const s of shots) console.log('screenshot:', s)
} finally {
  if (browser) await browser.close()
  srv.stop()
}
