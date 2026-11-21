// #686 pixel proof: a draft whose words were written for what its play sold before says so on the draft preview, names
// what the play sells now, and offers Edit but no Approve; an unchanged draft beside it keeps Approve. The real
// OutreachClient bundled with esbuild, every /api/* call stubbed, headless Chromium at 1280 and 390 px. No server, DB,
// network or send. Wording from the 2026-11-13 staging live check on #686.
// Run: node test/ui/draft-offer-changed.ui.mjs   (SHOTS=<dir> to keep screenshots; default: no files written)
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
let esbuild, chromium
try { esbuild = require('esbuild'); ({ chromium } = require('playwright')) } catch (e) { console.log(`SKIP: ${e.message.split('\n')[0]}`); process.exit(2) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
process.chdir(root)
const bundle = await esbuild.build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import OutreachClient from '@/app/app/outreach/outreach-client'; createRoot(document.getElementById('root')).render(<OutreachClient />)`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'error',
  alias: { '@': root },
  plugins: [{ name: 'node-shims', setup(b) { b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: 'crypto-shim', namespace: 'shim' })); b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: 'export const createHash = () => ({ update() { return this }, digest() { return "shim" } }); export const randomBytes = (n) => ({ toString: () => "x".repeat(n * 2) })', loader: 'js' })) } }], define: { 'process.env.NODE_ENV': '"development"', 'process.env.NEXT_PUBLIC_DAZL_STAGING': '""' }, external: [],
})
// Real app styles: compile globals.css with the repo's own Tailwind v4 (candidates scanned from app/), inline <style>.
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
const JOB = 'c'.repeat(24)
const CHOSEN = 'Onboarding and ramp-up coaching for newly hired account executives'
const msg = (id, lead, offer_changed, body) => ({ id, lead_id: lead, to_email: 'sales@buyer.invalid', subject: 'Buyer is hiring an account executive', body, status: 'draft', error: null, created_at: 1, sent_at: null, test: 0, offer_changed, send_footer: 'G\n1 King St W, Toronto ON, Canada', evidence_state: 'human', currentness_held: false, provenance: null })
const stale = msg('a'.repeat(24), 'l'.repeat(24), true, 'Hi Pat,\n\nI saw Buyer is hiring an account executive.\n\nAbout Harbour Dental Supply (demo): Dental chairs, sterilisers and practice equipment')
const fresh = msg('b'.repeat(24), 'm'.repeat(24), false, `Hi Sam,\n\nI saw Other is hiring an account executive.\n\nAbout Harbour Dental Supply (demo): ${CHOSEN}`)
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const SHOTS = process.env.SHOTS
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
const browser = await chromium.launch()
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } })
    await page.route('**/*', async route => {
      const u = new URL(route.request().url())
      if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>` })
      if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
      if (!u.pathname.startsWith('/api/')) return route.fulfill({ status: 204, body: '' })
      if (u.pathname === '/api/leads') return json(route, { job_id: JOB, status: 'done', leads: [{ id: stale.lead_id }, { id: fresh.lead_id }] })
      if (u.pathname === `/api/campaigns/${JOB}`) return json(route, { offer: { offer: CHOSEN, source: 'play', conflict: null } })
      if (u.pathname === '/api/outreach') return json(route, { messages: [stale, fresh] })
      return json(route, {}, 404)
    })
    await page.goto(`http://dazl.test/app/outreach?job_id=${JOB}`)
    const notice = page.getByTestId('offer-changed')
    await notice.waitFor({ timeout: 15000 })
    assert.equal(await notice.count(), 1, `${width}: only the stale draft is marked`)
    assert.equal(await notice.innerText(), `Written for what this play sold before. Edit the words for what it sells now (${CHOSEN}), then approve.`)
    const card = (re) => page.locator('div.card', { hasText: re })
    const staleCard = card(/About Harbour Dental Supply \(demo\): Dental chairs/), freshCard = card(/Hi Sam/)
    assert.equal(await staleCard.getByRole('button', { name: 'Approve', exact: true }).count(), 0, `${width}: no Approve on words for the old offer`)
    assert.equal(await staleCard.getByRole('button', { name: 'Edit', exact: true }).count(), 1, `${width}: Edit is offered`)
    assert.equal(await freshCard.getByRole('button', { name: 'Approve', exact: true }).count(), 1, `${width}: the unchanged draft keeps Approve`)
    const box = await notice.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width, `${width}: the notice fits the screen`)
    if (SHOTS) { await staleCard.screenshot({ path: path.join(SHOTS, `draft-offer-changed-${width}.png`) }); await page.screenshot({ path: path.join(SHOTS, `draft-offer-changed-${width}-page.png`), fullPage: true }) }
    await page.close()
  }
  // the offer changed in the card above the drafts: the list reloads and the draft written for the old offer is marked at once
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } })
    let offer = 'Dental chairs, sterilisers and practice equipment', posted = null
    const before = { ...stale, offer_changed: false }
    await page.route('**/*', async route => {
      const u = new URL(route.request().url())
      if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>` })
      if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
      if (!u.pathname.startsWith('/api/')) return route.fulfill({ status: 204, body: '' })
      if (u.pathname === '/api/leads') return json(route, { job_id: JOB, status: 'done', leads: [{ id: stale.lead_id }] })
      if (u.pathname === `/api/campaigns/${JOB}`) {
        if (route.request().method() === 'POST') { posted = JSON.parse(route.request().postData() ?? '{}').offer; offer = posted }
        return json(route, { offer: { offer, source: 'play', conflict: null } })
      }
      if (u.pathname === '/api/outreach') return json(route, { messages: [posted ? stale : before] })
      return json(route, {}, 404)
    })
    await page.goto(`http://dazl.test/app/outreach?job_id=${JOB}`)
    const card = page.locator('div.card', { hasText: /Hi Pat/ })
    await card.getByRole('button', { name: 'Approve', exact: true }).waitFor({ timeout: 15000 })
    assert.equal(await page.getByTestId('offer-changed').count(), 0, `${width}: unmarked before the change`)
    await page.getByTestId('play-offer-change').click()
    await page.getByTestId('play-offer-input').fill(CHOSEN)
    await page.getByTestId('play-offer-save').click()
    await page.getByTestId('offer-changed').waitFor({ timeout: 15000 })
    assert.equal(posted, CHOSEN)
    assert.equal(await card.getByRole('button', { name: 'Approve', exact: true }).count(), 0, `${width}: Approve is gone once the card changes the offer`)
    if (SHOTS) await card.screenshot({ path: path.join(SHOTS, `draft-offer-changed-in-card-${width}.png`) })
    await page.close()
  }
} finally { await browser.close() }
console.log('OK: a draft written for the play\'s earlier offer is marked, names the current offer and offers Edit, not Approve; the unchanged draft keeps Approve; a change made in the card above marks it at once (1280 and 390 px)')
