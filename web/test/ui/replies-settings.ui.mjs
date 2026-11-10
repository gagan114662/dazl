import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pickUiPort } from '../helpers/ui-port.mjs'
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(dir, 'package.json'))
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? ' (allowed by SMOKE_ALLOW_SKIP=1)' : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
let chromium
try { ({ chromium } = require('playwright')) } catch (e) { notRun(e.message.split('\n')[0]) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const Database = require('better-sqlite3'); const { createHash, randomBytes } = require('crypto')
// Lifetime: everything created below (temp dir, server process, browser) is released by ONE idempotent cleanup that runs on success, on any throw (including a
// startup failure before the first assertion), on SIGINT/SIGTERM and on a hard deadline. The hard deadline bounds the whole run; readiness is bounded and fails loudly.
const HARD_DEADLINE_MS = 300_000; const READY_MS = 60_000
let tmp = null, srv = null, b = null, cleanupPromise = null
const sleep = ms => new Promise(r => setTimeout(r, ms))
// resolves true only when the child has actually exited (exit event or already exited); false after ms
const exited = (proc, ms) => (proc.exitCode !== null || proc.signalCode !== null) ? Promise.resolve(true) : new Promise(res => { const h = () => { clearTimeout(t); res(true) }; const t = setTimeout(() => { proc.off('exit', h); res(false) }, ms); proc.once('exit', h) })
// ONE shared promise: every caller (finally, signal, hard deadline, a second signal during cleanup) waits for the same cleanup. Returns the list of unverified items.
const cleanup = () => (cleanupPromise ??= doCleanup())
async function doCleanup() {
  const issues = []
  if (b) {
    try { const closed = await Promise.race([b.close().then(() => true), sleep(5000).then(() => false)]); if (!closed) issues.push('browser close timed out: termination not confirmed') }
    catch (e) { issues.push(`browser close failed (${String(e.message).split('\n')[0].slice(0, 80)}): termination not confirmed`) }
  }
  let serverGone = true
  if (srv) {
    if (!(await exited(srv, 0))) {
      srv.kill('SIGTERM')
      if (!(await exited(srv, 3000))) { try { srv.kill('SIGKILL') } catch {} ; serverGone = await exited(srv, 3000) }   // a sent signal is not proof: wait for the exit event
      if (!serverGone) issues.push('server exit not confirmed after SIGKILL within 3 s')
    }
  }
  // the temp dir is removed only once the server that may be using it is confirmed gone
  if (tmp) { if (serverGone) { try { rmSync(tmp, { recursive: true, force: true }) } catch (e) { issues.push(`temp dir not removed: ${String(e.message).slice(0, 80)}`) } } else issues.push(`temp dir left in place (server may still hold it): ${tmp}`) }
  console.log(issues.length ? `cleanup UNVERIFIED: ${issues.join('; ')}` : 'cleanup verified: browser closed, server exited, temp dir removed')
  if (issues.length) process.exitCode = 1
  return issues
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { void cleanup().finally(() => process.exit(130)) })
setTimeout(() => { console.error(`replies-settings UI check: hard deadline ${HARD_DEADLINE_MS} ms reached`); void cleanup().finally(() => process.exit(1)) }, HARD_DEADLINE_MS).unref()
try {
tmp = mkdtempSync(path.join(tmpdir(), 'dazl-replies-ui-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
{ // bounded readiness: the server must answer /sign-in within READY_MS and must not have exited; otherwise fail (cleanup runs in finally)
  const t0 = Date.now(); let ready = false
  while (Date.now() - t0 < READY_MS) {
    if (srv.exitCode !== null) throw new Error(`next start exited early (code ${srv.exitCode}) before it was ready`)
    try { const r = await fetch(base + '/sign-in', { signal: AbortSignal.timeout(2000) }); if (r.status < 500) { ready = true; break } } catch {}
    await new Promise(r => setTimeout(r, 200))
  }
  if (!ready) throw new Error(`server not ready within ${READY_MS} ms`)
}
// #931 Settings "Replies and follow-ups" panel, rendered on the production build at phone (390x844) and desktop (1280x900).
// The panel is the REAL component on the real /app/settings page; only /api/* is stubbed, by one stateful fake server that behaves like the
// route (revoke/accept/consent/sync change what the next GET returns). No Gmail, no mailbox, no sends, no provider call. Local test with
// simulated API responses, NOT live-site acceptance. The route's own behavior is covered by test/replies-lifecycle.test.ts (actual route).
// NOT part of `npm test`. Run:  cd web && npm run build && SHOTS=<dir> node test/ui/replies-settings.ui.mjs
b = await chromium.launch()
const TEXT = ['Read replies to the threads dazl started, to stop emailing people who unsubscribe.', 'Revoke any time; Gmail stays connected.']
const BOUNCE = ['Scan for delivery-failure notices that match an email dazl sent.']
const base0 = { available: true, gmail_connected: true, gmail_status: 'active', consent: { version: 'v1', text: TEXT, accepted: true }, bounce_scan: { version: 'b1', text: BOUNCE, accepted: false }, read_granted: true, followups_enabled: false, autopilot_on: false, inbound: [] }
async function open(size, [width, height], initial, onPost) {
  const ctx = await b.newContext({ viewport: { width, height } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const server = { info: structuredClone({ ...base0, ...initial }), posts: [], failGet: false }
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url())
    if (u.origin !== base) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    if (u.pathname === '/api/outreach/replies') {
      if (req.method() === 'GET') return server.failGet ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(server.info) })
      const body = JSON.parse(req.postData() || '{}'); server.posts.push(body.action)
      const res = onPost(server, body)
      if (res === 'abort') return route.abort('failed')
      return route.fulfill({ status: res.status ?? 200, contentType: 'application/json', body: res.raw ?? JSON.stringify(res.body ?? {}) })
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  })
  const page = await ctx.newPage()
  await page.goto(base + '/app/settings', { waitUntil: 'networkidle' })
  const panel = page.locator('#replies')
  return { ctx, page, panel, server, shot: async name => {
    await panel.scrollIntoViewIfNeeded()
    const box = await panel.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `${name}: panel fits the ${width}px width`)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, `${name}: no horizontal overflow`)
    if (process.env.SHOTS) await panel.screenshot({ path: path.join(process.env.SHOTS, `${name}-${size}.png`) })
  } }
}
const routeLike = (s, body) => {
  switch (body.action) {
    case 'revoke': s.info.consent.accepted = false; s.info.followups_enabled = false; return { body: { ok: true } }   // as lib/outreach/replies.ts revokeReadConsent: read consent + follow-ups only; the delivery-failure scan consent is separate and untouched
    case 'consent': if (body.version !== s.info.consent.version) return { status: 409, body: { error: 'Terms changed. Reload.' } }; s.info.consent.accepted = true; return { body: { ok: true } }
    case 'bounce_scan_on': s.info.bounce_scan.accepted = true; return { body: { ok: true } }
    case 'sync': return s.info.consent.accepted ? { body: { ok: true, sync: { threads: 2, replies: 1, optOuts: 0, bounces: 0, consents: 0, reviews: 0 } } } : { body: { ok: true, sync: { error: 'reading_not_enabled', threads: 0, replies: 0, optOuts: 0, bounces: 0, consents: 0, reviews: 0 } } }
    default: return { body: { ok: true } }
  }
}
const has = async (page, text) => (await page.locator('#replies').innerText()).includes(text)
{
  for (const [size, vp] of Object.entries({ phone: [390, 844], desktop: [1280, 900] })) {
    // The five reading states, each from its own server state, with the right control and no false "on".
    for (const [name, initial, want, control, notWant] of [
      ['disconnected', { gmail_connected: false, gmail_status: 'none', read_granted: false, consent: { version: 'v1', text: TEXT, accepted: false } }, 'Connect Gmail', 'a', 'Reading replies: on'],
      ['needs-reconnect', { gmail_status: 'needs_reconnect' }, 'Gmail needs to be reconnected', 'a', 'Reading replies: on'],
      ['read-scope-missing', { read_granted: false }, 'connected send-only', 'a', 'Reading replies: on'],
      ['consent-needed', { consent: { version: 'v1', text: TEXT, accepted: false } }, 'Reading replies: off', 'button', 'Reading replies: on'],
      ['on', {}, 'Reading replies: on', 'button', 'Reading replies: off'],
    ]) {
      const t = await open(size, vp, initial, routeLike)
      await t.panel.waitFor(); assert.ok(await has(t.page, want), `${name}: shows "${want}"`); assert.ok(!(await has(t.page, notWant)), `${name}: does not show "${notWant}"`)
      assert.ok(await t.panel.locator(control).first().isVisible(), `${name}: has its control`)
      await t.shot(`state-${name}`); await t.ctx.close()
    }
    // Revoke, reload, re-accept: the journey the issue is about. After revoke the panel must say off (the Gmail read scope is still granted),
    // survive a hard reload as off, and re-accept without a reconnect.
    {
      const t = await open(size, vp, {}, routeLike)
      await t.panel.getByRole('button', { name: 'Stop reading replies' }).click()
      await t.panel.getByText('Reading replies: off').waitFor(); assert.ok(!(await has(t.page, 'Reading replies: on')), 'revoked: never reads as on')
      assert.deepEqual(t.server.posts, ['revoke'], 'one revoke POST'); await t.shot('revoked')
      await t.page.reload({ waitUntil: 'networkidle' }); await t.panel.getByText('Reading replies: off').waitFor(); assert.ok(!(await has(t.page, 'Reading replies: on')), 'still off after a hard reload')
      assert.equal(t.server.info.read_granted, true, 'the Gmail read scope was not touched by the revoke'); await t.shot('revoked-after-reload')
      await t.panel.getByRole('button', { name: 'Turn on reply reading' }).click(); await t.panel.getByText('Reading replies: on').waitFor()
      assert.deepEqual(t.server.posts, ['revoke', 'consent'], 're-accepted with one consent POST, no reconnect'); await t.shot('reaccepted'); await t.ctx.close()
    }
    // The delivery-failure scan consent is separate: revoking reply reading must leave it, and its panel text, exactly as it was (server and screen).
    {
      const t = await open(size, vp, { bounce_scan: { version: 'b1', text: BOUNCE, accepted: true }, followups_enabled: true, autopilot_on: true }, routeLike)
      await t.panel.getByRole('button', { name: 'Stop reading replies' }).click(); await t.panel.getByText('Reading replies: off').waitFor()
      assert.equal(t.server.info.bounce_scan.accepted, true, 'server: bounce-scan consent unchanged by revoke'); assert.equal(t.server.info.followups_enabled, false, 'follow-ups are switched off with reply reading (as the real route does)')
      assert.ok(await has(t.page, 'Delivery-failure scan') && await has(t.page, 'On. dazl scans for delivery-failure notices'), 'screen: the delivery-failure scan still reads On')
      assert.deepEqual(t.server.posts, ['revoke'], 'only the revoke was sent'); await t.shot('revoked-bounce-scan-unchanged'); await t.ctx.close()
    }
    // Check replies: valid result, refused sync, and malformed 2xx bodies must not say "Checked replies."
    for (const [label, res, want, notWant] of [
      ['valid', { body: { ok: true, sync: { threads: 2, replies: 1, optOuts: 0, bounces: 0, consents: 0, reviews: 0 } } }, 'Checked replies.', 'not confirmed'],
      ['valid-zero-threads', { body: { ok: true, sync: { threads: 0, replies: 0, optOuts: 0, bounces: 0, consents: 0, reviews: 0 } } }, 'Checked replies.', 'not confirmed'],
      ['refused', { body: { ok: true, sync: { error: 'reading_not_enabled' } } }, 'Replies were not checked: reply reading is off.', 'Checked replies.'],
      ['empty-object', { body: {} }, 'Replies were not confirmed checked', 'Checked replies.'],
      ['null-body', { raw: 'null' }, 'Replies were not confirmed checked', 'Checked replies.'],
      ['ok-false', { body: { ok: false } }, 'Replies were not confirmed checked', 'Checked replies.'],
      ['sync-null', { body: { ok: true, sync: null } }, 'Replies were not confirmed checked', 'Checked replies.'],
      ['unreadable-json', { raw: '<html>' }, 'Replies were not confirmed checked', 'Checked replies.'],
      ['network-lost', 'abort', 'Replies were not confirmed checked', 'Checked replies.'],
    ]) {
      const t = await open(size, vp, {}, (s, body) => body.action === 'sync' ? res : routeLike(s, body))
      await t.panel.getByRole('button', { name: 'Check replies now' }).click()
      await t.panel.getByText(want, { exact: false }).waitFor(); assert.ok(!(await has(t.page, notWant)), `${label}: never shows "${notWant}"`)
      assert.deepEqual(t.server.posts, ['sync'], `${label}: one sync POST, no automatic retry`); await t.shot(`sync-${label}`); await t.ctx.close()
    }
    // A failed reload after an action replaces the controls with a notice instead of leaving a stale "on".
    {
      const t = await open(size, vp, {}, (s, body) => { s.failGet = true; return routeLike(s, body) })
      await t.panel.getByRole('button', { name: 'Stop reading replies' }).click()
      await t.panel.getByText('Could not confirm the current reply-reading status').waitFor(); assert.ok(!(await has(t.page, 'Reading replies: on')), 'stale status is never shown as on')
      await t.shot('stale-after-failed-reload'); await t.ctx.close()
    }
  }
  console.log('replies-settings UI check passed (#931): all five reading states, revoke -> reload -> re-accept, sync refusal and malformed 2xx never say Checked replies, no overflow, at phone and desktop (simulated API, local)')
}
} finally { const unverified = await cleanup(); if (unverified.length) process.exit(1) }   // an unverified cleanup (e.g. a leaked browser keeping the loop alive) must not linger until the hard deadline
