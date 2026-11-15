#!/usr/bin/env node
// #1116: after a deploy, did React attach to the sign-up and sign-in forms? check-pages.py (curl) proves the pages and every bundle they name
// load; it cannot tell whether the page HYDRATED (the 12 Nov failure: the form rendered, React never attached, submit did nothing). This
// opens /sign-up, /sign-in and /app (signed out it lands on /sign-in) in a real headless Chromium and FAILS when, on any of them:
//   - there is no form, or the form carries no React props (__reactProps$ / __reactFiber$: React never attached), or no React submit
//     handler (onSubmit): a submit would do nothing;
//   - the page logged a hydration error (React #418 / #423 / #425, "hydration", "did not match") or threw an uncaught exception.
// It never submits a form (no account is created). No npm dependency: Node 22's WebSocket speaks the Chrome DevTools Protocol to the
// Chromium headless shell Playwright already installed on the box (~/.cache/ms-playwright/chromium_headless_shell-*), or a system Chromium.
//
// usage: node check-hydration.mjs <base-url>      exit 0 = every page hydrated; 1 = a check failed (the reason printed); 2 = bad usage or no
//        browser. Settings: HYDRATION_CHECK_BROWSER=<path> (which browser), HYDRATION_CHECK_DEADLINE_S (whole check, default 90).
// PROOF ONLY: HYDRATION_CHECK_BLOCK=<substring> fails every request whose URL contains it (e.g. /_next/static/chunks/), to show the check
// fails when the bundle does not load. Never set in a deploy.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

const PAGES = ['/sign-up', '/sign-in', '/app']
const HYDRATE_WAIT_MS = 15_000
const HYDRATION_ERROR = /Minified React error #(?:418|423|425)\b|hydrat|did not match|server rendered HTML didn't match/i

const base = process.argv[2]
if (!base || process.argv.length > 3 || !/^https?:\/\/[^/\s]+$/.test(base.replace(/\/$/, ''))) {
  console.error('usage: check-hydration.mjs <base-url>   (e.g. https://dazl.ai or http://127.0.0.1:3105)'); process.exit(2)
}
const BASE = base.replace(/\/$/, '')
const DEADLINE = Date.now() + 1000 * (Number(process.env.HYDRATION_CHECK_DEADLINE_S) || 90)

function browserPath() {
  const want = process.env.HYDRATION_CHECK_BROWSER
  if (want) return existsSync(want) ? want : null
  const cache = join(userInfo().homedir, '.cache', 'ms-playwright')   // the account's own home: sudo -u may keep the caller's HOME
  const shells = existsSync(cache) ? readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().reverse() : []
  for (const d of shells) {
    // x64 (dev machines), arm64 (the prod box), and the older layout
    for (const p of [join(cache, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'), join(cache, d, 'chrome-headless-shell-linux-arm64', 'chrome-headless-shell'), join(cache, d, 'chrome-linux', 'headless_shell')]) if (existsSync(p)) return p
  }
  for (const p of ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/snap/bin/chromium']) if (existsSync(p)) return p
  return null
}

function launch(bin, profile) {
  // the flags Playwright launches this headless shell with (without them, navigation can stall before the first response)
  const args = ['--headless', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--disable-field-trial-config',
    '--disable-background-networking', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-back-forward-cache',
    '--disable-breakpad', '--disable-client-side-phishing-detection', '--disable-component-extensions-with-background-pages', '--disable-component-update',
    '--disable-default-apps', '--disable-extensions', '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,OptimizationHints',
    '--allow-pre-commit-input', '--disable-hang-monitor', '--disable-ipc-flooding-protection', '--disable-popup-blocking', '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding', '--force-color-profile=srgb', '--metrics-recording-only', '--password-store=basic', '--use-mock-keychain',
    '--no-service-autorun', '--disable-sync', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', '--no-startup-window']
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  const ws = new Promise((resolve, reject) => {
    let err = ''
    const t = setTimeout(() => reject(new Error('the browser did not start within 20 s')), 20_000)
    proc.stderr.on('data', d => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) { clearTimeout(t); resolve(m[1]) } })
    proc.on('exit', c => { clearTimeout(t); reject(new Error(`the browser exited (${c}) before it was ready: ${err.slice(-200)}`)) })
  })
  return { proc, ws }
}

// a minimal CDP client: one browser socket, flat sessions
function cdp(url) {
  const sock = new WebSocket(url)
  let id = 0
  const waiting = new Map(), listeners = []
  sock.onmessage = ev => {
    const m = JSON.parse(String(ev.data))
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result) }
    else for (const l of listeners) l(m)
  }
  const open = new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error('could not connect to the browser')) })
  return {
    open,
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => { const n = ++id; waiting.set(n, { resolve, reject }); sock.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })) }),
    on: l => listeners.push(l),
    close: () => { try { sock.close() } catch { /* already closed */ } },
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const PROBE = `(() => {
  const f = document.querySelector('form')
  if (!f) return { path: location.pathname, form: false }
  const k = Object.keys(f).find(k => k.startsWith('__reactProps$'))
  return { path: location.pathname, form: true, react: !!k || Object.keys(f).some(k => k.startsWith('__reactFiber$')), onSubmit: !!(k && typeof f[k].onSubmit === 'function') }
})()`

