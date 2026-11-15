// One-click Connect LinkedIn (#1037, F-go step 2), end to end in a real browser: the production build of dazl, the UNPACKED dazl Connect
// extension loaded in Chromium, a synthetic LinkedIn session in the browser's own cookie jar (no LinkedIn request is made), and a stub
// session worker on loopback that names the account. Three states, desktop and 390px: extension not installed, connected, disconnected.
// The test copy of the extension adds this run's loopback origin to the pages allowed to message it; extension/ itself is unchanged.
import assert from 'node:assert/strict'
import http from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { loadPlaywright, root, startServer } from '../smoke/harness.mjs'

const { chromium } = loadPlaywright()
const shots = path.resolve(process.env.SHOTS || '/tmp/linkedin-connect-shots'); mkdirSync(shots, { recursive: true })

// The stub worker: /linkedin/me names an invented member; anything else is a failure. It records what it was sent.
const seen = []
const worker = http.createServer((req, res) => {
  let b = ''; req.on('data', d => { b += d }); req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization, body: b })
    if (req.url === '/linkedin/me' && req.headers.authorization === 'Bearer ui-worker-token') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name: 'Dana Okoye', public_id: 'dana-okoye-test', upstream_requests: 1 })) }
    else { res.writeHead(404); res.end('{}') }
  })
})
await new Promise(r => worker.listen(0, '127.0.0.1', r))
const workerUrl = `http://127.0.0.1:${worker.address().port}`

// The network fence (loaded first in the server) deletes every *KEY*/*TOKEN* variable it inherits; the synthetic worker token and master
// key are set by a module loaded right after it, so the server keeps the fence and still has them. Both values are generated here.
const envDir = mkdtempSync(path.join(tmpdir(), 'dazl-connect-env-'))
const envModule = path.join(envDir, 'synthetic-env.mjs')
writeFileSync(envModule, `Object.assign(process.env, ${JSON.stringify({ ADVANCED_WORKER_TOKEN: 'ui-worker-token', DAZL_MASTER_KEY: randomBytes(32).toString('base64') })})\n`)
const srv = await startServer({ env: { ADVANCED_CONNECTORS: '1', ADVANCED_LINKEDIN: '1', ADVANCED_WORKER_URL: workerUrl, NODE_OPTIONS: `--experimental-strip-types --import ${path.join(root, 'test/helpers/net-fence.ts')} --import ${envModule}` } })
const ext = mkdtempSync(path.join(tmpdir(), 'dazl-connect-'))
cpSync(path.join(root, '..', 'extension'), ext, { recursive: true })
const manifest = JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf8'))
manifest.externally_connectable.matches.push(`${srv.base}/*`); manifest.host_permissions.push(`${srv.base}/*`)
writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest))
const profile = mkdtempSync(path.join(tmpdir(), 'dazl-connect-profile-'))
const LI_AT = `AQEDAR${'u'.repeat(60)}`, JSID = '"ajax:5551234567890123456"'

