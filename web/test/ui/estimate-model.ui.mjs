// #851 on the REAL styled app: the pre-launch price estimate shows the model the run will really call. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/estimate-model.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build (`next start`, the app's own stylesheet), a throwaway synthetic database, and the REAL routes:
// /api/scan/estimate answers from the server's own estimateForBody/estimateRun for the signed-in workspace's own key. Stand-ins
// only at the paid boundary, in the browser: /api/scan/icp (inferring a profile calls a model) gets a synthetic profile, and
// POST /api/scan is refused (418) and counted, so no run can start; no test step confirms a run anyway. The server runs under
// test/helpers/net-fence.ts (any non-loopback request throws) with SCAN_MAX_CONCURRENT=0; the browser aborts off-host requests.
// The keys are synthetic, sealed with a master generated for this run only, and never decrypted by the estimate.
// At 1280 and 390 px it proves:
//   1. OpenAI-key workspace, no limit: the panel prices gpt-4.1 (its own unit price) and never names claude-sonnet-4-5;
//      verdict ok; Cancel starts nothing.
//   2. Same workspace, run limit $2: blocked BEFORE launch (model_unpriced), no Run button, what to change is listed.
//   3. Anthropic-key workspace (control): the panel prices claude-sonnet-4-5 at its listed price.
//   Each state: the page has no horizontal overflow (documentElement.scrollWidth <= clientWidth) and the panel's box fits
//   inside the viewport width.
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
const url = p => pathToFileURL(path.join(dir, p)).href // file URLs: a bare C:\ path is not a valid ESM specifier on Windows
const Database = require('better-sqlite3'); const { createHash, randomBytes } = require('crypto')
const { migrateAllSqlite } = await import(url('lib/db/sqlite-migrations.ts'))
const { encryptSecret } = await import(url('lib/secrets.ts'))

const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-estmodel-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
migrateAllSqlite(db)
const SELLS = 'We sell appointment booking and reminder software to independent dental practices.'
const session = user => { const t = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(t).digest('hex'), user, Math.floor(Date.now() / 1000) + 3600); return t }
const MASTER = randomBytes(32)
for (const [id, vendor, last4] of [['u-openai', 'openai', 'OOOO'], ['u-anthropic', 'anthropic', 'AAAA']]) {
  db.prepare("INSERT INTO users (id, email, password_hash, salt, business_name, sells, website) VALUES (?, ?, 'x', 'y', 'Synthetic Dental Software Co', ?, 'https://seller.example')").run(id, `${id}@seller.test`, SELLS)
  db.prepare('INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES (?, ?, ?, ?, 0)').run(id, vendor, encryptSecret(`synthetic-${vendor}-key-not-real-${'0'.repeat(24)}`, `llm-key:${id}:${vendor}`, MASTER), last4)
}
const tokens = { openai: session('u-openai'), anthropic: session('u-anthropic') }
db.close()

const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const env = { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', SCAN_MAX_CONCURRENT: '0', NODE_OPTIONS: `--experimental-strip-types --import ${url('test/helpers/net-fence.ts')}` }
for (const k of ['SystemRoot', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k] // Windows needs SystemRoot for sockets
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env, stdio: 'ignore' })
let up = false
for (let i = 0; i < 300 && !up; i++) { try { await fetch(base + '/sign-in'); up = true } catch { await new Promise(r => setTimeout(r, 200)) } }
assert.ok(up, 'next start did not come up')
const b = await chromium.launch()
const ICP = { summary: 'Owner-run dental practices in Ohio', who: ['Practice owner'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['Opened a new location'], exclude: [] }
const Q = 'Dental practice owners in Ohio who opened a new location'
const shot = async (target, name) => { if (process.env.SHOTS) await target.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }) }

