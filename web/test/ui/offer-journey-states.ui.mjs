// The offer journey's UI states as a user meets them (#349, UX side of #456). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/offer-journey-states.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Complements test/ui/offer-journey.ui.mjs (routes, admission, cross-tenant, profile edit) with what that harness could
// not render: every step at 1280 AND 390, the conflict blocks as the buttons a user clicks show them, and Home asking
// for a choice. After every step the page is checked against the database it was read from.
// Real production build, a throwaway synthetic database, the REAL routes and pages. Only the paid boundary is stubbed:
// the browser's /api/scan/icp answer (it calls a model). The server runs under test/helpers/net-fence.ts (any
// non-loopback request throws; inherited secrets scrubbed) and the browser aborts off-host requests, so no provider,
// Gmail or search call can happen. A throwaway master key (test/smoke/stripe-test-env.mjs) lets the server read the
// tenant's synthetic AI key, so the rewrite reaches its offer check; the fence still stops any call it could make.
//   A. Home, current play contested: Home asks which offer the play is for (both choices named, nothing pre-picked);
//      viewing writes nothing; "Keep" stores the recorded offer on that play only and Home then shows it. At 390 Home
//      shows its current play (the newest, created in B) with that play's stored offer.
//   B. Ambiguous request on Find leads: the review asks for a choice and Run stays disabled; choosing the request's
//      offer and confirming creates the play with that offer only (at 1280 and at 390, one play per width).
//   C. Conflict blocks drafting: on a contested play, Approve (the Draft email action) on Leads shows the refusal and writes no draft;
//      "Rewrite with AI" on its Outreach page shows the refusal and leaves the draft as it was; the Outreach page shows
//      the same choice as the campaign page.
//   D. Choosing on the Outreach page unblocks that play only; Approve then makes a draft stating the chosen offer.
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
const { saveKey } = await import(path.join(dir, 'lib/llm/key-store.ts'))

const DENTAL_SELLER = 'We sell appointment booking and reminder software to independent dental practices in New York City.'
const SEO = 'SEO audits', PAYROLL = 'payroll software'
const HOME_PLAY = 'e'.repeat(24), DRAFT_PLAY = 'c'.repeat(24)
const MASTER = randomBytes(32)
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-offerstates-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
migrateAllSqlite(db)
const t0 = Math.floor(Date.now() / 1000)
const tokenA = randomBytes(32).toString('hex')
db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(tokenA).digest('hex'), 'u1', t0 + 3600)
db.prepare("INSERT INTO users (id, email, password_hash, salt, business_name, sells, website) VALUES ('u1', 'owner@seller.test', 'x', 'y', 'Synthetic Co', ?, 'https://seller.example')").run(DENTAL_SELLER)
db.prepare("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES ('u1', 'Synthetic Co', 'personal', 'u1', ?)").run(t0)
db.prepare("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES ('u1', 'u1', 'owner', ?)").run(t0)
// a synthetic AI key, encrypted with this run's throwaway master key; the fence blocks any call made with it
saveKey(db, 'u1', 'anthropic', 'sk-ant-api03-SYNTHETICSYNTHETICSYNTHETICSYNTHETIC', MASTER)
// Two plays created under the dental profile whose own requests name another offer: contested until chosen. The Home
// play is the newest, so Home shows it.
const play = (id, query, at) => {
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller, created_at) VALUES (?, 'u1', 'Synthetic Co', 'i', 'l', 'running', ?, ?, ?)").run(id, query, `${DENTAL_SELLER} - https://seller.example`, at)
  const leads = []
  for (const [n, who, co] of [['aaaa', 'pat', 'Brightpath Agency'], ['bbbb', 'sam', 'Northlake Studio']]) {
    const lead = `${id.slice(0, 20)}${n}`
    db.prepare("INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, evidence_excerpt, event_date, date_status, confidence, score, human_confirmed_at, human_confirmed_from) VALUES (?, ?, ?, ?, ?, 'Hiring a marketing lead', 'https://news.example/a', ?, '2026-10-20', 'verified', 90, 80, 1, 'test_review')").run(lead, id, co, who, `${who}@${co.split(' ')[0].toLowerCase()}.example`, `${co} is hiring a marketing lead.`)
    leads.push(lead)
  }
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)
  return leads
}
const [draftLead, draftLead2] = play(DRAFT_PLAY, `Find Berlin agencies hiring. We sell ${SEO}.`, t0 - 7200)
play(HOME_PLAY, `Find Leeds restaurants hiring. We sell ${PAYROLL}.`, t0 - 3600)
const DRAFT_ID = 'f'.repeat(24)
db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES (?, 'u1', ?, 'pat@brightpath.example', 'Hello', 'A synthetic draft body written before the offer was chosen.', 'draft')").run(DRAFT_ID, draftLead)
db.close()

