import assert from 'node:assert/strict'
import { loadPlaywright, newContext, startServer } from '../smoke/harness.mjs'

const { chromium } = loadPlaywright()
const server = await startServer()
let browser
try {
  browser = await chromium.launch({ executablePath: process.env.PW_CHROME })
  const context = await newContext(browser, server)
  const page = await context.newPage()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route(server.base + '/api/**', route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/api/leads/source-metrics') return route.fulfill({ json: {
      rows: [{ collector: 'test:source', jobs: 1, candidates: 9, verified: 8, inserted: 7,
        leads: 6, icp_graded: 5, strong_fit: 4, outreach_started: 3, replied: 2, recent_leads: 1 }],
      reply_window_days: 30, strong_fit_threshold: 4,
    } })
    if (pathname === '/api/scan/jobs') return route.fulfill({ json: { jobs: [] } })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto(server.base + '/app/leads')
  await page.getByText('Settings for this play', { exact: true }).click()
  await page.getByText(/^Source quality -/).click()
  const lastColumn = page.getByRole('columnheader', { name: 'Replies', exact: true })
  await lastColumn.waitFor()
  const layout = await lastColumn.evaluate(header => {
    const box = header.closest('table').parentElement
    const before = header.getBoundingClientRect().right
    box.scrollLeft = box.scrollWidth
    return {
      viewport: document.documentElement.clientWidth, documentWidth: document.documentElement.scrollWidth,
      pageOffset: window.scrollX, boxOffset: box.scrollLeft, boxRight: box.getBoundingClientRect().right,
      before, after: header.getBoundingClientRect().right,
    }
  })
  const evidence = JSON.stringify(layout)
  assert.equal(layout.viewport, 390, evidence)
  assert.equal(layout.documentWidth, 390, evidence)
  assert.equal(layout.pageOffset, 0, evidence)
  assert.ok(layout.before > layout.viewport, 'the final column initially extends offscreen: ' + evidence)
  assert.ok(layout.boxOffset > 0 && layout.after < layout.before, 'scrolling the table box moves its columns: ' + evidence)
  assert.ok(layout.after <= layout.boxRight + 1 && layout.after <= layout.viewport, 'Replies fits after scrolling: ' + evidence)
  console.log(evidence)
} finally {
  try { await browser?.close() } finally { server.stop() }
}
