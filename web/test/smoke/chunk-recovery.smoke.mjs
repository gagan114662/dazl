// Chunk-load fault injection on the production build. NOT part of `npm test`. Run after `npm run build`:
//   npm run test:smoke:chunks
// Answers the Outreach page's JavaScript chunk with 404 (a deploy that removed it) and checks the recovery policy in
// lib/chunk-recovery.ts end to end in Chromium: at most ONE automatic reload, then the "dazl was updated" notice with a
// Reload button, no reload loop, and no write request (POST/PUT/PATCH/DELETE) from any of it. Without the recovery the
// directly loaded page renders but never becomes interactive, and client navigation into it throws ChunkLoadError.
// Isolation and NOT RUN handling: see harness.mjs.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { loadPlaywright, newContext, root, startServer } from './harness.mjs'
const { chromium } = loadPlaywright()

const srv = await startServer()
let browser
try {
  browser = await chromium.launch()
  // Link prefetching loads other routes' chunks too, so pick the Outreach chunk(s) by content instead of by request.
  const dir = path.join(root, '.next/static/chunks')
  const missing = readdirSync(dir).filter(f => f.endsWith('.js') && readFileSync(path.join(dir, f), 'utf8').includes('Create 3-step sequence (templates)')).map(f => `/_next/static/chunks/${f}`)
  assert.ok(missing.length > 0, 'found chunks only /app/outreach needs')

  async function scenario(name, { from, breakFirst }) {
    const ctx = await newContext(browser, srv)
    let broken = !!breakFirst
    await ctx.route('**/_next/static/chunks/**', route => broken && missing.includes(new URL(route.request().url()).pathname) ? route.fulfill({ status: 404, body: '' }) : route.fallback())
    const page = await ctx.newPage(); let docs = 0; const writes = []; const errors = []
    page.on('request', r => { if (r.resourceType() === 'document') docs++; if (!['GET', 'HEAD'].includes(r.method())) writes.push(`${r.method()} ${new URL(r.url()).pathname}`) })
    page.on('pageerror', e => errors.push(e.name))
    await page.goto(srv.base + from, { waitUntil: 'networkidle' }).catch(() => {})
    broken = true
    if (from === '/app/outreach') await page.reload().catch(() => {}) // the next visit of an already-open page after a deploy
    else await page.locator('aside').getByRole('link', { name: 'Outreach', exact: true }).click()
    await page.waitForTimeout(8000) // a looping page would keep loading documents here
    const notice = page.getByRole('alert').filter({ hasText: 'dazl was updated' })
    const shown = await notice.isVisible()
    const button = shown && await notice.getByRole('button', { name: 'Reload' }).isVisible()
    console.log(`${name}: document loads=${docs}, notice=${shown}, Reload button=${button}, page errors=[${errors.join(', ')}], writes=${writes.length}`)
    await ctx.close()
    return { docs, shown, button, writes }
  }

  // A: chunk gone before the tab opened (old HTML/new server): the first page itself fails, then the user navigates.
  const a = await scenario('A missing from the start, then client navigation', { from: '/app/settings', breakFirst: true })
  // B: chunk removed while the page was open, then the page is visited again.
  const b = await scenario('B direct visit', { from: '/app/outreach' })
  for (const [r, max] of [[a, 2], [b, 3]]) {
    assert.ok(r.docs <= max, `bounded document loads: ${r.docs} > ${max}`)
    assert.equal(r.shown, true, 'the notice is shown after the one automatic reload')
    assert.equal(r.button, true)
    assert.deepEqual(r.writes, [], 'recovery never sends a write')
  }
  console.log(`\nChunk-load recovery is bounded on the production build (${missing.length} chunk(s) removed).`)
} finally {
  await browser?.close(); srv.stop()
}
