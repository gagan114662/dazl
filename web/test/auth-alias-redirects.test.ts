import { test } from 'node:test'
import assert from 'node:assert/strict'

// #1929: /login, /signin, /signup, /register must answer with a real 308 to the canonical pages.
// The page-level permanentRedirect approach (#1763) serves HTTP 200 under cacheComponents even when
// the route renders dynamically (proof run 45811853159: routes built as `ƒ` dynamic, still 200), so
// the redirects live at the routing layer in next.config.ts, which answers before any rendering.
// Next preserves the query string on these; the browser checks in test/smoke/preview.mjs are the
// end-to-end proof. This asserts the real config object Next consumes.

const config = (await import('../next.config.ts')).default

const EXPECTED: [string, string][] = [
  ['/login', '/sign-in'],
  ['/signin', '/sign-in'],
  ['/signup', '/sign-up'],
  ['/register', '/sign-up'],
]

test('#1929: next.config redirects() carries the four legacy auth aliases as 308s to the canonical pages', async () => {
  if (typeof config.redirects !== 'function') assert.fail('next.config.ts must define redirects() for the legacy auth aliases')
  const list = await config.redirects()
  for (const [source, destination] of EXPECTED) {
    const hit = list.find((r: { source: string }) => r.source === source)
    assert.ok(hit, `redirects() is missing ${source}`)
    assert.equal(hit.destination, destination, `${source} must target ${destination}`)
    assert.equal(hit.permanent, true, `${source} must be permanent (308)`)
  }
})
