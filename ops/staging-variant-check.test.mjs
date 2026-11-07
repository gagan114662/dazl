import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkStagingVariant } from './staging-variant-check.mjs'

const SHA = 'a'.repeat(40)
const mk = ({ robots, headers = {}, home, live = { commit: SHA } }) => async url => {
  const p = new URL(url).pathname
  const body = p === '/robots.txt' ? robots : p === '/api/health/live' ? JSON.stringify(live) : home
  return new Response(body, { headers })
}
const stagingHome = '<div data-testid="staging-banner">Staging - test data</div><link rel="canonical" href="https://staging.dazl.ai"/><meta property="og:url" content="https://staging.dazl.ai"/>'
const staging = { robots: 'User-Agent: *\nDisallow: /\n', headers: { 'x-robots-tag': 'noindex, nofollow' }, home: stagingHome }
const prodVariant = { robots: 'User-Agent: *\nAllow: /\nSitemap: https://dazl.ai/sitemap.xml\n', home: '<link rel="canonical" href="https://dazl.ai"/>' }
const run = o => checkStagingVariant('http://x', 'https://staging.dazl.ai', SHA, mk(o))

test('the staging variant passes', async () => assert.deepEqual(await run(staging), []))
test('the production variant fails on every staging marker (the c722 artifact shape)', async () => {
  const f = (await run(prodVariant)).join('|')
  for (const m of ['does not disallow', 'Allow rule', 'sitemap', 'X-Robots-Tag', 'banner', 'canonical is https://dazl.ai']) assert.match(f, new RegExp(m))
})
test('a wrong commit stamp fails', async () => assert.match((await run({ ...staging, live: { commit: 'b'.repeat(40) } })).join('|'), /health commit/))
test('a missing banner alone fails', async () => assert.match((await run({ ...staging, home: stagingHome.replace('Staging - test data', 'x') })).join('|'), /banner/))
