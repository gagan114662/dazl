// PR preview: every page of a production build, screenshotted signed in, so a change can be seen before it reaches
// production. Run by .github/workflows/web-preview.yml on each pull request (the screenshots are uploaded as the run's
// "preview" artifact), or locally after `npm run build`:  npm run preview:shots [-- <out dir>]
// Isolation as harness.mjs: throwaway database with one seeded user, server under the test network fence, off-host
// browser requests aborted. Nothing is scanned, sent or billed, and no production secret or configuration is read.
// Pages show the empty state of a new account: there is no tenant data beyond the seeded user.
// Exit 1 if any page fails to load (HTTP >= 400, page error, or a redirect other than the known renamed page).
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadPlaywright, newContext, root, startServer } from './harness.mjs'
const { chromium } = loadPlaywright()

const out = path.resolve(process.argv[2] ?? path.join(root, 'preview'))
// Every page under app/ outside /api, so a new page is covered without editing this file. Dynamic segments are skipped.
function pages(dir, route) {
  const found = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) { if (name !== 'api' && !name.startsWith('[') && !name.startsWith('_')) found.push(...pages(full, `${route === '/' ? '' : route}/${name}`)) }
    else if (name === 'page.tsx') found.push(route)
  }
  return found
}
const routes = pages(path.join(root, 'app'), '/').sort()
const REDIRECTS = { '/app/replies': '/app/social' } // renamed pages, as in app-pages.smoke.mjs
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } }
const file = (route, vp) => `${route === '/' ? 'home' : route.slice(1).replaceAll('/', '_')}.${vp}.png`

mkdirSync(out, { recursive: true })
const srv = await startServer()
const shots = []; const failures = []
let browser
try {
  browser = await chromium.launch()
  for (const [vp, viewport] of Object.entries(VIEWPORTS)) {
    const ctx = await newContext(browser, srv)
    for (const route of routes) {
      const page = await ctx.newPage(); await page.setViewportSize(viewport); const errs = []
      page.on('pageerror', e => errs.push(`page error: ${e.name}: ${e.message.split('\n')[0]}`))
      const res = await page.goto(srv.base + route, { waitUntil: 'networkidle' })
      await page.waitForTimeout(300)
      if (!res || res.status() >= 400) errs.push(`HTTP ${res?.status()}`)
      const landed = new URL(page.url()).pathname
      if (landed !== (REDIRECTS[route] ?? route)) errs.push(`landed on ${landed}`)
      await page.screenshot({ path: path.join(out, file(route, vp)), fullPage: true })
      shots.push({ route, vp, file: file(route, vp), errs })
      console.log(`${errs.length ? 'FAIL' : 'ok  '} ${vp} ${route}`)
      for (const e of errs) { console.log(`     ${e}`); failures.push(`${vp} ${route}: ${e}`) }
      await page.close()
    }
    await ctx.close()
  }
} finally {
  await browser?.close()
  srv.stop()
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const commit = process.env.PREVIEW_COMMIT ?? ''
writeFileSync(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>dazl preview ${esc(commit.slice(0, 7))}</title>
<style>body{font:14px system-ui;margin:24px}section{margin:0 0 40px}img{border:1px solid #ccc;max-width:100%;vertical-align:top;margin-right:16px}.d{width:62%}.m{width:22%}.f{color:#b00}</style>
<h1>dazl preview ${esc(commit)}</h1><p>Production build, throwaway database, one signed-in test account (empty state). ${routes.length} pages.</p>
${routes.map(r => { const s = shots.filter(x => x.route === r); return `<section><h2>${esc(r)}</h2>${s.flatMap(x => x.errs).map(e => `<p class="f">${esc(e)}</p>`).join('')}${s.map(x => `<img class="${x.vp[0]}" alt="${esc(`${r} ${x.vp}`)}" src="${esc(x.file)}">`).join('')}</section>` }).join('\n')}
`)
console.log(`\n${shots.length} screenshots of ${routes.length} pages in ${out}`)
if (failures.length) { console.log(`${failures.length} problem(s)`); process.exit(1) }
