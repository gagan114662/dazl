import assert from 'node:assert/strict'
import test from 'node:test'
import 'next/dist/server/node-environment-baseline.js'
import { unstable_getResponseFromNextConfig } from 'next/experimental/testing/server.js'
import nextConfig from '../next.config.ts'

const origin = 'https://dazl.ai'
const aliases = [
  ['/faq', '/contact'],
  ['/blog', '/'],
  ['/privacy.html', '/privacy'],
] as const

for (const [source, destination] of aliases) {
  test(`legacy route ${source} returns one permanent redirect and keeps the query`, async () => {
    const response = await unstable_getResponseFromNextConfig({
      url: origin + source + '?ref=legacy',
      nextConfig,
    })
    assert.equal(response.status, 308)
    const target = new URL(destination, origin)
    target.searchParams.set('ref', 'legacy')
    assert.equal(response.headers.get('location'), target.href)
    const canonical = await unstable_getResponseFromNextConfig({ url: target.href, nextConfig })
    assert.equal(canonical.headers.get('location'), null)
  })
}
