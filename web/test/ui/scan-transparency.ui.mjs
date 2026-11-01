// Rendered check for the scan-status transparency slice: the scan view shows THIS scan's provider
// failures (rejected / rate-limited keys) and the honest cost-per-verification-pass line, including
// the unavailable reason when there is no ratio. NOT part of `npm test` (needs a browser).
// Run:  cd web && NODE_PATH=<dir with esbuild and playwright> node test/ui/scan-transparency.ui.mjs
// Bundles the real LeadsClient page, renders it in headless Chromium, and serves THE REAL STATUS
// ROUTE'S serialized responses (produced by test/helpers/scan-transparency-fixture.mts against a
// seeded store) - the API-to-UI data path is the actual one, not a hand-written stub that can
// drift from the API. No server, no network, no key. Exit 1 on failure; exit 0 with SKIP when
// esbuild/playwright/chromium are not installed.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
let esbuild, chromium
try { esbuild = require('esbuild'); ({ chromium } = require('playwright')) } catch (e) { console.log(`SKIP: ${e.message.split('\n')[0]} (set NODE_PATH to a folder with esbuild and playwright)`); process.exit(0) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// Real route output: seed the fixture store and call the actual GET handler (child process needs
// the route loader that maps next/server and @/ outside Next).
const out = execFileSync(process.execPath, [
  '--experimental-strip-types', '--import', './test/helpers/net-fence.ts',
  '--loader', './test/helpers/tenant-route-loader.mjs',
  './test/helpers/scan-transparency-fixture.mts',
], { cwd: root, encoding: 'utf8', timeout: 60000 })
const fixture = JSON.parse(out)
assert.equal(fixture.a.status, 200, 'fixture route call A succeeded')
assert.equal(fixture.b.status, 200, 'fixture route call B succeeded')

const bundle = await esbuild.build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import LeadsClient from '@/app/app/leads/leads-client'; createRoot(document.getElementById('root')).render(<LeadsClient />)`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'error',
  alias: { '@': root },
  plugins: [{ name: 'node-shims', setup(b) { b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: 'crypto-shim', namespace: 'shim' })); b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: 'export const createHash = () => ({ update() { return this }, digest() { return "shim" } }); export const randomBytes = (n) => ({ toString: () => "shim".repeat(n).slice(0, n) })', loader: 'js' })) } }], define: { 'process.env.NODE_ENV': '"development"' }, external: [],
})
const js = bundle.outputFiles[0].text

const JOB = 'a'.repeat(24)
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const serve = async (statusBody) => {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.route('**/*', async route => {
    const u = new URL(route.request().url())
    if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>` })
    if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
    if (!u.pathname.startsWith('/api/')) return route.fulfill({ status: 204, body: '' })
    if (u.pathname === '/api/scan/status') return json(route, statusBody)
    if (u.pathname === '/api/leads') return json(route, { job_id: JOB, status: 'done', hidden_count: 0, leads: [] })
    if (u.pathname === '/api/scan/jobs') return json(route, { jobs: [] })
    return json(route, {}, 404)
  })
  await page.goto(`http://dazl.test/app/leads?job_id=${JOB}`)
  return { browser, page }
}

// 1) Real tenant-A response: provider failures of THIS scan visible with the fix pointer, no lookup text.
{
  const { browser, page } = await serve(fixture.a.body)
  const issues = page.getByTestId('scan-provider-issues')
  await issues.waitFor({ timeout: 10000 })
  const issueText = await issues.innerText()
  assert.match(issueText, /Apollo could not be used in this scan: the saved key was rejected/)
  assert.match(issueText, /Settings > Enrichment/)
  assert.match(issueText, /Apollo rate limit reached during this scan \(1 lookup affected\)/)
  assert.match(issueText, /People Data Labs rate limit reached during this scan \(1 lookup affected\)/)
  assert.ok(!/Acme|Beta|Gamma|org /.test(issueText), 'no lookup text in the notice')

  // Cost per verification pass: exact ratio from the real route (0.45/4), basis named, model-only scope beside it.
  const perPass = page.getByTestId('scan-cost-per-pass')
  await perPass.waitFor()
  const passText = await perPass.innerText()
  assert.match(passText, /Model cost per lead that passed verification: \$0\.11/)
  assert.match(passText, /across 4 leads/)
  assert.match(passText, /not included/)
  assert.match(passText, /hygiene, not proof of a good lead/)
  await issues.screenshot({ path: (process.env.SHOT_A || '/tmp/scan-transparency-issues-and-perpass.png').replace('.png', '-issues.png') })
  await perPass.screenshot({ path: (process.env.SHOT_A || '/tmp/scan-transparency-issues-and-perpass.png').replace('.png', '-perpass.png') })
  await browser.close()
}

// 2) Real tenant-B response: zero passes -> no ratio, spend still visible, its own issue still shown.
{
  const { browser, page } = await serve(fixture.b.body)
  const perPass = page.getByTestId('scan-cost-per-pass')
  await perPass.waitFor({ timeout: 10000 })
  const t = await perPass.innerText()
  assert.match(t, /No per-lead cost to show: no leads passed verification/)
  assert.match(t, /\$0\.23\) is still shown above/, 'spend is not hidden when the ratio is unavailable')
  assert.match(t, /hygiene, not proof of a good lead/)
  const issues = page.getByTestId('scan-provider-issues')
  await issues.waitFor()
  assert.match(await issues.innerText(), /Apollo could not be used in this scan/)
  await perPass.screenshot({ path: (process.env.SHOT_B || '/tmp/scan-transparency-zero-pass.png').replace('.png', '-perpass.png') })
  await issues.screenshot({ path: (process.env.SHOT_B || '/tmp/scan-transparency-zero-pass.png').replace('.png', '-issues.png') })
  await browser.close()
}

// 3) Same real response with the audit store unreadable (provider_issues null, as the route emits it):
//    renders an explicit not-recorded notice, never an all-clear and never implying provider health.
{
  const { browser, page } = await serve({ ...fixture.a.body, provider_issues: null })
  const unknown = page.getByTestId('scan-provider-issues-unknown')
  await unknown.waitFor({ timeout: 10000 })
  const t = await unknown.innerText()
  assert.match(t, /record of provider calls isn.?t available/)
  assert.match(t, /not an all-clear/)
  assert.equal(await page.getByTestId('scan-provider-issues').count(), 0, 'no fabricated failure list when the record is unreadable')
  await unknown.screenshot({ path: process.env.SHOT_C || '/tmp/scan-transparency-telemetry-unknown.png' })
  await browser.close()
}
console.log('OK: real route bytes render provider failures with fix pointer, cost per verification pass with named basis + model-only scope, and honest unavailable states')
