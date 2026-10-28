// Rendered check for the copy pass: long caveats on Settings, Outreach and Leads show one sentence, with the full
// original wording under a closed "Details". NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/caveats.ui.mjs   (SHOTS=<dir> saves screenshots; BEFORE_ONLY=1 only shoots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, and EVERY /api/* CALL ANSWERED
// FROM A STUB in the browser: nothing is scanned, drafted or sent. It proves, per page:
//   1. each shortened caveat shows exactly one visible sentence and a closed Details;
//   2. the Details holds the original caveat text word for word (nothing a caveat claims is removed) and opens on click;
//   3. the paid-enrichment cost (1 credit per company, up to 50, when a key is enabled) is visible beside Import;
//   4. loading writes nothing.
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import path from 'node:path'
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(dir, 'package.json'))
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? ' (allowed by SMOKE_ALLOW_SKIP=1)' : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
let chromium
try { ({ chromium } = require('playwright')) } catch (e) { notRun(e.message.split('\n')[0]) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const Database = require('better-sqlite3'); const { createHash, randomBytes } = require('crypto')
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-caveats-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

// The original caveat paragraphs, verbatim (as they were before the copy pass).
const ORIGINAL = {
  settings: [
    "Emails go out from your own Gmail. By default each one is sent after you approve it; if you turn on autopilot below, it can send first emails on its own within the limits you set. Connecting also asks for read access, limited to replies in the threads dazl started for you and delivery-failure notices for them - dazl never lists, searches, or reads anything else in your mailbox. On Google's consent screen you can untick the read access and still connect send-only.",
    "dazl reads public web pages for free. No paid lookup service is used and no outside API key is needed. Tier 0 channels need no setup. Session channels are optional and stay off until you accept the risk notice and connect your own account.",
    "Session channels use your own logged-in session on a platform to find leads there. This breaks the terms of most of these platforms. They can limit or ban the account you use. Use a throwaway account, never your main one. You accept that risk yourself; dazl cannot protect your account.",
    "Your session is encrypted, used only for your scans, rate limited, and logged below your scans in the lookup history. Leads from pages behind a login are never verified automatically. They go to needs review. Remove a session at any time.",
    "What dazl remembers about how you sell. It shapes outreach drafts, follow-ups and lead scoring, on your own AI key (a few hundred extra tokens per call). Exclusions are hard rules: matching companies never reach your leads.",
  ],
  outreach: [
    "Review each email, approve it, then send. Manual emails send only after your click. If you turn on autopilot, it can send first emails on its own after you approve the first sends (its consent text is in Settings). A sequence sends its later steps only after you approve all three steps together. Every email gets your name, mailing address and an unsubscribe link added automatically.",
    "Create a three-step sequence from a draft above. Review and edit every word, then approve the set once. Send step 1 yourself. If there is no reply, steps 2 and 3 send automatically at 3 and 7 days after step 1. Any human reply, bounce or opt-out stops the sequence. No content is generated after approval.",
  ],
  leads: [
    "Save one company and your claim with an exact source quote. One public HTTPS page is checked, with no model, paid renderer or enrichment. This does not verify buying intent, current need, date, ownership or consent. It lands in needs-review, not confirmed by you.",
    "Reads a public job feed and saves up to 6 companies whose posted role title contains your role words. A job posting is a hiring signal only. It does not show buying intent, fit or current need. Each company lands in needs-review, ungraded, with the posting line as the quote. After saving, each company's own site is read for a published contact. A read that does not finish is marked and can be retried here. Nothing is sent.",
    "People who engaged with a post, imported as leads. Upload a CSV with profile URL, name, title and company columns, or paste LinkedIn profile links (linkedin.com/in/...) one per line, up to 100. Links are never opened - no scraping. Names guessed from a link are marked derived; your CSV names win. Only your Apollo/PDL key (org lookup, 1 credit per company, max 50) and free sources enrich them.",
  ],
}
const writes = []
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname
  if (u.origin !== base) return route.abort()
  if (!p.startsWith('/api/')) return route.continue()
  if (m !== 'GET') writes.push(`${m} ${p}`)
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (p === '/api/settings/advanced') return json({ available: true, version: '1', platforms: [] })
  if (p === '/api/outreach/sequences') return json({ sequences: [], test_addresses: [], status: {}, campaigns: [] })
  if (p === '/api/outreach/settings') return json({ gmail: null, sender: null, daily_cap: 20, sent_24h: 0 })
  if (p === '/api/usage') return json({ plan: 'pro', scans_used: 0, scan_limit: 10, has_key: true, trial: null })
  if (p === '/api/outreach') return json({ messages: [] })
  if (p === '/api/scan/jobs') return json({ jobs: [] })
  return json({}, 404)
})
const page = await ctx.newPage()
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
const before = process.env.BEFORE_ONLY === '1'
const norm = t => t.replace(/\s+/g, ' ').trim()
try {
  for (const [name, url] of [['settings', '/app/settings'], ['outreach', '/app/outreach'], ['leads', '/app/leads']]) {
    await page.goto(base + url, { waitUntil: 'networkidle' })
    // Open the page's own collapsible sections (not the caveats' Details) so every caveat is on screen.
    await page.evaluate(() => document.querySelectorAll('details').forEach(d => { if (!d.parentElement?.closest('[data-testid=caveat]') && !d.closest('[data-testid=caveat]')) d.open = true }))
    await page.waitForTimeout(300)
    await shot(name)
    if (before) continue
    const cav = page.getByTestId('caveat')
    const found = await cav.evaluateAll(els => els.map(e => ({ summary: e.querySelector(':scope > p').textContent, open: e.querySelector(':scope > details').open, full: e.querySelector(':scope > details > p').textContent })))
    const fulls = found.map(f => norm(f.full)); if (process.env.DEBUG) console.log(name, JSON.stringify(fulls, null, 1))
    for (const o of ORIGINAL[name]) assert.ok(fulls.includes(norm(o)), `${name}: original caveat kept verbatim under Details: ${o.slice(0, 60)}`)
    for (const f of found) {
      assert.equal(f.open, false, `${name}: Details closed by default`)
      assert.equal((f.summary.match(/[.!?](\s|$)/g) ?? []).length, 1, `${name}: one sentence: ${f.summary}`)
      assert.ok(f.summary.length < f.full.length, `${name}: shorter than the full text`)
    }
    for (let k = 0; k < found.length; k++) {
      const c = cav.nth(k)
      if (!(await c.isVisible())) continue
      assert.equal(await c.locator(':scope > details > p').isVisible(), false)
      await c.getByText('Details', { exact: true }).click()
      assert.equal(await c.locator(':scope > details > p').isVisible(), true)
    }
    if (name === 'leads') {
      // Instinct #278: the paid-enrichment cost is visible beside Import without opening any caveat Details.
      await page.reload({ waitUntil: 'networkidle' })
      await page.evaluate(() => document.querySelectorAll('details').forEach(d => { if (!d.closest('[data-testid=caveat]')) d.open = true })) // the page's own sections, never a caveat's
      const cost = page.getByTestId('import-cost')
      assert.equal(await cost.isVisible(), true, 'cost line visible with every caveat Details still closed')
      assert.equal(await page.locator('[data-testid=caveat] details[open]').count(), 0)
      assert.match(await cost.textContent(), /Apollo or People Data Labs key is enabled.*Import uses it automatically - 1 credit per company, up to 50 companies/)
      assert.equal(await cost.evaluate(e => !!e.closest('[data-testid=caveat]')), false, 'not part of a collapsible caveat')
      assert.equal(await cost.evaluate(e => e.parentElement.querySelector('button')?.textContent), 'Import', 'beside the Import button')
    }
    await shot(`${name}-details-open`)
  }
  assert.deepEqual(writes, [], 'loading and opening Details write nothing')
  console.log(before ? 'screenshots taken (BEFORE_ONLY)' : 'caveats UI check passed: Settings, Outreach and Leads caveats show one sentence with the original text verbatim under a closed Details; no writes')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
