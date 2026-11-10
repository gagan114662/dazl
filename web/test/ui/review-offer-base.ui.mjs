// The review step on Find leads warns about the same offer conflict a direct run is refused for (#349). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/review-offer-base.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, a throwaway synthetic database, the REAL routes and pages. Stand-in only at the paid boundary:
// the browser's /api/scan/icp answer (inferring the profile calls a model). The server runs under test/helpers/net-fence.ts
// and the browser aborts off-host requests. Nothing is scanned, drafted or sent.
// A reviewed run states its offer, so the server does not compare it with the saved one again: the review step is the
// only place that can warn. It used to compare the request with the business profile's offer only, while a direct run
// (POST /api/scan) and drafting use the profile offer, else the Memory positioning. At 1280 and 390 it proves:
//   1. a Memory-only tenant (no profile offer, Memory positioning = the dental offer) reviewing the original London CRM
//      request is asked which offer the play is for, and Run stays disabled; a direct run of the same request is refused
//      (409 offer_conflict) with the same two offers;
//   2. the original dental request (the same product) asks nothing, and a request that names no offer starts from the
//      Memory positioning instead of an empty field;
//   3. when the saved offer cannot be read, the page says so and Run stays disabled (fail closed); "Check again" then
//      shows the choice;
//   4. a tenant with a profile offer still gets the choice (control); reviewing writes nothing and queues no scan.
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pickUiPort } from '../helpers/ui-port.mjs'
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(dir, 'package.json'))
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? ' (allowed by SMOKE_ALLOW_SKIP=1)' : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
let chromium
try { ({ chromium } = require('playwright')) } catch (e) { notRun(e.message.split('\n')[0]) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const Database = require('better-sqlite3'); const { createHash, randomBytes } = require('crypto')
const { migrateAllSqlite } = await import(pathToFileURL(path.join(dir, 'lib/db/sqlite-migrations.ts')).href)

// The original #349 records, verbatim (issue comment of 2026-10-30), on synthetic accounts.
const SAVED = 'We sell appointment booking and reminder software to independent dental practices in New York City.'
const LONDON = 'Find B2B SaaS startups in London, UK that raised seed funding or are hiring their first sales representative in the last 90 days. We sell CRM setup and outbound sales consulting. Exclude agencies, directories and companies outside the UK. Show dated source evidence and founder or head of sales contacts.'
const DENTAL = 'Find independent dental practices in New York City with 1\u20135 locations that opened a new location or are hiring a receptionist in the last 90 days. We sell appointment booking and reminder software. Exclude large chains, vendors, directories, and practices outside NYC. Show the dated evidence and an owner or practice manager contact.'
const NO_OFFER = 'Find B2B SaaS startups in London, UK hiring their first sales representative.'
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-reviewbase-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
migrateAllSqlite(db)
const session = user => { const t = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(t).digest('hex'), user, Math.floor(Date.now() / 1000) + 3600); return t }
// m1: onboarding saved no offer; the offer lives in Settings > Memory (positioning). p1: the profile offer (control).
db.prepare("INSERT INTO users (id, email, password_hash, salt, business_name, email_verified_at) VALUES ('m1', 'memory@seller.test', 'x', 'y', 'Synthetic Memory Co', 1)").run()
db.prepare("INSERT INTO users (id, email, password_hash, salt, business_name, sells, email_verified_at) VALUES ('p1', 'profile@seller.test', 'x', 'y', 'Synthetic Profile Co', ?, 1)").run(SAVED)
db.prepare("INSERT INTO tenant_memory (tenant_id, positioning) VALUES ('m1', ?)").run(SAVED)
// a key row so the page offers its normal paths; nothing decrypts it (the profile answer is stubbed, no scan runs)
for (const u of ['m1', 'p1']) db.prepare("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES (?, 'anthropic', 'synthetic', 'AAAA', 0)").run(u)
const tokens = { m1: session('m1'), p1: session('p1') }
db.close()
const read = () => { const d = new Database(DB, { readonly: true }); try { return {
  jobs: d.prepare('SELECT COUNT(*) AS n FROM scan_jobs').get().n,
  users: d.prepare('SELECT id, sells, website FROM users ORDER BY id').all(),
  memory: d.prepare('SELECT tenant_id, positioning FROM tenant_memory ORDER BY tenant_id').all(),
} } finally { d.close() } }
const s0 = read()