async function open(who, width) {
  const ctx = await b.newContext({ viewport: { width, height: 900 } })
  await ctx.addCookies([{ name: 'dazl_session', value: tokens[who], url: base }])
  const scans = [], estimates = []
  await ctx.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url())
    if (u.origin !== base) return route.abort()
    if (u.pathname === '/api/scan/icp') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ icp: ICP, inferred: true }) })
    if (u.pathname === '/api/scan' && req.method() === 'POST') { scans.push(req.postData()); return route.fulfill({ status: 418, contentType: 'application/json', body: '{"error":"fenced: no scan starts in this check"}' }) }
    return route.continue() // everything else, /api/scan/estimate included, is the real server
  })
  const page = await ctx.newPage()
  page.on('response', async r => { if (new URL(r.url()).pathname === '/api/scan/estimate') estimates.push({ status: r.status(), body: await r.json().catch(() => null) }) })
  await page.goto(base + '/app/leads', { waitUntil: 'networkidle' })
  return { ctx, page, scans, estimates }
}
async function noOverflow(page, panel, tag) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }))
  assert.ok(m.sw <= m.cw && m.bw <= m.cw, `${tag}: horizontal page overflow (scrollWidth ${m.sw}/${m.bw} > clientWidth ${m.cw})`)
  const box = await panel.boundingBox()
  assert.ok(box && box.x >= 0 && box.x + box.width <= m.cw + 0.5, `${tag}: the estimate panel spills past the viewport (${JSON.stringify(box)} vs ${m.cw})`)
  const tbl = await page.getByTestId('estimate-rows').evaluate(t => ({ table: t.scrollWidth, wrap: t.parentElement.clientWidth }))
  // the menu itself must not hide a column behind a sideways scroll either: every row's projected cost is inside the viewport
  assert.ok(tbl.table <= tbl.wrap, `${tag}: the estimate table scrolls sideways inside its panel (${tbl.table} > ${tbl.wrap})`)
  for (const c of await page.getByTestId('estimate-row-usd').all()) {
    const r = await c.boundingBox(); assert.ok(r && r.x >= 0 && r.x + r.width <= m.cw + 0.5, `${tag}: a projected cost is off screen (${JSON.stringify(r)})`)
  }
  return { ...m, panel: Math.round(box.width), table: tbl.table, wrap: tbl.wrap }
}
// The page scrolls inside the app shell, so an element taller than the viewport is cut in an element shot: grow the viewport
// HEIGHT only (the width, and so the layout under test, is unchanged) for the panel shot.
async function panelShot(page, panel, name, w) {
  const h = Math.ceil((await panel.boundingBox()).height) + 400
  await page.setViewportSize({ width: w, height: Math.max(900, h) }); await panel.scrollIntoViewIfNeeded()
  assert.equal(await page.evaluate(() => document.documentElement.clientWidth), w)
  await shot(panel, name); await page.setViewportSize({ width: w, height: 900 })
}
const report = []
try {
  for (const [w, tag] of [[1280, '1280'], [390, '390']]) {
    // 1. OpenAI key, no limit: gpt-4.1 is priced, the default model is never shown
    {
      const { ctx, page, scans, estimates } = await open('openai', w)
      await page.getByLabel('Who do you want to reach?').fill(Q)
      await page.getByRole('button', { name: 'Find leads' }).click()
      const panel = page.getByTestId('estimate-confirm'); await panel.waitFor({ timeout: 20000 })
      assert.equal(estimates.at(-1)?.status, 200, 'the real /api/scan/estimate answered')
      assert.ok(/\(gpt-4\.1\)/.test(estimates.at(-1).body.estimate.rows[0].unit_usd), 'server priced gpt-4.1')
      const t = await panel.innerText()
      assert.match(t, /\$3\.50 in \/ \$14\.00 out per 1M tokens \(gpt-4\.1\)/, `${tag}: gpt-4.1's own unit price is on the page`)
      assert.ok(!t.includes('claude-sonnet-4-5'), `${tag}: the default model is not shown for an OpenAI key`)
      assert.equal(await panel.getAttribute('data-verdict'), 'ok')
      assert.match(await page.getByTestId('estimate-confirm-run').innerText(), /^Confirm and run \(about \$/)
      report.push([`openai-nolimit-${tag}`, await noOverflow(page, panel, `openai no limit ${tag}`)])
      await shot(page, `estimate-gpt41-page-${tag}`); await panelShot(page, panel, `estimate-gpt41-panel-${tag}`, w)
      await page.getByTestId('estimate-cancel').click(); await page.waitForTimeout(300)
      assert.equal(await page.getByTestId('estimate-confirm').count(), 0); assert.equal(scans.length, 0, `${tag}: Cancel starts nothing`)
      await ctx.close()
    }
    // 2. Same key under a $2 run limit: refused before launch, the confirmation itself says why and what to change
    {
      const { ctx, page, scans, estimates } = await open('openai', w)
      await page.getByLabel('Who do you want to reach?').fill(Q)
      await page.getByRole('button', { name: 'Review profile first' }).click()
      await page.getByTestId('budget-panel').waitFor({ timeout: 20000 })
      const offer = page.locator('#play-offer'); if (await offer.count() && !(await offer.inputValue()).trim()) await offer.fill('Appointment booking software')
      await page.getByLabel('Limit what this run may spend (optional)').check()
      await page.getByTestId('budget-max-usd').fill('2')
      await shot(page.getByTestId('budget-panel'), `budget-panel-limit-${tag}`)
      await page.getByRole('button', { name: 'Run scan with this profile' }).first().click()
      const panel = page.getByTestId('estimate-confirm'); await panel.waitFor({ timeout: 20000 })
      assert.equal(estimates.at(-1)?.status, 200); assert.equal(estimates.at(-1).body.estimate.verdict.reason, 'model_unpriced')
      assert.equal(await panel.getAttribute('data-verdict'), 'blocked')
      assert.equal(await page.getByTestId('estimate-confirm-run').count(), 0, `${tag}: no Run button while blocked`)
      assert.match(await page.getByTestId('estimate-verdict').innerText(), /^Your key's model \(gpt-4\.1\) has no listed price the spending limit can reserve against yet, so a run under a spending limit would stop at its first model call\. The model rows above use its list price for this estimate only\./)
      const change = await page.getByTestId('estimate-change').innerText()
      assert.match(change, /Run without a spending limit/); assert.match(change, /Or use an Anthropic key \(claude-sonnet-4-5 is priced\)/)
      report.push([`openai-limit-${tag}`, await noOverflow(page, panel, `openai limit ${tag}`)])
      await shot(page, `estimate-gpt41-limit-blocked-page-${tag}`); await panelShot(page, panel, `estimate-gpt41-limit-blocked-panel-${tag}`, w)
      assert.equal(scans.length, 0, `${tag}: a blocked estimate starts nothing`)
      await ctx.close()
    }
    // 3. Anthropic key (control): the listed claude-sonnet-4-5 price
    {
      const { ctx, page, scans } = await open('anthropic', w)
      await page.getByLabel('Who do you want to reach?').fill(Q)
      await page.getByRole('button', { name: 'Find leads' }).click()
      const panel = page.getByTestId('estimate-confirm'); await panel.waitFor({ timeout: 20000 })
      const t = await panel.innerText()
      assert.match(t, /\$3\.00 in \/ \$15\.00 out per 1M tokens \(claude-sonnet-4-5\)/, `${tag}: the Anthropic key's model is priced`)
      assert.ok(!t.includes('gpt-4.1'))
      assert.equal(await panel.getAttribute('data-verdict'), 'ok')
      report.push([`anthropic-nolimit-${tag}`, await noOverflow(page, panel, `anthropic ${tag}`)])
      await panelShot(page, panel, `estimate-claude-panel-${tag}`, w)
      assert.equal(scans.length, 0)
      await ctx.close()
    }
  }
  for (const [k, v] of report) console.log(`width ${k}: ${JSON.stringify(v)}`)
  console.log('estimate model UI check passed (real build + real /api/scan/estimate, 1280 and 390): an OpenAI key is priced as gpt-4.1 and never as claude-sonnet-4-5, blocked before launch under a limit with what to change; an Anthropic key is priced as claude-sonnet-4-5; no horizontal page overflow and no column scrolled off screen; no scan started')
} finally {
  await b.close(); srv.kill()
  await new Promise(r => setTimeout(r, 1000))
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows may still hold the db open (EBUSY); never mask the result */ }
}
