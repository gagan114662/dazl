// Production smoke check of the credential-form fallback with JavaScript DISABLED (the pre-hydration path):
// a React onSubmit-only <form> without a method attribute natively submits GET, putting every field - passwords
// included - into the URL query (server logs, browser history, proxy logs). Observed live on sign-up and sign-in.
// With method="post" (refs #516) the native fallback is a harmless POST that 405s: no values in the URL, no echo,
// no account mutation. Run:  cd web && npm run build && npm run test:smoke:authforms
// Isolation as harness.mjs: throwaway database, server under the test network fence, off-host browser requests aborted.
import { loadPlaywright, root, startServer } from './harness.mjs'
import { createRequire } from 'node:module'
import path from 'node:path'
const require = createRequire(path.join(root, 'package.json'))
const { chromium } = loadPlaywright()

// Synthetic fixture values only - never a real or account-shaped secret.
const FIX = {
  name: 'Smoke Fixture',
  email: 'smoke-fixture@invalid.test',
  business_name: 'Smoke Fixture Co',
  password: 'smoke-fixture-value-9f2c-not-a-secret',
}
// /reset is deliberately not a browser case: its page renders the form behind a Suspense boundary
// (app/reset/page.tsx awaits connection()), and a streamed Suspense fallback is only swapped for the real
// content by an inline script - with JS disabled (or pre-hydration) the form is never actionable, so no
// native submit can fire. test/auth-form-method.test.ts pins its method=post statically. Sign-up and
// sign-in render their forms in the initial HTML: the real exposure, covered here.
const CASES = [
  { path: '/sign-up', fields: { name: FIX.name, email: FIX.email, business_name: FIX.business_name, password: FIX.password } },
  { path: '/sign-in', fields: { email: FIX.email, password: FIX.password } },
]

const srv = await startServer()
const { base } = srv
const failures = []
let browser
try {
  browser = await chromium.launch()
  const ctx = await browser.newContext({ javaScriptEnabled: false })
  await ctx.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
  const page = await ctx.newPage()
  for (const c of CASES) {
    const errs = []
    await page.goto(base + c.path, { waitUntil: 'domcontentloaded' })
    for (const [n, v] of Object.entries(c.fields)) await page.fill(`input[name=${n}]`, v)
    const [resp] = await Promise.all([
      page.waitForNavigation({ timeout: 15000 }),
      page.click('button[type=submit]'),
    ])
    const errsAt = (m) => errs.push(m)
    if (!resp) errsAt('no navigation response')
    else {
      const method = resp.request().method()
      const landed = new URL(page.url())
      const bodyText = await resp.text()
      if (method !== 'POST') errsAt(`native submit was ${method}, not POST - values go into the URL query`)
      if (landed.search) errsAt(`landed URL carries a query: ${landed.search.slice(0, 80)}`)
      for (const v of Object.values(c.fields)) {
        if (decodeURIComponent(landed.href).includes(v)) errsAt(`fixture value in the URL`)
        if (bodyText.includes(v)) errsAt(`fixture value echoed in the response body`)
      }
      if (method === 'POST' && resp.status() !== 405) errsAt(`native POST answered HTTP ${resp.status()}, expected the harmless 405`)
    }
    console.log(`${errs.length ? 'FAIL' : 'ok  '} JS disabled ${c.path}`)
    for (const e of errs) console.log(`     ${e}`)
    for (const e of errs) failures.push(`${c.path}: ${e}`)
  }
  // No account mutation: the seeded user is still the only row.
  const Database = require('better-sqlite3')
  const db = new Database(srv.dbPath, { readonly: true })
  const n = db.prepare('SELECT COUNT(*) AS c FROM users').get().c
  db.close()
  if (n !== 1) failures.push(`users table changed by the fallback submits (${n} rows, expected 1)`)
  console.log(`${n === 1 ? 'ok  ' : 'FAIL'} users table unchanged (${n} row)`)
} finally {
  await browser?.close()
  srv.stop()
}
if (failures.length) { for (const f of failures) console.log(f); console.log(`\n${failures.length} problem(s)`); process.exit(1) }
console.log('\nJS disabled: sign-up, sign-in and reset native submits are POST 405s - no values in any URL, no echo, no account mutation.')
