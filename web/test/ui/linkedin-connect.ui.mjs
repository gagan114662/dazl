// One-click Connect LinkedIn (#1037, #1122), end to end in a real browser: the production build of dazl and the UNPACKED dazl Connect
// extension loaded in Chromium. The extension pairs and then asks dazl for LinkedIn pages to read; dazl stores no LinkedIn session and
// makes no outbound request (the stub worker must see nothing). Three states, desktop and 390px: not installed, connected, disconnected.
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

  // 2. The extension loaded (it has no cookie permission). Connect pairs it; the device token then reads tasks.
  ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] })
  await ctx.addCookies([{ name: 'dazl_session', value: srv.token, url: srv.base }])
  if (!ctx.serviceWorkers().length) await ctx.waitForEvent('serviceworker', { timeout: 15000 })
  const sw = ctx.serviceWorkers()[0]
  const extId = new URL(sw.url()).host
  assert.equal(extId, 'epkdepdanldkocmedakfdgnoofgjknfk', 'the unpacked build has the ID the Settings page talks to')
  const page = ctx.pages()[0] ?? await ctx.newPage()
  await settings(page)
  await page.getByRole('button', { name: 'Connect LinkedIn' }).click()
  await page.getByText('Connected. dazl Connect reads LinkedIn in this browser').waitFor({ timeout: 30000 })
  await settings(page); await page.locator('[data-testid="linkedin-reading"]').waitFor({ timeout: 30000 })
  await shot(page, '2-connected')
  const db = new Database(srv.dbPath, { readonly: true })
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tenant_connectors WHERE connector = 'adv:linkedin'").get().n, 0, 'no LinkedIn session stored')
  assert.ok(db.prepare("SELECT tz FROM li_task_gate").get()?.tz, 'the time zone came from the Settings browser')
  db.close()
  // the extension's stored device token reads the task queue
  const st = await sw.evaluate(async () => (await chrome.storage.local.get('dazl')).dazl)
  assert.ok(st && st.token && st.origin === srv.base)
  const r = await sw.evaluate(async s => { const x = await fetch(`${s.origin}/api/tasks/next`, { headers: { authorization: `Bearer ${s.token}` }, credentials: 'omit' }); return { status: x.status, body: await x.json() } }, st)
  assert.equal(r.status, 200, JSON.stringify(r)); assert.ok('wait' in r.body || 'task' in r.body)
  assert.equal(seen.length, 0, 'no worker or LinkedIn request from the server')

  // 3. Disconnect: the session is gone, the extension's token is dead, the page offers Connect again.
  await page.getByRole('button', { name: 'Disconnect' }).click()
  await page.getByRole('button', { name: 'Connect LinkedIn' }).waitFor()
  await shot(page, '3-disconnected')
  const d3 = new Database(srv.dbPath, { readonly: true })
  assert.equal(d3.prepare("SELECT COUNT(*) n FROM tenant_connectors WHERE connector LIKE 'adv:linkedin%'").get().n, 0)
  assert.equal(seen.length, 0)
  d3.close()
  console.log(`ok linkedin-connect UI: not installed / connected, task queue reachable, no session stored / disconnected; screenshots in ${shots}`)
} catch (e) {
  console.error(e, srv.log().split('\n').filter(l => !l.includes('"type":"request"')).join('\n').slice(-3000)); process.exitCode = 1
  for (const pg of [globalThis.__p1, ctx?.pages()[0]]) if (pg) await pg.screenshot({ path: path.join(shots, `failure-${pg === globalThis.__p1 ? 'plain' : 'ext'}.png`), fullPage: true }).catch(() => {})
}
finally {
  if (plain) await plain.close(); if (ctx) await ctx.close()
  srv.stop(); worker.close(); for (const d of [ext, profile, envDir]) rmSync(d, { recursive: true, force: true })
}
