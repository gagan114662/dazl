// Rendered check, fully stubbed (no server, db, network or Gmail). Run: cd web && node test/ui/auto-sequence.ui.mjs
// #414: Settings > Autopilot shows the automatic follow-up policy (day 3 and day 7 after an unanswered first email) with
// its own acknowledgement; turning it on sends the policy version it showed; off always shows a way to turn it off; a
// refusal (reply reading off) is shown, not swallowed. SHOTS=<dir> also saves desktop and mobile screenshots. SKIP
// (exit 0) without esbuild/playwright.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
let esbuild, chromium
try { esbuild = require('esbuild'); ({ chromium } = require('playwright')) } catch (e) { console.log(`SKIP: ${e.message.split('\n')[0]}`); process.exit(0) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = await esbuild.build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import AutopilotPanel from '@/app/app/settings/autopilot-panel'; createRoot(document.getElementById('root')).render(<main style={{maxWidth: 720, margin: '24px auto', padding: '0 16px'}}><AutopilotPanel /></main>)`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'error', alias: { '@': root }, define: { 'process.env.NODE_ENV': '"development"' },
})
const js = bundle.outputFiles[0].text
// The app's built stylesheet when there is a build (screenshots look like the app); the assertions do not need it.
const css = (() => { try { const d = path.join(root, '.next/static/chunks'); return fs.readdirSync(d).filter(f => f.endsWith('.css')).map(f => fs.readFileSync(path.join(d, f), 'utf8')).join('\n') } catch { return '' } })()
const TEXT = ['After autopilot sends a first email, dazl follows up at most twice in the same thread if nobody replies: 3 days and 7 days after the first email.', 'Synthetic policy line two.']
const info = on => ({ available: true, state: { enabled: true, paused: false, pause_reason: null, consent_current: true, daily_cap: 10 }, consent: { version: 'c', text: [] }, warmup: 2, max_daily: 50, auto_sequence: { version: '2026-10-30', text: TEXT, on }, audit: [] })
const browser = await chromium.launch()

async function open(viewport, onPost) {
  const posts = []; let on = false
  const page = await browser.newPage({ viewport })
  await page.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url())
    if (req.resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${css}</style></head><body style="background:#fafafa"><div id="root"></div><script src="/bundle.js"></script></body></html>` })
    if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
    if (u.pathname === '/api/outreach/autopilot' && req.method() === 'POST') {
      const b = JSON.parse(req.postData()); posts.push(b)
      const r = onPost(b); if (r.ok) on = b.action === 'auto_sequence_on'
      return route.fulfill({ status: r.ok ? 200 : 400, contentType: 'application/json', body: JSON.stringify(r.ok ? { ok: true } : { error: r.error }) })
    }
    if (u.pathname === '/api/outreach/autopilot') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(info(on)) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto('http://dazl.test/app/settings')
  await page.getByTestId('auto-sequence').waitFor()
  return { page, posts }
}

for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 1000 }]]) {
  const { page, posts } = await open(viewport, () => ({ ok: true }))
  const box = page.getByTestId('auto-sequence')
  assert.match(await box.innerText(), /3 days and 7 days after the first email/)
  const turnOn = page.getByRole('button', { name: 'Turn on automatic follow-ups' })
  assert.equal(await turnOn.isDisabled(), true, 'needs its own acknowledgement')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${name}: no horizontal scroll`)
  if (process.env.SHOTS) await box.screenshot({ path: path.join(process.env.SHOTS, `414-off-${name}.png`) })
  await page.getByLabel('I have read this and want these follow-ups sent for me.').check()
  await turnOn.click()
  await page.getByRole('button', { name: 'Turn off automatic follow-ups' }).waitFor()
  assert.deepEqual(posts, [{ action: 'auto_sequence_on', accept: true, version: '2026-10-30' }], 'sends the policy version it showed')
  assert.match(await box.innerText(), /day 3 and day 7, then stops\. Any reply, opt-out or bounce stops it sooner/)
  if (process.env.SHOTS) await box.screenshot({ path: path.join(process.env.SHOTS, `414-on-${name}.png`) })
  await page.getByRole('button', { name: 'Turn off automatic follow-ups' }).click()
  await turnOn.waitFor()
  assert.deepEqual(posts.at(-1), { action: 'auto_sequence_off' })
  await page.close()
}
// A refusal is shown and the policy stays off.
{
  const { page } = await open({ width: 1280, height: 900 }, () => ({ ok: false, error: 'Turn on reply reading first, so follow-ups stop when someone replies.' }))
  await page.getByLabel('I have read this and want these follow-ups sent for me.').check()
  await page.getByRole('button', { name: 'Turn on automatic follow-ups' }).click()
  await page.getByText('Turn on reply reading first, so follow-ups stop when someone replies.').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Turn off automatic follow-ups' }).count(), 0)
  await page.close()
}
await browser.close()
console.log('auto-sequence.ui: ok')
