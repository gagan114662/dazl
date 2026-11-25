// Build first with npm run build, then run with node test/ui/source-quality-overflow-1770.ui.mjs.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pickUiPort } from '../helpers/ui-port.mjs'

const dir = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(path.join(dir, 'package.json'))
const { chromium } = require('playwright')
const Database = require('better-sqlite3')
const temp = mkdtempSync(path.join(tmpdir(), 'source-quality-'))
const dbPath = path.join(temp, 'app.db')
const token = randomBytes(32).toString('hex')
const db = new Database(dbPath)
db.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT,
    sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()), email_verified_at INTEGER);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);
  INSERT INTO users (id, email, password_hash, salt, email_verified_at) VALUES ('u1', 'test@example.test', 'x', 'y', 1);
`)
db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 'u1', unixepoch() + 3600)")
  .run(createHash('sha256').update(token).digest('hex'))
db.close()

const port = pickUiPort()
const origin = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], {
  cwd: dir,
  env: { PATH: process.env.PATH, DB_PATH: dbPath, NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` },
  stdio: 'ignore',
})
let browser
try {
  let ready = false
  for (let i = 0; i < 150 && server.exitCode === null; i++) {
    const response = await fetch(origin + '/sign-in').catch(() => null)
    if (response?.ok) { ready = true; break }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(ready, 'production build started')
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  await context.addCookies([{ name: 'dazl_session', value: token, url: origin }])
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    if (url.pathname === '/api/leads/source-metrics') return route.fulfill({ json: {
      reply_window_days: 30, strong_fit_threshold: 4,
      rows: [{ collector: 'search:claude_discover', jobs: 1, candidates: 24, verified: 14,
        inserted: 12, leads: 10, icp_graded: 9, strong_fit: 8, outreach_started: 6, replied: 4, recent_leads: 5 }],
    } })
    if (url.pathname === '/api/scan/jobs') return route.fulfill({ json: { jobs: [] } })
    return route.fulfill({ status: 404, json: {} })
  })
  const page = await context.newPage()
  await page.goto(origin + '/app/leads')
  await page.getByText('Settings for this play', { exact: true }).click()
  await page.getByText(/^Source quality -/).click()
  const table = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Cands', exact: true }) })
  await table.waitFor()
  const layout = await table.evaluate(element => {
    const scroller = element.parentElement
    const pane = element.closest('main')
    const overflowX = getComputedStyle(scroller).overflowX
    scroller.scrollLeft = scroller.scrollWidth
    return { width: window.innerWidth, paneWidth: pane.clientWidth, paneScrollWidth: pane.scrollWidth,
      tableWidth: element.offsetWidth, scrollerWidth: scroller.clientWidth, tableScrollLeft: scroller.scrollLeft, overflowX }
  })
  assert.equal(layout.width, 390)
  assert.ok(layout.paneScrollWidth <= layout.paneWidth, `Leads pane overflows horizontally: ${JSON.stringify(layout)}`)
  assert.equal(layout.overflowX, 'auto')
  assert.ok(layout.tableWidth > layout.scrollerWidth, 'the fixture exercises a wider table')
  assert.ok(layout.tableScrollLeft > 0, 'the last columns can be reached by scrolling the table')
} finally {
  await browser?.close()
  server.kill()
  rmSync(temp, { recursive: true, force: true })
}
