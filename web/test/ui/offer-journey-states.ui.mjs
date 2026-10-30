// The offer journey's UI states as a user meets them (#349, UX side of #456). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/offer-journey-states.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Complements test/ui/offer-journey.ui.mjs (routes, admission, cross-tenant, profile edit) with what that harness could
// not render: every step at 1280 AND at 390, the conflict blocks as the buttons a user clicks show them, and Home asking
// for a choice. After every step the page is checked against the database it was read from.
// Real production build, a throwaway synthetic database, the REAL routes and pages. Only the paid boundary is stubbed:
// the browser's /api/scan/icp answer (it calls a model). The server runs under test/helpers/net-fence.ts (any
// non-loopback request throws; inherited secrets scrubbed) and the browser aborts off-host requests, so no provider,
// Gmail or search call can happen. A throwaway master key (test/smoke/stripe-test-env.mjs) lets the server read the
// tenant's synthetic AI key, so the rewrite reaches its offer check; the fence still stops any call it could make.
// Each width has its own contested plays, so every step runs in full at both widths (each step at both widths before
// the next):
//   A. Home, current play contested: Home asks which offer the play is for (both choices named, nothing pre-picked);
//      viewing writes nothing; "Keep" stores the recorded offer on that play only and Home then shows it.
//   B. Ambiguous request on Find leads: the review asks for a choice and Run stays disabled; choosing the request's
//      offer and confirming creates the play with that offer only, and its campaign page shows exactly that offer.
//   C. Conflict blocks drafting: on a contested play, Approve (the Draft email action) on Leads shows the refusal and
//      writes nothing; Rewrite with AI on its Outreach page shows the refusal and leaves the draft as it was. A scan
//      still in progress does not take the page over from the play the link names (?job_id=), and that scan's own link
//      still shows its progress and Stop control; Leads with no run named still opens a scan in progress.
//   D. Choosing on the Outreach page unblocks that play only; Approve then makes a draft stating the chosen offer.
//   E. Failures injected at every await before a side effect (the offer read, saving the choice, drafting, the rewrite:
//      gateway errors, no network, a 200 without an offer): the page never shows a choice, draft or rewrite that did not
//      happen, the read failure is said, and nothing is written. A policy change between loading the page and drafting:
//      the draft states the offer stored at that moment.
// "Writes nothing" compares full rows of the tenant's tables, the row count of every table, and the runner's work items for
// the fixture plays; the only rows a refusal
// adds are its own audit rows (outreach_llm_usage, outcome offer_conflict), which are checked as such.
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
const SEO = 'SEO audits', PAYROLL = 'payroll software', CRM = 'CRM setup and outbound consulting'
const WIDTHS = [1280, 390]
const HOME = { 1280: 'e'.repeat(24), 390: '7'.repeat(24) }, DRAFTING = { 1280: 'c'.repeat(24), 390: '8'.repeat(24) }
const QUEUED = '9'.repeat(24)
const FAILP = { 1280: '5'.repeat(24), 390: '6'.repeat(24) }, CHOSENP = { 1280: '3'.repeat(24), 390: '4'.repeat(24) }
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
// Plays created under the dental profile whose own requests name another offer: contested until chosen.
const play = (id, query, at, cos) => {
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller, created_at) VALUES (?, 'u1', 'Synthetic Co', 'i', 'l', 'running', ?, ?, ?)").run(id, query, `${DENTAL_SELLER} - https://seller.example`, at)
  const leads = cos.map(([n, who, co]) => {
    const lead = `${id.slice(0, 20)}${n}`
    db.prepare("INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, evidence_excerpt, event_date, date_status, confidence, score, human_confirmed_at, human_confirmed_from) VALUES (?, ?, ?, ?, ?, 'Hiring a marketing lead', 'https://news.example/a', ?, '2026-10-20', 'verified', 90, 80, 1, 'test_review')").run(lead, id, co, who, `${who}@${co.split(' ')[0].toLowerCase()}.example`, `${co} is hiring a marketing lead.`)
    return lead
  })
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)
  return leads
}
const draftLeads = {}
for (const [i, w] of WIDTHS.entries()) {
  // the drafting play: one lead already has a draft (written before any choice), one has none
  const [l1, l2] = play(DRAFTING[w], `Find Berlin agencies hiring. We sell ${SEO}.`, t0 - 9000 + i, [['aaaa', 'pat', `Brightpath${w} Agency`], ['bbbb', 'sam', `Northlake${w} Studio`]])
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES (?, 'u1', ?, ?, 'Hello', 'A synthetic draft body written before the offer was chosen.', 'draft')").run(`${'f'.repeat(20)}${w === 1280 ? '1280' : '0390'}`, l1, `pat@brightpath${w}.example`)
  draftLeads[w] = l2
}
// E's plays: a contested one (with a draft written before any choice) and one whose offer is already chosen.
const failLeads = {}, chosenLeads = {}
for (const w of WIDTHS) {
  const [f1, f2] = play(FAILP[w], `Find Bristol clinics hiring. We sell ${SEO}.`, t0 - 20000, [['aaaa', 'ash', `Fernhill${w} Clinic`], ['bbbb', 'bo', `Kestrel${w} Clinic`]])
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES (?, 'u1', ?, ?, 'Hello', 'A synthetic draft body written before the offer was chosen.', 'draft')").run(`${'f'.repeat(20)}${w === 1280 ? '5280' : '6390'}`, f1, `ash@fernhill${w}.example`)
  failLeads[w] = { withDraft: f1, without: f2 }
  const [c1] = play(CHOSENP[w], `Find Bath agencies hiring. We sell ${SEO}.`, t0 - 21000, [['aaaa', 'cy', `Larkspur${w} Agency`]])
  db.prepare('UPDATE scan_jobs SET offer = ? WHERE id = ?').run(SEO, CHOSENP[w])
  chosenLeads[w] = c1
}
// The 1280 Home play is the newest at the start; the 390 one is made the newest just before its pass.
play(HOME[390], `Find Leeds restaurants hiring. We sell ${PAYROLL}.`, t0 - 8000, [['aaaa', 'kim', 'Larder Kitchen']])
play(HOME[1280], `Find Leeds restaurants hiring. We sell ${PAYROLL}.`, t0 - 3600, [['aaaa', 'lee', 'Copperpot Bistro']])
// the server's own start-up migration backfills tags on rows it finds (lib/scan/store.ts backfillKindTags); run it here
// once, so the snapshots start from the rows as the server will hold them and a later difference is a real write
migrateAllSqlite(db)
db.close()