const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', SCAN_MAX_CONCURRENT: '0', NODE_OPTIONS: `--experimental-strip-types --import ${pathToFileURL(path.join(dir, 'test/helpers/net-fence.ts')).href}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }
const b = await chromium.launch()
const ICP = { summary: 'B2B SaaS startups in London', who: ['Founders'], industries: ['B2B SaaS'], sizes: [], where: ['London, UK'], signals: ['Hiring a first sales representative'], exclude: ['Agencies'] }
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: false }) }
async function context(user, width) {
  const ctx = await b.newContext({ viewport: { width, height: 900 } })
  await ctx.addCookies([{ name: 'dazl_session', value: tokens[user], url: base }])
  const page = await ctx.newPage(); await page.route(u => u.origin !== base, r => r.abort())
  await page.route('**/api/scan/icp', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ icp: ICP, inferred: true }) }))
  await page.goto(base + '/app/leads', { waitUntil: 'networkidle' })
  return { ctx, page }
}
const api = (page, method, url, body) => page.evaluate(async ([m, u, bd]) => { const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: bd === undefined ? undefined : JSON.stringify(bd) }); return { status: r.status, json: await r.json().catch(() => null) } }, [method, url, body])
const run = page => page.getByRole('button', { name: 'Run scan with this profile' }).first()
async function review(page, query) {
  await page.getByPlaceholder('Find people who...').fill(query)
  await page.getByRole('button', { name: 'Review profile first' }).click()
  await page.getByTestId('review-offer').waitFor({ timeout: 15000 })
  await page.waitForTimeout(300)
}
const noScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)

try {
  for (const w of [1280, 390]) {
    // 1. Memory-only tenant, original London request: the choice, Run disabled; the direct run is refused the same way
    { const { ctx, page } = await context('m1', w)
      await review(page, LONDON)
      await page.getByTestId('review-offer').scrollIntoViewIfNeeded(); await shot(page, `review-1-memory-only-london-${w}`)
      const chooser = page.getByTestId('offer-chooser')
      assert.equal(await chooser.count(), 1, `${w}: the review step asks which offer this play is for`)
      const text = await chooser.innerText()
      assert.match(text, /CRM setup and outbound sales consulting/); assert.match(text, /appointment booking and reminder software/)
      assert.ok(await run(page).isDisabled(), `${w}: Run is disabled until the offer is chosen`)
      assert.ok(await noScroll(page), `${w}: no horizontal scroll`)
      const direct = await api(page, 'POST', '/api/scan', { query: LONDON })
      assert.deepEqual([direct.status, direct.json?.error, direct.json?.stated, direct.json?.saved], [409, 'offer_conflict', 'CRM setup and outbound sales consulting', SAVED], `${w}: a direct run is refused with the same two offers`)
      await ctx.close() }
    // 2. the same product asks nothing; a request without an offer starts from the Memory positioning
    { const { ctx, page } = await context('m1', w)
      await review(page, DENTAL)
      assert.equal(await page.getByTestId('offer-chooser').count(), 0, `${w}: the same dental product is no conflict`)
      assert.equal(await page.getByTestId('review-offer-input').inputValue(), 'appointment booking and reminder software')
      assert.ok(!(await run(page).isDisabled()), `${w}: Run is enabled`)
      await page.goto(base + '/app/leads', { waitUntil: 'networkidle' })
      await review(page, NO_OFFER)
      assert.equal(await page.getByTestId('offer-chooser').count(), 0)
      assert.equal(await page.getByTestId('review-offer-input').inputValue(), SAVED, `${w}: a request without an offer starts from the Memory positioning`)
      await page.getByTestId('review-offer').scrollIntoViewIfNeeded(); await shot(page, `review-2-memory-only-no-offer-${w}`)
      await ctx.close() }
    // 3. the saved offer cannot be read: say so, Run disabled; Check again shows the choice
    { const { ctx, page } = await context('m1', w)
      await page.route('**/api/settings/profile', r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }))
      await review(page, LONDON)
      const unread = page.getByTestId('offer-unread')
      assert.equal(await unread.count(), 1, `${w}: an unreadable saved offer is said`)
      assert.equal(await page.getByTestId('offer-chooser').count(), 0)
      assert.ok(await run(page).isDisabled(), `${w}: Run is disabled while the saved offer is unknown`)
      await unread.scrollIntoViewIfNeeded(); await shot(page, `review-3-unread-${w}`)
      await page.unroute('**/api/settings/profile')
      await page.getByTestId('offer-recheck').click()
      await page.getByTestId('offer-chooser').waitFor({ timeout: 15000 })
      assert.equal(await unread.count(), 0); assert.ok(await run(page).isDisabled(), `${w}: still disabled until the choice`)
      await ctx.close() }
    // 4. control: a profile offer still asks
    { const { ctx, page } = await context('p1', w)
      await review(page, LONDON)
      assert.equal(await page.getByTestId('offer-chooser').count(), 1, `${w}: the profile-offer tenant is asked too`)
      assert.ok(await run(page).isDisabled())
      await ctx.close() }
  }
  assert.deepEqual(read(), s0, 'reviewing wrote nothing and queued no scan')
  console.log('review offer base passed: a Memory-only tenant is asked to choose for the original London request (as the direct run is refused), the dental control asks nothing, a request without an offer starts from the Memory positioning, an unreadable saved offer blocks Run until rechecked, a profile-offer tenant is still asked; 1280 and 390; nothing written')
} finally {
  await b.close()
  const exited = new Promise(r => srv.once('exit', r)); srv.kill(); await exited
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows may still hold the file a moment: a temp dir, never a result */ }
}
