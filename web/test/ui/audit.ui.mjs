// Settings > Audit trail on the production build, against the REAL API (nothing stubbed; #371): the owner changes
// sender settings, imports and deletes LinkedIn connections, and sees each change in the trail, newest first; the
// Deletions filter narrows it; Download CSV is offered; a viewer of the same workspace gets no Audit trail card, and
// that refused read is in the owner's trail. NOT part of `npm test`. Run:  cd web && npm run build && node test/ui/audit.ui.mjs
// (SHOTS=<dir> saves desktop and 390px screenshots). Throwaway database, server under test/helpers/net-fence.ts (no
// outbound call), synthetic data only.
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { loadPlaywright, newContext, startServer } from '../smoke/harness.mjs'
const require = createRequire(import.meta.url)
const { chromium } = loadPlaywright()

const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
let dbPath = ''
const srv = await startServer({ prepare: p => { dbPath = p } })
const { base } = srv
let browser
const card = page => page.locator('#audit')
const fits = async page => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `horizontal scroll on ${page.url()}`)
async function shot(page, name) {
  for (const [label, size] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(size)
    await page.waitForTimeout(150)
    await fits(page)
    if (SHOTS) await card(page).screenshot({ path: path.join(SHOTS, `${name}-${label}.png`) })
  }
  await page.setViewportSize({ width: 1280, height: 900 })
}
try {
  browser = await chromium.launch()
  const ownerCtx = await newContext(browser, srv)
  const owner = await ownerCtx.newPage()
  await owner.goto(`${base}/app/settings`, { waitUntil: 'networkidle' })
  // three audited changes through the real API, from the owner's browser session
  const statuses = await owner.evaluate(async () => {
    const call = (u, method, body) => fetch(u, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(r => r.status)
    return [
      await call('/api/outreach/settings', 'PUT', { sender_name: 'Synthetic Sender', postal_address: '1 Synthetic Way, Testville, TS 00000', booking_url: '' }),
      await call('/api/warm/connections', 'POST', { csv: 'First Name,Last Name,URL,Connected On\nAda,Lovelace,https://linkedin.com/in/adalovelace,15 Mar 2024\n' }),
      await call('/api/warm/connections', 'DELETE'),
    ]
  })
  assert.deepEqual(statuses, [200, 200, 200])

  // a viewer of the owner's workspace: no Audit trail card; the refused read lands in the owner's trail
  const Database = require('better-sqlite3')
  const db = new Database(dbPath)
  const viewerToken = randomBytes(32).toString('hex')
  db.prepare("INSERT INTO users (id, email, password_hash, salt) VALUES ('viewer-user', 'viewer@example.test', 'x', 'y')").run()
  db.prepare("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES ('smoke-user', 'viewer-user', 'viewer', 1)").run()
  db.prepare("INSERT INTO sessions (id, user_id, expires_at, active_tenant_id) VALUES (?, 'viewer-user', ?, 'smoke-user')").run(createHash('sha256').update(viewerToken).digest('hex'), Math.floor(Date.now() / 1000) + 3600)
  db.close()
  const viewerCtx = await newContext(browser, { base, token: viewerToken })
  const viewer = await viewerCtx.newPage()
  await viewer.goto(`${base}/app/settings`, { waitUntil: 'networkidle' })
  await viewer.locator('h1', { hasText: 'Settings' }).waitFor()
  assert.equal(await card(viewer).count(), 0, 'a viewer gets no Audit trail card')

  await owner.reload({ waitUntil: 'networkidle' })
  await card(owner).locator('h2', { hasText: 'Audit trail' }).waitFor()
  const rows = async () => (await card(owner).locator('li > span:first-child').allTextContents()).map(s => s.trim())
  assert.deepEqual(await rows(), ['Tried to read the audit trail (refused)', 'Deleted data', 'Changed settings'])
  assert.ok(!(await card(owner).textContent()).includes('Synthetic Way'), 'the sender address is not shown or recorded')
  await shot(owner, 'audit-owner')

  await card(owner).locator('select').selectOption('data.')
  await owner.waitForTimeout(400)
  assert.deepEqual(await rows(), ['Deleted data'])
  const href = await card(owner).getByText('Download CSV').getAttribute('href')
  assert.equal(href, '/api/workspace/audit?format=csv&limit=1000&action=data.')
  const csv = await owner.evaluate(async h => (await fetch(h)).text(), href)
  assert.match(csv.split('\n')[0], /^at,actor_id,actor_kind,action,resource_type,resource_id,decision,summary,correlation_id$/)
  assert.equal(csv.trim().split('\n').length, 2)
  await shot(owner, 'audit-owner-deletions')
  console.log(`ok   Settings > Audit trail on the production build: owner sees each change, filter, CSV; viewer gets no card${SHOTS ? `; screenshots in ${SHOTS}` : ''}`)
} catch (e) {
  console.log(`FAIL ${e.message}\n${srv.log().slice(-2000)}`)
  process.exitCode = 1
} finally {
  await browser?.close()
  srv.stop()
}
