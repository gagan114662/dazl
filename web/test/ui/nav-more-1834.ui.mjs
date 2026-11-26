// Rendered check, fully stubbed (no server, db, network or key). Run: cd web && NODE_PATH=<dir with esbuild and playwright> node test/ui/nav-more-1834.ui.mjs
// #1834 + Ziggy's changes on PR #1878: the phone menu's 'More' toggle is a button (role + aria-expanded), the user can
// toggle it on the page they are on, and navigating away from a More page collapses it again (the first version kept
// it open forever, because the open state only ever latched on). Real Nav in Chromium; next/navigation is stubbed to
// a path the harness drives, so a "navigation" re-renders the same Nav instance with a new route, as the app layout
// does. NOT RUN (exit 0) without esbuild/playwright; the web-preview browser job greps for NOT RUN, so there it
// must really run.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
let esbuild, chromium
try { esbuild = require('esbuild'); ({ chromium } = require('playwright')) } catch (e) { console.log(`NOT RUN: ${e.message.split('\n')[0]}`); process.exit(0) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const stub = `
  export const usePathname = () => globalThis.__PATH__ ?? '/app'
  export const useSearchParams = () => new URLSearchParams(globalThis.__SEARCH__ ?? '')
  export const useRouter = () => null
  export const useSelectedLayoutSegment = () => null
  export const useSelectedLayoutSegments = () => []
  export const notFound = () => { throw new Error('notFound') }
  export const redirect = () => { throw new Error('redirect') }
`
const bundle = await esbuild.build({
  stdin: { contents: `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import Nav from '@/app/app/nav'
    function Harness() {
      const [path, setPath] = useState('/app/seo')
      globalThis.__PATH__ = path
      return <div>
        <Nav />
        <button data-testid="go-home" onClick={() => setPath('/app')}>home</button>
        <button data-testid="go-seo" onClick={() => setPath('/app/seo')}>seo</button>
      </div>
    }
    createRoot(document.getElementById('root')).render(<Harness />)
  `, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'error', alias: { '@': root },
  // process.env as a whole object: next/link pulls in Next's client runtime, which reads process.env.__NEXT_*
  // values the two single-key defines miss, and a bare `process` reference throws in the browser.
  define: { 'process.env': '{"NODE_ENV":"development","NEXT_PUBLIC_DAZL_STAGING":""}', 'process.env.NODE_ENV': '"development"', 'process.env.NEXT_PUBLIC_DAZL_STAGING': '""' },
  plugins: [{ name: 'next-navigation-stub', setup(b) {
    b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'next-navigation', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub, loader: 'js' }))
  } }],
})
const js = bundle.outputFiles[0].text
const browser = await chromium.launch(); const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', e => pageErrors.push(e.message))
await page.route('**/*', async route => {
  const u = new URL(route.request().url())
  if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>' })
  if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
  return route.fulfill({ status: 204, body: '' })
})
await page.goto('http://dazl.test/app/seo')
const toggle = page.getByRole('button', { name: 'More' })
await toggle.waitFor({ timeout: 10000 })
assert.deepEqual(pageErrors, [], 'the bundle runs without page errors')
const expanded = () => toggle.getAttribute('aria-expanded')
const detailsOpen = () => page.locator('details').first().evaluate(el => el.open)
// The summary's onClick must preventDefault: without it the browser ALSO toggles the details natively, so the
// open attribute and aria-expanded end up opposite once the click settles. Asserting the two agree after a
// settle is what catches that mutant - either value alone can look right mid-flight.
const assertAgreement = async (when) => {
  await page.waitForTimeout(120)
  const ex = await expanded(); const open = await detailsOpen()
  assert.equal(open, ex === 'true', `${when}: details.open (${open}) and aria-expanded (${ex}) agree`)
}
assert.equal(await expanded(), 'true', 'on a More page the toggle starts expanded')
assert.equal(await detailsOpen(), true, 'on a More page the section starts open')
await assertAgreement('on load')
await toggle.click()
assert.equal(await expanded(), 'false', 'clicking the toggle collapses it on the same page')
assert.equal(await detailsOpen(), false)
await assertAgreement('after collapsing')
await toggle.click()
assert.equal(await expanded(), 'true', 'clicking again reopens it')
await assertAgreement('after reopening')
await page.getByTestId('go-home').click()
assert.equal(await expanded(), 'false', 'navigating away from the More page collapses it (the reported bug)')
assert.equal(await detailsOpen(), false, 'the section is closed after navigation')
await page.getByTestId('go-seo').click()
assert.equal(await expanded(), 'true', 'navigating back to a More page opens it again')
await browser.close()
console.log('nav-more-1834: toggle, navigation reset and collapse all render as specified')