// The state every page is checked against.
const read = () => { const d = new Database(DB, { readonly: true }); try { return {
  jobs: d.prepare('SELECT id, query, offer FROM scan_jobs ORDER BY created_at, rowid').all(),
  sells: d.prepare("SELECT sells FROM users WHERE id = 'u1'").get().sells,
  drafts: d.prepare('SELECT id, lead_id, body, status FROM outreach_messages ORDER BY created_at, rowid').all(),
} } finally { d.close() } }
const offerOf = id => read().jobs.find(j => j.id === id).offer
const s0 = read()

const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', SMOKE_MASTER_B64: MASTER.toString('base64'), NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')} --import ${path.join(dir, 'test/smoke/stripe-test-env.mjs')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }
const b = await chromium.launch()
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: false }) }
const icpFor = where => ({ summary: `${where} SaaS startups hiring their first sales rep`, who: ['Founders of SaaS startups'], industries: ['SaaS'], sizes: ['1-50 employees'], where: [where], signals: ['Hiring a first sales rep'], exclude: [] })
async function context(width, where = 'London') {
  const ctx = await b.newContext({ viewport: { width, height: 900 } })
  await ctx.addCookies([{ name: 'dazl_session', value: tokenA, url: base }])
  const page = await ctx.newPage(); await page.route(u => u.origin !== base, r => r.abort())
  // the one paid boundary: inferring the profile calls a model, so its answer is synthetic
  await page.route('**/api/scan/icp', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ icp: icpFor(where), inferred: true }) }))
  return { ctx, page }
}
const noScroll = async (page, what) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${what}: horizontal scroll`)
const waitFor = async (cond, what) => { for (let i = 0; i < 75; i++) { if (cond()) return; await new Promise(r => setTimeout(r, 200)) } assert.fail(`timed out: ${what}`) }

try {
  for (const w of [1280, 390]) {
    const tag = `-${w}`
    // A. Home asks which offer its current play is for; viewing writes nothing; the choice is stored on that play only
    { const { ctx, page } = await context(w)
      const before = read()
      if (w === 1280) assert.equal(offerOf(HOME_PLAY), null, 'fixture: the Home play has no confirmed offer')
      await page.goto(base + '/app', { waitUntil: 'networkidle' })
      const card = page.getByTestId('journey-play-offer'); await card.waitFor({ timeout: 15000 }); await card.scrollIntoViewIfNeeded()
      if (w === 1280) {
        const ask = card.getByTestId('play-offer-conflict'); await ask.waitFor()
        assert.match(await ask.innerText(), new RegExp(PAYROLL)); assert.match(await ask.innerText(), /appointment booking and reminder software/)
        assert.equal(await card.getByTestId('play-offer-text').count(), 0, 'no offer is shown as if chosen')
        assert.doesNotMatch(await ask.innerText(), /\.\./, 'a quoted offer does not double its period')
        await noScroll(page, `home${tag}`); await shot(page, `states-A-home-asks${tag}`)
        assert.deepEqual(read(), before, 'viewing Home wrote nothing')
        await card.getByTestId('play-offer-use-recorded').click()
        await card.getByTestId('play-offer-text').waitFor({ timeout: 15000 })
        const after = read()
        assert.equal(offerOf(HOME_PLAY), DENTAL_SELLER, 'Keep stores the recorded offer on the Home play')
        assert.deepEqual(after.jobs.filter(j => j.id !== HOME_PLAY), before.jobs.filter(j => j.id !== HOME_PLAY), 'no other play changed')
        assert.equal(after.sells, DENTAL_SELLER)
      }
      // after the choice (and at 390, where the newest play is the one B created at 1280): Home shows its current, newest
      // play's stored offer, no choice, and agrees with the database
      await page.goto(base + '/app', { waitUntil: 'networkidle' })
      await card.getByTestId('play-offer-text').waitFor({ timeout: 15000 }); await card.scrollIntoViewIfNeeded()
      const newest = read().jobs.at(-1)
      if (w === 1280) assert.equal(newest.id, HOME_PLAY)
      assert.ok(newest.offer, `home${tag}: the current play has a confirmed offer`)
      assert.equal((await card.getByTestId('play-offer-text').innerText()).trim(), newest.offer, `home${tag} shows the current play's stored offer`)
      assert.equal(await card.getByTestId('play-offer-conflict').count(), 0)
      await noScroll(page, `home chosen${tag}`); await shot(page, `states-A-home-chosen${tag}`)
      await ctx.close() }

    // B. an ambiguous request: review asks for a choice, Run waits for it; the chosen offer is stored on the new play only
    { const where = w === 1280 ? 'London' : 'Manchester'
      const query = `Find ${where} SaaS startups hiring their first sales rep. We sell CRM setup and outbound consulting.`
      const { ctx, page } = await context(w, where)
      await page.goto(base + '/app/leads', { waitUntil: 'networkidle' })
      await page.getByPlaceholder('Find people who...').fill(query)
      await page.getByRole('button', { name: 'Review profile first' }).click()
      const chooser = page.getByTestId('offer-chooser'); await chooser.waitFor({ timeout: 15000 }); await chooser.scrollIntoViewIfNeeded()
      assert.match(await chooser.innerText(), /CRM setup and outbound consulting/); assert.match(await chooser.innerText(), /appointment booking and reminder software/)
      const run = page.getByRole('button', { name: 'Run scan with this profile' }).first()
      assert.ok(await run.isDisabled(), `B${tag}: Run waits for the choice`)
      assert.doesNotMatch(await chooser.innerText(), /\.\./, 'a quoted offer does not double its period')
      const jobsBefore = read().jobs
      await noScroll(page, `review${tag}`); await shot(page, `states-B-review-asks${tag}`)
      await page.getByTestId('offer-use-stated').click()
      assert.equal(await page.getByTestId('review-offer-input').inputValue(), 'CRM setup and outbound consulting')
      assert.deepEqual(read().jobs, jobsBefore, 'choosing on the review creates nothing by itself')
      await run.click(); await page.getByTestId('estimate-confirm-run').click({ timeout: 15000 })
      await waitFor(() => read().jobs.some(j => j.query === query), `B${tag}: play created`)
      const s = read(), made = s.jobs.find(j => j.query === query)
      assert.equal(made.offer, 'CRM setup and outbound consulting', `B${tag}: the chosen offer is stored on the new play`)
      assert.deepEqual(s.jobs.filter(j => j.id !== made.id), jobsBefore, `B${tag}: no other play changed`)
      assert.equal(s.sells, DENTAL_SELLER, `B${tag}: the saved profile is unchanged`)
      await shot(page, `states-B-created${tag}`)
      // its campaign page shows exactly the stored offer
      await page.goto(base + `/app/campaigns/${made.id}`, { waitUntil: 'networkidle' })
      const camp = page.getByTestId('campaign-offer'); await camp.getByTestId('play-offer-text').waitFor({ timeout: 15000 }); await camp.scrollIntoViewIfNeeded()
      assert.equal((await camp.getByTestId('play-offer-text').innerText()).trim(), made.offer)
      await noScroll(page, `campaign${tag}`); await shot(page, `states-B-campaign${tag}`)
      await ctx.close() }
  }

  // C. a contested play blocks drafting and the rewrite, as the buttons show it, and writes nothing (1280 and 390)
  for (const w of [1280, 390]) {
    const tag = `-${w}`
    const { ctx, page } = await context(w)
    const before = read()
    assert.equal(offerOf(DRAFT_PLAY), null, 'fixture: the drafting play is contested')
    await page.goto(base + `/app/leads?job_id=${DRAFT_PLAY}`, { waitUntil: 'networkidle' })
    // Approve on a lead card is the Draft email action (it creates a draft for review; nothing is sent)
    const btn = page.getByRole('button', { name: 'Approve', exact: true }).first(); await btn.waitFor({ timeout: 15000 }); await btn.scrollIntoViewIfNeeded()
    await btn.click()
    const refused = page.getByText(/names a different offer than the one it was created with\. Choose what this play sells/).first(); await refused.waitFor({ timeout: 15000 })
    await refused.scrollIntoViewIfNeeded(); await noScroll(page, `leads${tag}`); await shot(page, `states-C-draft-refused${tag}`)
    assert.deepEqual(read(), before, `C${tag}: the refused draft wrote nothing`)
    await page.goto(base + `/app/outreach?job_id=${DRAFT_PLAY}`, { waitUntil: 'networkidle' })
    const card = page.getByTestId('outreach-play-offer'); await card.getByTestId('play-offer-conflict').waitFor({ timeout: 15000 })
    assert.match(await card.innerText(), new RegExp(SEO)); assert.doesNotMatch(await card.innerText(), /\.\./, 'no doubled period')
    const rewrite = page.getByRole('button', { name: 'Rewrite with AI (uses your key)' }).first(); await rewrite.scrollIntoViewIfNeeded()
    await rewrite.click()
    const note = page.getByRole('status').filter({ hasText: /names a different offer/ }); await note.waitFor({ timeout: 15000 })
    assert.match(await note.innerText(), /Choose what this play sells on its campaign page first/)
    const after = read()
    assert.deepEqual(after.drafts, before.drafts, `C${tag}: the rewrite left the draft as it was`)
    assert.deepEqual(after.jobs, before.jobs, `C${tag}: nothing chosen for the play`)
    await note.scrollIntoViewIfNeeded(); await noScroll(page, `outreach${tag}`); await shot(page, `states-C-rewrite-refused${tag}`)
    await ctx.close()
  }

  // D. choosing on the Outreach page unblocks that play only; Draft email then makes a draft stating the chosen offer
  { const { ctx, page } = await context(390)
    const before = read()
    await page.goto(base + `/app/outreach?job_id=${DRAFT_PLAY}`, { waitUntil: 'networkidle' })
    const card = page.getByTestId('outreach-play-offer'); await card.getByTestId('play-offer-use-stated').click({ timeout: 15000 })
    await card.getByTestId('play-offer-text').waitFor({ timeout: 15000 })
    assert.equal(offerOf(DRAFT_PLAY), SEO, 'the choice is stored on this play')
    assert.deepEqual(read().jobs.filter(j => j.id !== DRAFT_PLAY), before.jobs.filter(j => j.id !== DRAFT_PLAY), 'no other play changed')
    assert.equal((await card.getByTestId('play-offer-text').innerText()).trim(), SEO)
    await shot(page, 'states-D-chosen-390')
    await page.goto(base + `/app/leads?job_id=${DRAFT_PLAY}`, { waitUntil: 'networkidle' })
    const btn = page.getByRole('button', { name: 'Approve', exact: true }).first(); await btn.waitFor({ timeout: 15000 }); await btn.scrollIntoViewIfNeeded(); await btn.click()
    await waitFor(() => read().drafts.some(m => m.lead_id === draftLead2), 'D: draft created')
    const drafted = read().drafts.find(m => m.lead_id === draftLead2)
    assert.match(drafted.body, /SEO audits/, 'the draft states the chosen offer'); assert.doesNotMatch(drafted.body, /appointment booking/)
    await shot(page, 'states-D-drafted-390')
    await ctx.close() }

  assert.equal(read().sells, s0.sells, 'the saved profile never changed')
  console.log('offer journey states passed at 1280 and 390: Home asks which offer its contested play is for and stores the choice on that play only; the review asks for a choice and Run waits, then the chosen offer is stored on the new play only; a contested play refuses Draft email and the AI rewrite on screen and writes nothing; choosing on Outreach unblocks that play and its next draft states the chosen offer; every page agreed with the database')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
