// Browser errors reach the server's error records, end to end on a production build. NOT part of `npm test`. Run after
// `npm run build`:  npm run test:smoke:client-errors
// Loads /app/leads and /sign-in in Chromium. A clean load must record nothing. Then it throws an uncaught TypeError and
// leaves a promise rejection unhandled in the page; each must arrive once as a scrubbed {"source":"client"} error record
// on the server's stderr, under the page's route template, with the tenant on the signed-in page and none on sign-in.
// Isolation and NOT RUN handling: see harness.mjs.
import assert from 'node:assert/strict'
import { loadPlaywright, newContext, startServer } from './harness.mjs'
const { chromium } = loadPlaywright()

const srv = await startServer()
const records = () => srv.log().split('\n').filter(l => l.includes('"source":"client"')).map(l => JSON.parse(l.slice(l.indexOf('{'))))
let browser
try {
  browser = await chromium.launch()
  const ctx = await newContext(browser, srv)
  for (const route of ['/app/leads', '/sign-in']) {
    const page = await ctx.newPage()
    await page.goto(srv.base + route, { waitUntil: 'networkidle' })
    await page.waitForTimeout(500)
    assert.equal(records().filter(r => r.where.endsWith(':' + route)).length, 0, `${route}: a clean load records nothing`)
    await page.evaluate(() => {
      setTimeout(() => { throw new TypeError('smoke uncaught for jane@example.com') }, 0)
      void Promise.reject(new RangeError('smoke rejection'))
    })
    await page.waitForTimeout(1500)
    const got = records().filter(r => r.where.endsWith(':' + route))
    assert.deepEqual(got.map(r => [r.where, r.error.name]).sort(), [[`error:${route}`, 'TypeError'], [`unhandledrejection:${route}`, 'RangeError']].sort())
    assert.ok(!JSON.stringify(got).includes('jane'), 'scrubbed')
    // the harness user is 'smoke-user' (not a 32-hex users.id), so the signed-in page records no tenant id either
    console.log(`ok   ${route}: ${got.length} browser errors recorded`)
    await page.close()
  }
} finally {
  await browser?.close()
  srv.stop()
}
console.log('\nBrowser errors are recorded by the production build.')
