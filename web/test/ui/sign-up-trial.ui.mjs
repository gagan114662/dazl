// #668: the sign-up page's free-trial line must show only when a trial is actually funded on this deployment
// (DAZL_TRIAL_ANTHROPIC_KEY set), never a fixed claim of "3 trial scans" regardless of configuration. NOT part of
// `npm test`. Run:  cd web && npm run build && node test/ui/sign-up-trial.ui.mjs   (SHOTS=<dir> saves the off-state pixel)
// Production build, two server starts (the gate is a deployment-time env fact, not per-request state): one with no
// operator key (today's production shape, per the issue's own finding) and one with it set. No network, no DB, no auth.
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pickUiPort } from '../helpers/ui-port.mjs'
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(dir, 'package.json'))
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? ' (allowed by SMOKE_ALLOW_SKIP=1)' : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
let chromium
try { ({ chromium } = require('playwright')) } catch (e) { notRun(e.message.split('\n')[0]) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')

const TRIAL_LINE = /New accounts may get 3 trial scans first/
const FALLBACK_LINE = /Free plan: 50 scans a month with your own AI key\. Upgrade any time\./

async function withServer(env, fn) {
  const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
  const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'],
    { cwd: dir, env: { PATH: process.env.PATH, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', ...env }, stdio: 'ignore' })
  try {
    for (let i = 0; i < 150; i++) { try { const r = await fetch(`${base}/sign-up`); if (r.status === 200) break } catch { /* starting */ } await new Promise(r => setTimeout(r, 200)) }
    await fn(base)
  } finally { srv.kill() }
}

const b = await chromium.launch()
try {
  // Off: no operator key configured (today's production shape - the issue's own finding).
  await withServer({}, async base => {
    const page = await b.newPage()
    await page.goto(`${base}/sign-up`, { waitUntil: 'networkidle' })
    const text = await page.textContent('main')
    assert.match(text, FALLBACK_LINE, 'the no-trial fallback line shows')
    assert.doesNotMatch(text, TRIAL_LINE, 'no trial-scan promise when the trial is not configured')
    if (process.env.SHOTS) { await page.setViewportSize({ width: 1440, height: 900 }); await page.screenshot({ path: path.join(process.env.SHOTS, 'sign-up-trial-off-desktop.png') }) }
    await page.close()
  })
  // On: an operator key is configured, so the trial really is funded.
  await withServer({ DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-smoke-not-a-real-key-' + 'x'.repeat(20) }, async base => {
    const page = await b.newPage()
    await page.goto(`${base}/sign-up`, { waitUntil: 'networkidle' })
    const text = await page.textContent('main')
    assert.match(text, TRIAL_LINE, 'the trial-scan line shows when a trial is actually configured')
    assert.doesNotMatch(text, FALLBACK_LINE, 'not both lines at once')
    await page.close()
  })
  console.log('sign-up trial-copy check passed: the trial-scan promise shows only when a trial is actually configured, never a fixed claim')
} finally { await b.close() }
