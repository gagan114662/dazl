// #1588 pixel proof: the Settings competitors panel carries each competitor's LinkedIn page. Same isolated pattern as
// test/ui/settings-audit-pixel.ui.mjs: the real component bundled with esbuild, every /api/* call stubbed, headless Chromium.
//   1. the stored list renders: a name row per competitor, its LinkedIn page in its own input, connect state shown;
//   2. "Add another" grows the form; saving PUTs { competitors: [{ name, page_url }, ...] } and nothing else;
//   3. pages saved without dazl Connect paired answer with the connect-the-Reader message, not a silent success.
// NOT part of `npm test`. Run:  cd web && node test/ui/competitors-panel-1588.ui.mjs   (SHOTS=<dir> saves screenshots)
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
let esbuild, chromium
try { esbuild = require('esbuild'); ({ chromium } = require('playwright')) } catch (e) { console.log(`SKIP: ${e.message.split('\n')[0]}`); process.exit(2) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = await esbuild.build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import CompetitorsPanel from '@/app/app/settings/competitors-panel'; createRoot(document.getElementById('root')).render(<CompetitorsPanel />)`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'error',
  alias: { '@': root }, define: { 'process.env.NODE_ENV': '"development"' }, external: [],
})
import fs from 'node:fs'
const tw = require('tailwindcss')
const twc = await tw.compile(fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8'), { base: root, onDependency: () => {}, loadStylesheet: async (id, base) => {
  const p = id === 'tailwindcss' ? require.resolve('tailwindcss/index.css') : require.resolve(id, { paths: [base] })
  return { content: fs.readFileSync(p, 'utf8'), path: p, base: path.dirname(p) }
} })
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : [])
const toks = new Set()
for (const f of walk(path.join(root, 'app'))) { const src = fs.readFileSync(f, 'utf8'); for (const m of src.matchAll(/className="([^"]+)"|className=\{?['`]([^'`]+)['`]/g)) for (const tok of (m[1] || m[2] || '').split(/\s+/)) if (tok && !tok.includes('${')) toks.add(tok) }
const CSS = twc.build([...toks])
const js = bundle.outputFiles[0].text

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const stored = { competitors: ['Acme Rivals', 'Plain Rival'], pages: [{ name: 'Acme Rivals', page_url: 'https://www.linkedin.com/company/acme-rivals/' }], connect: false }
const saved = []
const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {})
const page = await browser.newPage({ viewport: { width: 900, height: 800 } })
await page.route('**/*', async route => {
  const u = new URL(route.request().url())
  if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${CSS}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>` })
  if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
  if (u.pathname === '/api/settings/competitors' && route.request().method() === 'GET') return json(route, stored)
  if (u.pathname === '/api/settings/competitors' && route.request().method() === 'PUT') {
    saved.push(route.request().postDataJSON())
    return json(route, { competitors: saved[0].competitors.map(c => typeof c === 'string' ? c : c.name), pages: saved[0].competitors.filter(c => typeof c !== 'string') })
  }
  if (!u.pathname.startsWith('/api/')) return route.fulfill({ status: 204, body: '' })
  return json(route, {}, 404)
})
await page.goto('http://dazl.test/app/settings')
await page.getByTestId('competitor-name-0').waitFor({ timeout: 15000 })
assert.equal(await page.getByTestId('competitor-name-0').inputValue(), 'Acme Rivals', 'the stored list renders, one name row per competitor')
assert.equal(await page.getByTestId('competitor-page-0').inputValue(), 'https://www.linkedin.com/company/acme-rivals/', 'the competitor\u2019s LinkedIn page renders in its own input')
assert.equal(await page.getByTestId('competitor-page-1').inputValue(), '', 'a competitor without a page has an empty page input')
await page.getByTestId('competitor-add').click()
await page.getByTestId('competitor-name-2').fill('Third Rival')
await page.getByTestId('competitor-page-2').fill('https://www.linkedin.com/in/third-founder/')
await page.getByRole('button', { name: 'Save competitors' }).click()
await page.getByTestId('competitors-msg').waitFor({ timeout: 5000 })
assert.deepEqual(saved, [{ competitors: [
  { name: 'Acme Rivals', page_url: 'https://www.linkedin.com/company/acme-rivals/' },
  'Plain Rival',
  { name: 'Third Rival', page_url: 'https://www.linkedin.com/in/third-founder/' },
] }], 'saving PUTs names and pages, an empty page stays a plain name')
assert.match(await page.getByTestId('competitors-msg').textContent(), /Connect dazl\u2019s LinkedIn Reader/, 'a page saved without dazl Connect says to connect, not a silent success')
if (process.env.SHOTS) { await page.screenshot({ path: `${process.env.SHOTS}/competitors-panel-1588.png`, fullPage: true }) }
await browser.close()
console.log('OK: competitors panel renders name+page rows, saves objects, and asks for dazl Connect when pages are set without it')
