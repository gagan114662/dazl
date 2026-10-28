// Chunk-load fault injection on the production build. NOT part of `npm test`. Run after `npm run build`:
//   npm run test:smoke:chunks
// Answers the Outreach page's JavaScript chunk with 404 (a deploy that removed it) and checks the recovery policy in
// lib/chunk-recovery.ts end to end in Chromium: at most ONE automatic reload, then the "dazl was updated" notice with a
// Reload button, no reload loop, and no write request (POST/PUT/PATCH/DELETE) from any of it. Without the recovery the
// directly loaded page renders but never becomes interactive, and client navigation into it throws ChunkLoadError.
// The same is checked for client navigation into Leads (another /app route) and into /sign-in (outside /app, covered by
// app/error.tsx): the boundary message with Reload shows instead of a blank page.
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
  const chunksWith = text => readdirSync(dir).filter(f => f.endsWith('.js') && readFileSync(path.join(dir, f), 'utf8').includes(text)).map(f => `/_next/static/chunks/${f}`)
  const missing = chunksWith('Create 3-step sequence (templates)')
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
    // The <head> script's notice is appended to <body>; the page's own error boundary (app/app/error.tsx) is in <main>.
    const notice = page.locator('body > [role="alert"]').filter({ hasText: 'dazl was updated' })
    const shown = await notice.isVisible()
    const button = shown && await notice.getByRole('button', { name: 'Reload' }).isVisible()
    const mainText = ((await page.locator('main').innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
    const boundary = await page.locator('main [role="alert"]').filter({ hasText: 'dazl was updated' }).isVisible()
    console.log(`${name}: document loads=${docs}, notice=${shown}, Reload button=${button}, main="${mainText.slice(0, 60)}", boundary=${boundary}, page errors=[${errors.join(', ')}], writes=${writes.length}`)
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name.split(' ')[0]}.png` })
    await ctx.close()
    return { docs, shown, button, writes, mainText, boundary, errors }
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
    assert.ok(r.mainText.length > 0, 'the page content area is never left blank')
  }
  // Client navigation into the missing chunk throws ChunkLoadError while rendering: the /app error boundary shows a
  // Reload message in the content area (the nav stays) instead of a blank page.
  assert.equal(a.boundary, true, 'error boundary message shown in <main>')

  // Other lazy routes: client navigation into a page whose chunk is gone shows the boundary's Reload message, never a
  // blank page, and writes nothing. Leads is inside /app (app/app/error.tsx); sign-in is outside it (app/error.tsx).
  async function navInto(name, { gone, from, signedIn, click }) {
    assert.ok(gone.length > 0, `found the chunk(s) for ${name}`)
    const ctx = signedIn ? await newContext(browser, srv) : await browser.newContext()
    if (!signedIn) await ctx.route('**/*', route => new URL(route.request().url()).origin === srv.base ? route.continue() : route.abort())
    // Gone from the start (a deploy removed it): the link prefetch fails quietly (the head script ignores prefetches),
    // and the click then needs the chunk.
    const broken = true
    await ctx.route('**/_next/static/chunks/**', route => broken && gone.includes(new URL(route.request().url()).pathname) ? route.fulfill({ status: 404, body: '' }) : route.fallback())
    const page = await ctx.newPage(); const writes = []
    page.on('request', r => { if (!['GET', 'HEAD'].includes(r.method())) writes.push(`${r.method()} ${new URL(r.url()).pathname}`) })
    await page.goto(srv.base + from, { waitUntil: 'networkidle' })
    await click(page)
    await page.waitForTimeout(6000)
    // The page's error boundary (in <main>), not only the <head> script's corner notice: the content area is never blank.
    const alert = page.locator('main [role="alert"]').filter({ hasText: 'dazl was updated' }).first()
    const shown = await alert.isVisible()
    const reload = shown && await alert.getByRole('button', { name: 'Reload' }).isVisible()
    const bodyText = ((await page.locator('body').innerText().catch(() => '')) || '').trim()
    console.log(`${name}: update message=${shown}, Reload button=${reload}, writes=${writes.length}`)
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name.split(' ')[0]}.png` })
    await ctx.close()
    assert.equal(shown, true, `${name}: the error boundary's "dazl was updated" message shown in <main>`)
    assert.equal(reload, true, `${name}: Reload button`)
    assert.ok(bodyText.length > 0, `${name}: never a blank page`)
    assert.deepEqual(writes, [], `${name}: nothing written`)
  }
  await navInto('C Leads via client navigation', { gone: chunksWith('Who do you want to reach?'), from: '/app/settings', signedIn: true, click: p => p.locator('aside').getByRole('link', { name: 'Leads', exact: true }).click() })
  await navInto('D sign-in via client navigation (outside /app)', { gone: chunksWith('Enter your email to continue'), from: '/', signedIn: false, click: p => p.getByRole('link', { name: 'Log in' }).first().click() })
  console.log(`\nChunk-load recovery is bounded on the production build (${missing.length} chunk(s) removed).`)
} finally {
  await browser?.close(); srv.stop()
}
