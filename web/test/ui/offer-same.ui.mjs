// Rendered check for the same-product offer (#349 live case). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/offer-same.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, and the REAL routes: nothing is
// stubbed, so the campaign and outreach pages show what the offer resolver (lib/scan/play-offer-text.ts) decides.
// Off-host requests are aborted; no scan runs and nothing is sent. At desktop (1280) and phone (390) width it proves:
//   1. a play whose request states "appointment booking and reminder software" while the saved offer is "We sell
//      appointment booking and reminder software to independent dental practices in New York City." shows that saved
//      offer on its Campaign and Outreach pages, with no choice to make;
//   2. the London CRM/outbound play, and the same product sold explicitly to veterinary practices, are still shown as a
//      choice on both pages;
//   3. viewing writes nothing: no offer is chosen for a play and the saved offer is not rewritten.
//   4. choosing CRM for the original full London request changes that play only. Home, campaign and a template
//      draft preview agree at both widths and after reload. The draft uses a synthetic eligible lead with a
//      synthetic passed hiring-gate precondition, not a promotion of either production play's research-only leads.
//      No provider, scan or send. The original dental snapshot and global profile remain unchanged.
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
const { migrateAllSqlite } = await import(path.join(dir, 'lib/db/sqlite-migrations.ts'))
const SAVED = 'We sell appointment booking and reminder software to independent dental practices in New York City.'
const DENTAL = 'd'.repeat(24), LONDON = 'e'.repeat(24), VET = 'f'.repeat(24)
// #349 live control (Instinct, 2026-10-30): the two ORIGINAL requests, verbatim, stored exactly as live: seller = the saved
// sentence with no website suffix (the profile website is empty), offer NULL. The dental one must show the saved offer
// with no choice; the London one must be a choice.
const LIVE_DENTAL = 'd2e67ea235567418b0b932d8', LIVE_LONDON = 'c53bb81d0b6d00d2a2f31144'
const LIVE_DENTAL_REQUEST = 'Find independent dental practices in New York City with 1–5 locations that opened a new location or are hiring a receptionist in the last 90 days. We sell appointment booking and reminder software. Exclude large chains, vendors, directories, and practices outside NYC. Show the dated evidence and an owner or practice manager contact.'
const LIVE_LONDON_REQUEST = 'Find B2B SaaS startups in London, UK that raised seed funding or are hiring their first sales representative in the last 90 days. We sell CRM setup and outbound sales consulting. Exclude agencies, directories and companies outside the UK. Show dated source evidence and founder or head of sales contacts.'
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-offersame-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
migrateAllSqlite(db)
db.prepare("INSERT INTO users (id, email, password_hash, salt, business_name, sells, website) VALUES ('u1', 's@example.test', 'x', 'y', 'Synthetic Co', ?, '')").run(SAVED)
for (const [id, query, industry, location] of [[LIVE_DENTAL, LIVE_DENTAL_REQUEST, 'Dental', 'New York City'], [LIVE_LONDON, LIVE_LONDON_REQUEST, 'SaaS', 'London, UK']]) {
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller, icp, icp_inferred, offer, offer_set_at) VALUES (?, 'u1', 'Dental Seller', ?, ?, 'running', ?, ?, '{\"summary\":\"synthetic\"}', 1, NULL, NULL)").run(id, industry, location, query, SAVED)
  db.prepare("INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, 'Synthetic Buyer', 'Pat', 'pat@buyer.example', 'Hiring', 'https://news.example/a', 'Synthetic Buyer is hiring.', 80)").run(`lead-${id}`, id)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES (?, 'u1', ?, 'pat@buyer.example', 'Hello', 'A synthetic draft body.', 'draft')").run(`m-${id}`, `lead-${id}`)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)
}
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600)
for (const [id, query] of [[DENTAL, 'Independent dental practices in New York City hiring a front-desk coordinator. We sell appointment booking and reminder software.'],
  [LONDON, 'Find London SaaS startups hiring. We sell CRM setup and outbound sales consulting. Exclude agencies.'],
  [VET, 'Veterinary clinics in New York City hiring. We sell appointment booking and reminder software to veterinary practices.']]) {
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller) VALUES (?, 'u1', 'Synthetic Co', 'i', 'l', 'running', ?, ?)").run(id, query, `${SAVED} - https://seller.example`)
  db.prepare("INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, 'Synthetic Buyer', 'Pat', 'pat@buyer.example', 'Hiring', 'https://news.example/a', 'Synthetic Buyer is hiring.', 80)").run(`lead-${id}`, id)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES (?, 'u1', ?, 'pat@buyer.example', 'Hello', 'A synthetic draft body.', 'draft')").run(`m-${id}`, `lead-${id}`)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)
}
db.prepare('UPDATE scan_jobs SET created_at = created_at + 1000 WHERE id = ?').run(LIVE_LONDON)
const before = JSON.stringify([db.prepare('SELECT id, offer, seller, query FROM scan_jobs ORDER BY id').all(), db.prepare('SELECT sells FROM users').all()]); db.close()
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }
const b = await chromium.launch()
try {
  for (const w of [1280, 390]) {
    const ctx = await b.newContext({ viewport: { width: w, height: 900 } })
    await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
    const page = await ctx.newPage(); await page.route(u => u.origin !== base, r => r.abort())
    const check = async (url, wrap, name) => {
      await page.goto(base + url, { waitUntil: 'networkidle' })
      const card = page.getByTestId(wrap); await card.waitFor({ timeout: 15000 })
      await card.scrollIntoViewIfNeeded()
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name}@${w}: horizontal scroll`)
      if (process.env.SHOTS) { const box = await card.boundingBox(); const y = Math.max(0, box.y - 60); await page.screenshot({ path: path.join(process.env.SHOTS, `${name}-${w}.png`), clip: { x: 0, y, width: w, height: Math.min(Math.max(220, box.height + 120), 900 - y) } }) }
      return { conflict: await card.getByTestId('play-offer-conflict').count(), offer: await card.getByTestId('play-offer-text').count() ? (await card.getByTestId('play-offer-text').innerText()).trim() : null, text: (await card.innerText()).replace(/\s+/g, ' ') }
    }
    for (const [url, wrap, name] of [[`/app/campaigns/${DENTAL}`, 'campaign-offer', 'campaign-dental'], [`/app/outreach?job_id=${DENTAL}`, 'outreach-play-offer', 'outreach-dental'],
      [`/app/campaigns/${LIVE_DENTAL}`, 'campaign-offer', 'campaign-live-dental'], [`/app/outreach?job_id=${LIVE_DENTAL}`, 'outreach-play-offer', 'outreach-live-dental']]) {
      const r = await check(url, wrap, name)
      assert.equal(r.conflict, 0, `${name}@${w}: no choice for the same product: ${r.text}`)
      assert.equal(r.offer, SAVED, `${name}@${w}: shows the saved offer as written`)
    }
    for (const [url, wrap, name] of [[`/app/campaigns/${LONDON}`, 'campaign-offer', 'campaign-london'], [`/app/outreach?job_id=${LONDON}`, 'outreach-play-offer', 'outreach-london'],
      [`/app/campaigns/${LIVE_LONDON}`, 'campaign-offer', 'campaign-live-london'], [`/app/outreach?job_id=${LIVE_LONDON}`, 'outreach-play-offer', 'outreach-live-london']]) {
      const r = await check(url, wrap, name)
      assert.equal(r.conflict, 1, `${name}@${w}: the CRM request is still a choice`)
      assert.match(r.text, /CRM setup and outbound sales consulting/); assert.match(r.text, /appointment booking and reminder software/)
    }
    // the same product sold to an explicitly different buyer is a choice too, never the dental offer
    for (const [url, wrap, name] of [[`/app/campaigns/${VET}`, 'campaign-offer', 'campaign-vet'], [`/app/outreach?job_id=${VET}`, 'outreach-play-offer', 'outreach-vet']]) {
      const r = await check(url, wrap, name)
      assert.equal(r.conflict, 1, `${name}@${w}: another buyer is a choice: ${r.text}`)
    }
    await ctx.close()
  }
  const after = new Database(DB); const now = JSON.stringify([after.prepare('SELECT id, offer, seller, query FROM scan_jobs ORDER BY id').all(), after.prepare('SELECT sells FROM users').all()]); after.close()
  assert.equal(now, before, 'viewing chose no offer and rewrote nothing')
  // The original audit acceptance continues after an explicit choice. Never touch production records here.
  const CRM = 'CRM setup and outbound sales consulting'
  const beforeChoice = new Database(DB, { readonly: true })
  const dentalBefore = beforeChoice.prepare('SELECT * FROM scan_jobs WHERE id = ?').get(LIVE_DENTAL)
  const londonBefore = beforeChoice.prepare('SELECT query, seller FROM scan_jobs WHERE id = ?').get(LIVE_LONDON)
  const profileBefore = beforeChoice.prepare("SELECT sells, website FROM users WHERE id = 'u1'").get()
  assert.equal(beforeChoice.prepare("SELECT count(*) n FROM tenant_memory WHERE tenant_id = 'u1'").get().n, 0)
  beforeChoice.close()
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const p = await ctx.newPage(); await p.route(u => u.origin !== base, r => r.abort())
  await p.goto(base + `/app/campaigns/${LIVE_LONDON}`, { waitUntil: 'networkidle' })
  await p.getByTestId('play-offer-use-stated').click()
  await p.getByTestId('play-offer-text').filter({ hasText: CRM }).waitFor()
  const d = new Database(DB)
  assert.deepEqual(d.prepare('SELECT * FROM scan_jobs WHERE id = ?').get(LIVE_DENTAL), dentalBefore)
  assert.deepEqual(d.prepare('SELECT query, seller FROM scan_jobs WHERE id = ?').get(LIVE_LONDON), londonBefore)
  assert.deepEqual(d.prepare("SELECT sells, website FROM users WHERE id = 'u1'").get(), profileBefore)
  assert.equal(d.prepare('SELECT offer FROM scan_jobs WHERE id = ?').get(LIVE_LONDON).offer, CRM)
  assert.equal(dentalBefore.offer,null);assert.equal(dentalBefore.seller,SAVED)
  assert.equal(d.prepare("SELECT sells FROM users WHERE id='u1'").get().sells,SAVED)
  // New synthetic dated/source-confirmed lead only. No claim about either live play's existing research-only leads.
  d.prepare('DELETE FROM outreach_messages WHERE lead_id = ?').run(`lead-${LIVE_LONDON}`)
  d.prepare('UPDATE leads SET human_confirmed_at = ?, human_confirmed_from = ?, event_date = ? WHERE id = ?').run(Math.floor(Date.now()/1000),'synthetic_source_review',new Date(Date.now()-3*86400000).toISOString().slice(0,10),`lead-${LIVE_LONDON}`)
  d.prepare('UPDATE leads SET id = ? WHERE id = ?').run('a'.repeat(24),`lead-${LIVE_LONDON}`)
  d.prepare("INSERT INTO lead_enrichments (id,lead_id,tenant_id,connector,kind,value,label,source_url,source_date,retrieved_at) VALUES (? ,?,'u1','scan:gate','gate_passed','sales_hiring','Synthetic test precondition','https://news.example/a',?,?)").run('b'.repeat(24),'a'.repeat(24),new Date().toISOString().slice(0,10),Math.floor(Date.now()/1000))
  d.close()
  const made = await p.evaluate(async id => {const r=await fetch('/api/outreach',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lead_id:id})});return {status:r.status,body:await r.json()}},'a'.repeat(24))
  assert.ok(made.status===200||made.status===201,JSON.stringify(made))
  for (const width of [1280,390]) {
    await p.setViewportSize({width,height:900})
    for (let reload=0;reload<2;reload++) {
      for(const [url,wrap,name,want] of [[`/app/campaigns/${LIVE_LONDON}`,'campaign-offer','exact-chosen-campaign',CRM],[`/app/outreach?job_id=${LIVE_LONDON}`,'outreach-play-offer','exact-chosen-drafts',CRM],['/app','journey-play-offer','exact-chosen-home',CRM],[`/app/campaigns/${LIVE_DENTAL}`,'campaign-offer','exact-preserved-dental',SAVED]]) {
        await p.goto(base+url,{waitUntil:'networkidle'}); const card=p.getByTestId(wrap);await card.waitFor();await card.scrollIntoViewIfNeeded()
        assert.equal(await card.getByTestId('play-offer-conflict').count(),0)
        assert.equal((await card.getByTestId('play-offer-text').innerText()).trim(),want)
        assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth))
        if(!reload&&process.env.SHOTS) await p.screenshot({path:path.join(process.env.SHOTS,`${name}-${width}.png`),fullPage:false})
        if (name === 'exact-chosen-drafts') {
          const preview = p.locator('pre').first()
          const body = await preview.innerText()
          assert.match(body, /CRM setup and outbound sales consulting/)
          assert.doesNotMatch(body, /appointment booking/)
          if (!reload && process.env.SHOTS) {
            await preview.scrollIntoViewIfNeeded()
            await p.screenshot({ path: path.join(process.env.SHOTS, `exact-template-preview-${width}.png`), fullPage: false })
          }
        }
      }
    }
  }
  const final = new Database(DB, { readonly: true })
  assert.deepEqual(final.prepare('SELECT * FROM scan_jobs WHERE id = ?').get(LIVE_DENTAL), dentalBefore)
  assert.deepEqual(final.prepare('SELECT query, seller FROM scan_jobs WHERE id = ?').get(LIVE_LONDON), londonBefore)
  assert.deepEqual(final.prepare("SELECT sells, website FROM users WHERE id = 'u1'").get(), profileBefore)
  final.close()
  await ctx.close()
  console.log('EXACT ORIGINAL349 records: explicit London choice, Home/campaign/draft preview agree at1280/390+reload; dental snapshot and profile unchanged. Synthetic DB only, no provider/scan/send.')

  console.log('same-offer UI check passed at 1280 and 390: read-only views preserve every offer; an explicit London-only choice is consistent across Home, Campaign and a synthetic template draft after reload; dental/profile remain unchanged')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
