// Two-tenant leak check on the production build (issue #362). NOT part of `npm test` (needs a build and a browser). Run:
//   cd web && npm run build && npm run test:smoke:tenants
// Two tenants on one throwaway database, each with its own scan and leads carrying a unique marker string. Then:
// - positive controls: each tenant's own scan list, and some response its pages load, show its own marker (so a
//   "not found" below means something);
// - every session GET route in the tenant isolation manifest without a path segment, called as each tenant, plainly
//   and with the OTHER tenant's scan id in the usual query parameters: the other tenant's marker never appears;
// - every /app page in Chromium, signed in as each tenant: neither the rendered page nor any same-origin response
//   (HTML, RSC payloads, /api JSON) contains the other tenant's marker.
// The unit suite proves each route handler's tenant scoping; this proves the built, server-rendered app keeps it.
// Isolation and NOT RUN handling as harness.mjs: throwaway database, network fence, off-host requests aborted.
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { appRoutes, loadPlaywright, newContext, root, startServer } from './harness.mjs'
const { chromium } = loadPlaywright()
const require = createRequire(path.join(root, 'package.json'))

const { ROUTES } = await import('../tenant-isolation-manifest.ts')
const { migrateAllSqlite } = await import('../../lib/db/sqlite-migrations.ts')
const { sqliteDb } = await import('../../lib/db/client.ts')
const { createQueryJob, finishJob } = await import('../../lib/scan/store-db.ts')

const tag = randomBytes(4).toString('hex')
const tenants = {
  A: { id: 'smoke-user', marker: `Alderbrook Joinery ${tag}A`, job: null, token: null },
  B: { id: 'smoke-tenant-b', marker: `Birchfield Bakery ${tag}B`, job: null, token: randomBytes(32).toString('hex') },
}
const now = Math.floor(Date.now() / 1000)
const lead = (t, n) => ({
  name: 'Owner', company: `${t.marker} ${n}`, contact: null, signal: `Opening a new site (${t.marker})`, source_url: `https://${t.id}-${n}.example.test/news`,
  score: 80, evidence_excerpt: `${t.marker} is opening a new site. (synthetic smoke data)`, event_date: new Date(now * 1000).toISOString().slice(0, 10),
  date_status: 'verified', retrieved_at: now, confidence: 80, dedup_key: `smoke:${t.id}:${n}`, fit: 4, intent: 4, action: 4, why: 'synthetic',
  signal_kind: 'expansion', source_kind: 'company_site',
})

const srv = await startServer({
  prepare: async dbPath => {
    const Database = require('better-sqlite3')
    const raw = new Database(dbPath)
    try {
      migrateAllSqlite(raw)
      raw.prepare("INSERT INTO users (id, email, password_hash, salt) VALUES (?, 'tenant-b@example.test', 'x', 'y')").run(tenants.B.id)
      raw.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(tenants.B.token).digest('hex'), tenants.B.id, now + 3600)
      const db = sqliteDb(raw)
      for (const t of Object.values(tenants)) {
        t.job = await createQueryJob(db, t.id, { query: `Scan for ${t.marker}` }, now - 600)
        await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id = ?", [now - 600, t.job])
        await finishJob(db, { id: t.job, attempts: 1 }, { status: 'done', error: null, leads: [lead(t, 1), lead(t, 2)], candidates: 2, dropped: {}, now: now - 300 })
      }
    } finally { raw.close() }
  },
})
tenants.A.token = srv.token
const failures = []
const other = { A: tenants.B, B: tenants.A }
const get = (name, url) => fetch(srv.base + url, { headers: { cookie: `dazl_session=${tenants[name].token}` }, redirect: 'manual' }).then(async r => ({ status: r.status, body: await r.text() }))

let browser
try {
  for (const name of ['A', 'B']) {
    const own = await get(name, '/api/scan/jobs')
    if (own.status !== 200 || !own.body.includes(tenants[name].marker)) failures.push(`control: tenant ${name} does not see its own scan in /api/scan/jobs (HTTP ${own.status})`)
  }
  console.log('ok   control: each tenant sees its own scan')

  const apis = ROUTES.filter(r => r.method === 'GET' && r.auth === 'session' && !r.path.includes('['))
  let calls = 0
  for (const name of ['A', 'B']) {
    const foreign = other[name]
    for (const r of apis) {
      for (const qs of ['', `?job_id=${foreign.job}&id=${foreign.job}&batch=${foreign.job}&scan=${foreign.job}`]) {
        const res = await get(name, `/api/${r.path}${qs}`); calls++
        // 503 is a route whose provider is not configured here (gmail/connect); a 500 is a crash
        if (res.status === 500) failures.push(`${name} GET /api/${r.path}${qs ? ' (foreign ids)' : ''}: HTTP ${res.status}`)
        if (res.body.includes(foreign.marker)) failures.push(`LEAK: tenant ${name} GET /api/${r.path}${qs ? ' with the other tenant\'s ids' : ''} returned the other tenant's data`)
      }
    }
  }
  console.log(`ok   ${calls} API calls across ${apis.length} session GET routes`)

  browser = await chromium.launch()
  for (const name of ['A', 'B']) {
    const foreign = other[name]
    const ctx = await newContext(browser, { base: srv.base, token: tenants[name].token })
    let sawOwn = false
    for (const route of appRoutes()) {
      const page = await ctx.newPage(); const leaks = []
      page.on('response', async res => {
        if (new URL(res.url()).origin !== srv.base) return
        const text = await res.text().catch(() => '')
        if (text.includes(foreign.marker)) leaks.push(new URL(res.url()).pathname)
        if (text.includes(tenants[name].marker)) sawOwn = true
      })
      await page.goto(srv.base + route, { waitUntil: 'networkidle' }).catch(e => leaks.push(`navigation failed: ${e.message.split('\n')[0]}`))
      await page.waitForTimeout(300)
      const text = await page.locator('body').innerText().catch(() => '')
      if (text.includes(foreign.marker)) leaks.push('rendered page')
      console.log(`${leaks.length ? 'FAIL' : 'ok  '} tenant ${name} ${route}`)
      for (const l of leaks) failures.push(`LEAK: tenant ${name} on ${route}: the other tenant's data in ${l}`)
      await page.close()
    }
    await ctx.close()
    // control: the response check saw this tenant's own data somewhere, so it is really reading what the pages load
    if (!sawOwn) failures.push(`control: no page response for tenant ${name} contained its own data`)
  }
} finally {
  await browser?.close()
  srv.stop()
}
if (failures.length) { for (const f of failures) console.log(f); console.log(`\n${failures.length} problem(s)`); process.exit(1) }
console.log('\nTwo tenants on the production build: no route or page returned the other tenant\'s data.')