// The state every page is checked against: full rows of the tenant's tables, and the row count of every table. The
// scan in progress and the plays B creates are left to the (fenced) runner, so their scan_jobs rows are compared by
// id/query/offer only.
const FIXED = new Set([...Object.values(HOME), ...Object.values(DRAFTING), ...Object.values(FAILP), ...Object.values(CHOSENP)])
// A scan's work item carries the scan's id as its own id (lib/queue/scan-claimer.ts, lib/scan/queue-runner.ts enqueue
// { id: job.id }, no dedupe key), so that is the column a refusal enqueuing work for a fixture play would write.
const workFor = (d, ids) => d.prepare(`SELECT * FROM work_queue WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids)
const read = () => { const d = new Database(DB, { readonly: true }); try {
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(t => t.name)
  const jobs = d.prepare('SELECT * FROM scan_jobs ORDER BY created_at, rowid').all()
  return {
    jobs: jobs.map(j => FIXED.has(j.id) ? j : { id: j.id, query: j.query, offer: j.offer }),
    leads: d.prepare('SELECT * FROM leads ORDER BY id').all(),
    users: d.prepare('SELECT * FROM users ORDER BY id').all(),
    drafts: d.prepare('SELECT * FROM outreach_messages ORDER BY created_at, rowid').all(),
    counts: Object.fromEntries(tables.filter(t => !['rate_limits', 'app_leases', 'scan_jobs', 'work_queue', 'scan_source_stats', 'outreach_llm_usage'].includes(t)).map(t => [t, d.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n])),
    // the runner's own tables, for the fixture plays only (the plays B creates and the scan in progress are the runner's)
    fixtureWork: workFor(d, [...FIXED]),
    fixtureStats: d.prepare(`SELECT count(*) AS n FROM scan_source_stats WHERE job_id IN (${[...FIXED].map(() => '?').join(',')})`).get(...FIXED).n,
    refusals: d.prepare("SELECT message_id, purpose, outcome FROM outreach_llm_usage ORDER BY rowid").all(),
  } } finally { d.close() } }
const offerOf = id => read().jobs.find(j => j.id === id).offer
const sameExcept = (a, b, what) => { for (const k of Object.keys(a)) assert.deepEqual(a[k], b[k], `${what}: ${k} unchanged`) }
// The query can match: a work item written the way a scan enqueue writes it is found, then removed again.
{ const d = new Database(DB); const now = Math.floor(Date.now() / 1000)
  d.prepare("INSERT INTO work_queue (id, tenant_id, kind, status, attempts, max_attempts, not_before, created_at) VALUES (?, 'u1', 'scan', 'pending', 0, 3, ?, ?)").run(HOME[1280], now, now)
  assert.equal(workFor(d, [...FIXED]).length, 1, 'fixture: the work-item check finds a scan work item for a fixture play')
  d.prepare('DELETE FROM work_queue WHERE id = ?').run(HOME[1280]); d.close() }
const s0 = read()

const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', SMOKE_MASTER_B64: MASTER.toString('base64'), NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')} --import ${path.join(dir, 'test/smoke/stripe-test-env.mjs')}` }, stdio: 'ignore' })
let up = false
for (let i = 0; i < 150 && !up; i++) { try { await fetch(base + '/sign-in'); up = true } catch { await new Promise(r => setTimeout(r, 200)) } }
if (!up) { srv.kill(); rmSync(tmp, { recursive: true, force: true }); throw new Error('the production server did not start') }
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
  // Each step runs at both widths before the next: Home features an active scan when there is one, so A runs before B
  // and C queue any.
  for (const w of WIDTHS) {
    const tag = `-${w}`
    // A. Home asks which offer its current play is for; viewing writes nothing; the choice is stored on that play only
    { if (w === 390) { const d = new Database(DB); d.prepare('UPDATE scan_jobs SET created_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) + 60, HOME[390]); d.close() } // this pass's Home play is the newest
      const { ctx, page } = await context(w)
      assert.equal(offerOf(HOME[w]), null, `A${tag}: fixture: the Home play has no confirmed offer`)
      const before = read()
      await page.goto(base + '/app', { waitUntil: 'networkidle' })
      const card = page.getByTestId('journey-play-offer'); await card.waitFor({ timeout: 15000 })
      const ask = card.getByTestId('play-offer-conflict'); await ask.waitFor({ timeout: 15000 }); await ask.scrollIntoViewIfNeeded()
      assert.match(await ask.innerText(), new RegExp(PAYROLL)); assert.match(await ask.innerText(), /appointment booking and reminder software/)
      assert.doesNotMatch(await ask.innerText(), /\.\./, 'a quoted offer does not double its period')
      assert.equal(await card.getByTestId('play-offer-text').count(), 0, 'no offer is shown as if chosen')
      await noScroll(page, `home${tag}`); await shot(page, `states-A-home-asks${tag}`)
      sameExcept(before, read(), `A${tag}: viewing Home`)
      await card.getByTestId('play-offer-use-recorded').click()
      await card.getByTestId('play-offer-text').waitFor({ timeout: 15000 })
      await waitFor(() => offerOf(HOME[w]) !== null, `A${tag}: choice stored`)
      const after = read()
      assert.equal(offerOf(HOME[w]), DENTAL_SELLER, `A${tag}: Keep stores the recorded offer on this play`)
      assert.deepEqual(after.jobs.filter(j => j.id !== HOME[w]), before.jobs.filter(j => j.id !== HOME[w]), `A${tag}: no other play changed`)
      sameExcept({ leads: before.leads, users: before.users, drafts: before.drafts, counts: before.counts }, after, `A${tag}: the choice`)
      await page.goto(base + '/app', { waitUntil: 'networkidle' })
      await card.getByTestId('play-offer-text').waitFor({ timeout: 15000 }); await card.scrollIntoViewIfNeeded()
      assert.equal((await card.getByTestId('play-offer-text').innerText()).trim(), DENTAL_SELLER, `A${tag}: Home shows the stored offer`)
      assert.equal(await card.getByTestId('play-offer-conflict').count(), 0)
      await noScroll(page, `home chosen${tag}`); await shot(page, `states-A-home-chosen${tag}`)
      await ctx.close() }
  }
  for (const w of WIDTHS) {
    const tag = `-${w}`

    // B. an ambiguous request: review asks for a choice, Run waits for it; the chosen offer is stored on the new play only
    { const where = w === 1280 ? 'London' : 'Manchester'
      const query = `Find ${where} SaaS startups hiring their first sales rep. We sell ${CRM}.`
      const { ctx, page } = await context(w, where)
      await page.goto(base + '/app/leads', { waitUntil: 'networkidle' })
      await page.getByPlaceholder('Find people who...').fill(query)
      await page.getByRole('button', { name: 'Review profile first' }).click()
      const chooser = page.getByTestId('offer-chooser'); await chooser.waitFor({ timeout: 15000 }); await chooser.scrollIntoViewIfNeeded()
      assert.match(await chooser.innerText(), new RegExp(CRM)); assert.match(await chooser.innerText(), /appointment booking and reminder software/)
      assert.doesNotMatch(await chooser.innerText(), /\.\./, 'a quoted offer does not double its period')
      const run = page.getByRole('button', { name: 'Run scan with this profile' }).first()
      assert.ok(await run.isDisabled(), `B${tag}: Run waits for the choice`)
      const before = read()
      await noScroll(page, `review${tag}`); await shot(page, `states-B-review-asks${tag}`)
      await page.getByTestId('offer-use-stated').click()
      assert.equal(await page.getByTestId('review-offer-input').inputValue(), CRM)
      sameExcept(before, read(), `B${tag}: choosing on the review creates nothing by itself`)
      await run.click(); await page.getByTestId('estimate-confirm-run').click({ timeout: 15000 })
      await waitFor(() => read().jobs.some(j => j.query === query && j.offer !== null), `B${tag}: play created with its offer`)
      const s = read(), made = s.jobs.find(j => j.query === query)
      assert.equal(made.offer, CRM, `B${tag}: the chosen offer is stored on the new play`)
      assert.deepEqual(s.jobs.filter(j => j.id !== made.id), before.jobs, `B${tag}: no other play changed`)
      assert.deepEqual(s.users, before.users, `B${tag}: the saved profile is unchanged`)
      await shot(page, `states-B-created${tag}`)
      await page.goto(base + `/app/campaigns/${made.id}`, { waitUntil: 'networkidle' })
      const camp = page.getByTestId('campaign-offer'); await camp.getByTestId('play-offer-text').waitFor({ timeout: 15000 }); await camp.scrollIntoViewIfNeeded()
      assert.equal((await camp.getByTestId('play-offer-text').innerText()).trim(), made.offer)
      await noScroll(page, `campaign${tag}`); await shot(page, `states-B-campaign${tag}`)
      await ctx.close() }
  }
  for (const w of WIDTHS) {
    const tag = `-${w}`

    // C. a contested play blocks drafting and the rewrite, as the buttons show it, and writes nothing
    { const P = DRAFTING[w]
      // a scan still in progress next to the play the link names: running, claimed just now by another worker, so the
      // (fenced) runner leaves it alone for its 20-minute stale window (lib/scan/store.ts STALE_RUNNING_S)
      { const d = new Database(DB); d.prepare("INSERT OR IGNORE INTO scan_jobs (id, user_id, business_name, industry, location, status, query, attempts, claimed_at) VALUES (?, 'u1', 'Synthetic Co', 'i', 'l', 'running', 'A synthetic scan in progress', 1, ?)").run(QUEUED, Math.floor(Date.now() / 1000)); d.close() }
      const queuedActive = () => { const d = new Database(DB, { readonly: true }); try { return d.prepare('SELECT status FROM scan_jobs WHERE id = ?').get(QUEUED).status === 'running' } finally { d.close() } }
      assert.ok(queuedActive(), `C${tag}: a scan is in progress while the link names another play`)
      const { ctx, page } = await context(w)
      assert.equal(offerOf(P), null, `C${tag}: fixture: the drafting play is contested`)
      const before = read()
      await page.goto(base + `/app/leads?job_id=${P}`, { waitUntil: 'networkidle' })
      // Approve on a lead card is the Draft email action (it creates a draft for review; nothing is sent)
      const btn = page.getByRole('button', { name: 'Approve', exact: true }).first(); await btn.waitFor({ timeout: 15000 })
      assert.equal(new URL(page.url()).searchParams.get('job_id'), P, `C${tag}: the page stays on the play the link names`)
      assert.match(await page.locator('body').innerText(), new RegExp(`Northlake${w} Studio`), `C${tag}: it shows that play's leads`)
      assert.ok(queuedActive(), `C${tag}: the other scan was still in progress while the named play was shown`)
      await btn.scrollIntoViewIfNeeded(); await btn.click()
      const refused = page.getByText(/names a different offer than the one it was created with\. Choose what this play sells/).first(); await refused.waitFor({ timeout: 15000 })
      await refused.scrollIntoViewIfNeeded(); await noScroll(page, `leads${tag}`); await shot(page, `states-C-draft-refused${tag}`)
      sameExcept(before, read(), `C${tag}: the refused draft`)
      await page.goto(base + `/app/outreach?job_id=${P}`, { waitUntil: 'networkidle' })
      const card = page.getByTestId('outreach-play-offer'); await card.getByTestId('play-offer-conflict').waitFor({ timeout: 15000 })
      assert.match(await card.innerText(), new RegExp(SEO)); assert.doesNotMatch(await card.innerText(), /\.\./, 'no doubled period')
      const rewrite = page.getByRole('button', { name: 'Rewrite with AI (uses your key)' }).first(); await rewrite.scrollIntoViewIfNeeded()
      await rewrite.click()
      const note = page.getByRole('status').filter({ hasText: /names a different offer/ }); await note.waitFor({ timeout: 15000 })
      assert.match(await note.innerText(), /Choose what this play sells on its campaign page first/)
      const after = read()
      const { refusals: r0, ...b0 } = before, { refusals: r1, ...a1 } = after
      sameExcept(b0, a1, `C${tag}: the refused rewrite`)
      assert.deepEqual(r1.slice(r0.length), [{ message_id: after.drafts.find(m => m.lead_id !== draftLeads[w] && m.lead_id.startsWith(P.slice(0, 20))).id, purpose: 'polish', outcome: 'offer_conflict' }], `C${tag}: the only row added is the refusal's own audit row`)
      await note.scrollIntoViewIfNeeded(); await noScroll(page, `outreach${tag}`); await shot(page, `states-C-rewrite-refused${tag}`)
      // the in-progress scan's own link still shows its progress and Stop control
      await page.goto(base + `/app/leads?job_id=${QUEUED}`, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: 'Stop this scan' }).waitFor({ timeout: 15000 })
      assert.equal(new URL(page.url()).searchParams.get('job_id'), QUEUED); assert.ok(queuedActive())
      await shot(page, `states-C-own-scan-progress${tag}`)
      // and Leads with no run named still opens a scan in progress (the autoselect the fix keeps for that case)
      await page.goto(base + '/app/leads', { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: 'Stop this scan' }).waitFor({ timeout: 15000 })
      assert.ok(/^[a-f0-9]{24}$/.test(new URL(page.url()).searchParams.get('job_id') ?? ''), `C${tag}: Leads opened a scan in progress`)
      await ctx.close() }
  }
  for (const w of WIDTHS) {
    const tag = `-${w}`

    // D. choosing on the Outreach page unblocks that play only; Approve then makes a draft stating the chosen offer
    { const P = DRAFTING[w]
      const { ctx, page } = await context(w)
      const before = read()
      await page.goto(base + `/app/outreach?job_id=${P}`, { waitUntil: 'networkidle' })
      const card = page.getByTestId('outreach-play-offer'); await card.getByTestId('play-offer-use-stated').click({ timeout: 15000 })
      await card.getByTestId('play-offer-text').waitFor({ timeout: 15000 })
      await waitFor(() => offerOf(P) !== null, `D${tag}: choice stored`)
      assert.equal(offerOf(P), SEO, `D${tag}: the choice is stored on this play`)
      assert.deepEqual(read().jobs.filter(j => j.id !== P), before.jobs.filter(j => j.id !== P), `D${tag}: no other play changed`)
      assert.equal((await card.getByTestId('play-offer-text').innerText()).trim(), SEO)
      await card.scrollIntoViewIfNeeded(); await noScroll(page, `outreach chosen${tag}`); await shot(page, `states-D-chosen${tag}`)
      await page.goto(base + `/app/leads?job_id=${P}`, { waitUntil: 'networkidle' })
      const btn = page.getByRole('button', { name: 'Approve', exact: true }).first(); await btn.waitFor({ timeout: 15000 }); await btn.scrollIntoViewIfNeeded(); await btn.click()
      await waitFor(() => read().drafts.some(m => m.lead_id === draftLeads[w]), `D${tag}: draft created`)
      const drafted = read().drafts.find(m => m.lead_id === draftLeads[w])
      assert.match(drafted.body, /SEO audits/, `D${tag}: the draft states the chosen offer`); assert.doesNotMatch(drafted.body, /appointment booking/)
      await noScroll(page, `leads drafted${tag}`); await shot(page, `states-D-drafted${tag}`)
      await ctx.close() }
  }

  // E. Failures injected at every await before a side effect, through the real pages: the page never shows a choice,
  //    a draft or a rewrite that did not happen, and the database is unchanged. Then a policy change between loading
  //    the page and drafting: the draft states what is stored now, not what the page showed.
  const fail = (page, url, method, how) => page.route(url, r => r.request().method() !== method ? r.fallback() : how === 'abort' ? r.abort() : how === '5xx' ? r.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>' }) : r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  for (const w of WIDTHS) {
    const tag = `-${w}`, P = FAILP[w]
    // E1. the offer read fails: Outreach and Home say it could not be loaded; no choice and no offer is shown as known
    for (const how of ['5xx', 'abort']) {
      const { ctx, page } = await context(w); const before = read()
      await fail(page, '**/api/campaigns/*', 'GET', how)
      await page.goto(base + `/app/outreach?job_id=${P}`, { waitUntil: 'networkidle' })
      const card = page.getByTestId('outreach-play-offer'); await card.getByTestId('play-offer-unreadable').waitFor({ timeout: 15000 })
      assert.equal(await card.getByTestId('play-offer-text').count() + await card.getByTestId('play-offer-conflict').count(), 0, `E1${tag} ${how}: nothing shown as known`)
      if (how === '5xx') { await card.scrollIntoViewIfNeeded(); await noScroll(page, `E1${tag}`); await shot(page, `states-E1-offer-unreadable${tag}`) }
      await page.goto(base + '/app', { waitUntil: 'networkidle' })
      const home = page.getByTestId('journey-play-offer')
      if (await home.count()) assert.equal(await home.getByTestId('play-offer-unreadable').count(), 1, `E1${tag} ${how}: Home says it could not be loaded`)
      sameExcept(before, read(), `E1${tag} ${how}`)
      await ctx.close()
    }
    // E2. saving the choice fails (gateway error, no network, a 200 that carries no offer): still asks, nothing stored
    for (const how of ['5xx', 'abort', 'malformed']) {
      const { ctx, page } = await context(w); const before = read()
      await page.goto(base + `/app/outreach?job_id=${P}`, { waitUntil: 'networkidle' })
      const card = page.getByTestId('outreach-play-offer'); await card.getByTestId('play-offer-conflict').waitFor({ timeout: 15000 })
      await fail(page, `**/api/campaigns/${P}`, 'POST', how)
      await card.getByTestId('play-offer-use-stated').click()
      await card.getByText(/Could not save/).waitFor({ timeout: 15000 })
      assert.equal(await card.getByTestId('play-offer-conflict').count(), 1, `E2${tag} ${how}: still asks`)
      assert.equal(await card.getByTestId('play-offer-text').count(), 0, `E2${tag} ${how}: no offer shown as chosen`)
      sameExcept(before, read(), `E2${tag} ${how}`)
      if (how === '5xx') { await card.scrollIntoViewIfNeeded(); await shot(page, `states-E2-choice-not-saved${tag}`) }
      await ctx.close()
    }
    // E3. drafting fails (gateway error, no network): Leads says so, never "Draft created", and no draft exists
    for (const how of ['5xx', 'abort']) {
      const { ctx, page } = await context(w); const before = read()
      await page.goto(base + `/app/leads?job_id=${P}`, { waitUntil: 'networkidle' })
      const btn = page.getByRole('button', { name: 'Approve', exact: true }).first(); await btn.waitFor({ timeout: 15000 })
      await fail(page, '**/api/outreach', 'POST', how)
      await btn.scrollIntoViewIfNeeded(); await btn.click()
      await page.getByText('Could not create the draft').first().waitFor({ timeout: 15000 })
      assert.equal(await page.getByText(/Draft created/).count(), 0, `E3${tag} ${how}: no draft claimed`)
      sameExcept(before, read(), `E3${tag} ${how}`)
      if (how === '5xx') await shot(page, `states-E3-draft-failed${tag}`)
      await ctx.close()
    }
    // E4. the rewrite fails (gateway error, no network): Outreach says the draft is unchanged, and it is
    for (const how of ['5xx', 'abort']) {
      const { ctx, page } = await context(w); const before = read()
      await page.goto(base + `/app/outreach?job_id=${P}`, { waitUntil: 'networkidle' })
      const rewrite = page.getByRole('button', { name: 'Rewrite with AI (uses your key)' }).first(); await rewrite.waitFor({ timeout: 15000 })
      await fail(page, '**/api/outreach/polish', 'POST', how)
      await rewrite.scrollIntoViewIfNeeded(); await rewrite.click()
      const note = page.getByRole('status').filter({ hasText: /The rewrite did not work - the original draft is unchanged/ }); await note.waitFor({ timeout: 15000 })
      assert.equal(await page.getByText(/^Rewritten with your/).count(), 0, `E4${tag} ${how}: no rewrite claimed`)
      sameExcept(before, read(), `E4${tag} ${how}`)
      if (how === 'abort') { await note.scrollIntoViewIfNeeded(); await shot(page, `states-E4-rewrite-failed${tag}`) }
      await ctx.close()
    }
    // E5. policy change between loading the page and drafting: another tab changes this play's offer; the draft states
    //     what is stored at the moment of drafting, never the offer the page was loaded with
    { const { ctx, page } = await context(w)
      await page.goto(base + `/app/leads?job_id=${CHOSENP[w]}`, { waitUntil: 'networkidle' })
      const btn = page.getByRole('button', { name: 'Approve', exact: true }).first(); await btn.waitFor({ timeout: 15000 })
      { const d = new Database(DB); d.prepare('UPDATE scan_jobs SET offer = ? WHERE id = ?').run('Brand audits', CHOSENP[w]); d.close() }
      await btn.scrollIntoViewIfNeeded(); await btn.click()
      await waitFor(() => read().drafts.some(m => m.lead_id === chosenLeads[w]), `E5${tag}: draft created`)
      const drafted = read().drafts.find(m => m.lead_id === chosenLeads[w])
      assert.match(drafted.body, /Brand audits/, `E5${tag}: the draft states the offer stored now`); assert.doesNotMatch(drafted.body, /SEO audits/, `E5${tag}: not the offer the page was loaded with`)
      await ctx.close() }
  }

  assert.deepEqual(read().users, s0.users, 'the saved profile never changed')
  // nothing in the journey sends: every message it made is still a draft, never claimed, sent or given a Gmail id
  { const sent = read().drafts.filter(m => m.status !== 'draft' || m.sent_at != null || m.claimed_at != null || m.gmail_id != null || m.approved_hash != null)
    assert.deepEqual(sent, [], 'no message left the draft state') }
  console.log('offer journey states passed at 1280 and at 390: Home asks which offer its contested play is for and stores the choice on that play only; the review asks for a choice and Run waits, then the chosen offer is stored on the new play only; a contested play refuses Approve and the AI rewrite on screen and writes nothing but the refusal audit row; a scan in progress does not take over a named play, and its own link still shows its progress; choosing on Outreach unblocks that play and its next draft states the chosen offer; every page agreed with the database')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