async function shot(page, name) {
  for (const [label, width] of [['desktop', 1280], ['mobile', 390]]) {
    await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(150)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name} ${label}: nothing past the screen edge`)
    await page.locator('[data-testid="linkedin-connect"]').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(shots, `${name}-${label}.png`), fullPage: false })
  }
}
// a full load (a goto that only changes the #fragment would keep the panel's earlier state)
const settings = async page => { await page.goto(`${srv.base}/app/settings`); await page.reload(); await page.locator('[data-testid="linkedin-connect"]').waitFor({ timeout: 30000 }) }
const call = (page, url, body, method = 'POST') => page.evaluate(async ({ url, body, method }) => { const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) } }, { url, body, method })

let plain, ctx
try {
  // 1. No extension: the page says how to get it.
  plain = await chromium.launch()
  const pctx = await plain.newContext(); await pctx.addCookies([{ name: 'dazl_session', value: srv.token, url: srv.base }])
  const p1 = await pctx.newPage(); await p1.goto(srv.base + '/app/settings')
  globalThis.__p1 = p1
  const consentVersion = (await call(p1, '/api/settings/advanced', null, 'GET')).body.version
  assert.equal((await call(p1, '/api/settings/advanced', { action: 'consent', platform: 'linkedin', accept: true, version: consentVersion })).status, 200)
  await settings(p1)
  await p1.getByRole('button', { name: 'Connect LinkedIn' }).click()
  await p1.locator('[data-testid="install-extension"]').waitFor()
  await shot(p1, '1-extension-not-installed')
  await plain.close(); plain = null

  // 2. The extension loaded; the user is signed in to LinkedIn in this browser (synthetic cookies in its jar).
  ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] })
  await ctx.addCookies([{ name: 'dazl_session', value: srv.token, url: srv.base },
    { name: 'li_at', value: LI_AT, domain: '.www.linkedin.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' },
    { name: 'JSESSIONID', value: JSID, domain: '.www.linkedin.com', path: '/', secure: true, sameSite: 'None' }])
  if (!ctx.serviceWorkers().length) await ctx.waitForEvent('serviceworker', { timeout: 15000 })
  const extId = new URL(ctx.serviceWorkers()[0].url()).host
  assert.equal(extId, 'epkdepdanldkocmedakfdgnoofgjknfk', 'the unpacked build has the ID the Settings page talks to')
  const page = ctx.pages()[0] ?? await ctx.newPage()
  await settings(page)
  await page.getByRole('button', { name: 'Connect LinkedIn' }).click()
  await page.getByText('Connected as').waitFor({ timeout: 30000 })
  await page.getByText('Dana Okoye').waitFor()
  await shot(page, '2-connected')
  // the session dazl stored is exactly the browser's own, encrypted; the worker saw one account read with it and nothing else
  const db = new Database(srv.dbPath, { readonly: true })
  const row = db.prepare("SELECT ciphertext, last4 FROM tenant_connectors WHERE connector = 'adv:linkedin'").get()
  db.close()
  assert.ok(row && row.ciphertext && !row.ciphertext.includes(LI_AT), 'stored, and only encrypted')
  assert.equal(seen.length, 1); assert.equal(seen[0].url, '/linkedin/me'); assert.deepEqual(JSON.parse(seen[0].body), { session: `li_at=${LI_AT}; JSESSIONID="ajax:5551234567890123456"` })

  // LinkedIn rotates JSESSIONID: the extension re-sends by itself (no click), without another account read.
  await ctx.addCookies([{ name: 'JSESSIONID', value: '"ajax:5559999999999999999"', domain: '.www.linkedin.com', path: '/', secure: true, sameSite: 'None' }])
  const saves = () => { const d = new Database(srv.dbPath, { readonly: true }); const n = d.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'credential.saved' AND resource_id = 'linkedin'").get().n; d.close(); return n }
  let rotated = false
  for (let i = 0; i < 60 && !rotated; i++) { await page.waitForTimeout(250); rotated = saves() >= 2 }
  assert.equal(seen.length, 1, 'a rotation re-saves without another account read')
  assert.ok(rotated, 'the rotated cookie was saved again without a click')

  // "Test connection" names the account again (one more read).
  await page.getByRole('button', { name: 'Test connection' }).click()
  await page.getByText('Working: signed in as Dana Okoye').waitFor()
  assert.equal(seen.length, 2)

  // 3. Disconnect: the session is gone, the extension's token is dead, the page offers Connect again.
  await page.getByRole('button', { name: 'Disconnect' }).click()
  await page.getByRole('button', { name: 'Connect LinkedIn' }).waitFor()
  await shot(page, '3-disconnected')
  const d3 = new Database(srv.dbPath, { readonly: true })
  assert.equal(d3.prepare("SELECT COUNT(*) n FROM tenant_connectors WHERE connector LIKE 'adv:linkedin%'").get().n, 0)
  d3.close()
  console.log(`ok linkedin-connect UI: not installed / connected as Dana Okoye / rotation re-sync / test / disconnected; screenshots in ${shots}`)
} catch (e) {
  console.error(e, srv.log().split('\n').filter(l => !l.includes('"type":"request"')).join('\n').slice(-3000)); process.exitCode = 1
  for (const pg of [globalThis.__p1, ctx?.pages()[0]]) if (pg) await pg.screenshot({ path: path.join(shots, `failure-${pg === globalThis.__p1 ? 'plain' : 'ext'}.png`), fullPage: true }).catch(() => {})
}
finally {
  if (plain) await plain.close(); if (ctx) await ctx.close()
  srv.stop(); worker.close(); for (const d of [ext, profile, envDir]) rmSync(d, { recursive: true, force: true })
}