async function checkPage(c, path) {
  const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true })
  const problems = []
  c.on(m => {
    if (m.sessionId !== sessionId) return
    if (m.method === 'Runtime.exceptionThrown') problems.push(`uncaught exception: ${(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').split('\n')[0].slice(0, 160)}`)
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const text = m.params.args.map(a => a.value ?? a.description ?? '').join(' ')
      if (HYDRATION_ERROR.test(text)) problems.push(`hydration error in the console: ${text.split('\n')[0].slice(0, 160)}`)
    }
    if (m.method === 'Fetch.requestPaused') c.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {})
  })
  await c.send('Runtime.enable', {}, sessionId); await c.send('Page.enable', {}, sessionId)
  if (process.env.HYDRATION_CHECK_BLOCK) await c.send('Fetch.enable', { patterns: [{ urlPattern: `*${process.env.HYDRATION_CHECK_BLOCK}*` }] }, sessionId)
  await c.send('Page.navigate', { url: BASE + path }, sessionId)
  let last = null
  const until = Math.min(Date.now() + HYDRATE_WAIT_MS, DEADLINE)
  while (Date.now() < until) {
    await sleep(500)
    try { last = (await c.send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sessionId)).result.value } catch { last = null }
    if (last?.form && last.react && last.onSubmit) break
  }
  await c.send('Target.closeTarget', { targetId }).catch(() => {})
  if (!last) problems.unshift('the page could not be read')
  else if (!last.form) problems.unshift(`no form on the page (landed on ${last.path})`)
  else if (!last.react) problems.unshift(`the form on ${last.path} has no React props: the page did not hydrate, so submitting it does nothing`)
  else if (!last.onSubmit) problems.unshift(`the form on ${last.path} has no React submit handler`)
  return { path, landed: last?.path ?? null, problems }
}

const bin = browserPath()
if (!bin) { console.error('check-hydration: no headless browser found (set HYDRATION_CHECK_BROWSER, or install the Playwright Chromium headless shell)'); process.exit(2) }
const profile = mkdtempSync(join(tmpdir(), 'dazl-hydration-'))
const { proc, ws } = launch(bin, profile)
let failed = false
try {
  const c = cdp(await ws); await c.open
  for (const p of PAGES) {
    if (Date.now() > DEADLINE) { console.log(`FAIL ${p}: the check ran out of time`); failed = true; break }
    const r = await checkPage(c, p)
    if (r.problems.length) { failed = true; console.log(`FAIL ${BASE}${p}${r.landed && r.landed !== p ? ` (landed on ${r.landed})` : ''}: ${r.problems.join('; ')}`) }
    else console.log(`ok   ${BASE}${p}${r.landed && r.landed !== p ? ` (landed on ${r.landed})` : ''}: the form hydrated (React props and submit handler attached), no hydration error`)
  }
  c.close()
} catch (e) { failed = true; console.log(`FAIL the check could not run: ${String(e?.message ?? e).slice(0, 200)}`) }
finally { proc.kill('SIGKILL'); rmSync(profile, { recursive: true, force: true }) }
process.exit(failed ? 1 : 0)
