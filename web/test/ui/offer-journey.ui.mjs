// The offer journey end to end (#349). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/offer-journey.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, a throwaway synthetic database, the REAL routes and pages. Stand-ins only at the paid/network
// boundary: the browser's /api/scan/icp answer, the model provider (test/helpers/ui-provider-stub.ts answers and records
// every provider request in-process, with a master generated for this run sealing a synthetic key) and one synthetic
// evidence page. The server runs under test/helpers/net-fence.ts, so any other non-loopback request throws and inherited
// secrets are scrubbed; the browser aborts off-host requests. The tenant's saved profile sells dental appointment software
// in New York City.
//   1. Review: a London SaaS play selling CRM setup and outbound consulting is reviewed on Find leads. The page asks
//      which offer this play is for; Run stays disabled. A direct POST /api/scan without a choice is refused
//      (409 offer_conflict) and queues nothing.
//   2. Explicit choice: the user picks the CRM offer on the page, confirms the estimate, and the play is created with
//      that offer stored on the play only (scan_jobs.offer); the saved profile and the dental play are unchanged.
//   3. Context: research scoring for that play (offerBlockFor) states the CRM offer, never the dental one. The server
//      runs no scans (SCAN_MAX_CONCURRENT=0); this process claims the pending play and runs the real runner forward to
//      done, and every research/scoring prompt states CRM and none the dental offer. The lead's source is reviewed through
//      the real route (the currentness gate refuses before that), its template draft states CRM in the rendered preview
//      at 1280 and 390, and the real Rewrite button sends one model call stating CRM only and replaces the draft.
//   4. Views agree with the stored state at 1280 and 390, and after a reload: Home, the campaign page and the play's
//      drafts page show the CRM offer; the dental play's pages still show the dental offer. Viewing writes nothing.
//   5. Conflicts block: an older contested play refuses a draft (POST /api/outreach) and an AI rewrite (POST
//      /api/outreach/polish, and the rendered button with its message) with offer_conflict, makes no provider call and
//      writes nothing. Its explicit choice on its campaign page stores
//      that play's offer only, and a draft made after it states the chosen offer.
//   6. Another workspace can neither read the play (GET /api/campaigns/<id> 404) nor choose its offer (POST 404/403),
//      and nothing changes.
//   7. A later edit of the saved profile does not rewrite the confirmed play: it still sells CRM setup everywhere.
//   8. Mobile (390) creation for a request that only withdraws the saved offer: a direct run is refused (stated null),
//      the chooser invents nothing and Run stays disabled; the user writes this play's offer, and it is stored on the
//      new play only.
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
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
const { offerBlockFor, claimKeyedJob, runJob } = await import(path.join(dir, 'lib/scan/runner.ts'))
const { encryptSecret } = await import(path.join(dir, 'lib/secrets.ts'))

const DENTAL_SELLER = 'We sell appointment booking and reminder software to independent dental practices in New York City.'
const QUERY = 'Find London SaaS startups hiring their first sales rep. We sell CRM setup and outbound consulting.'
const CRM = 'CRM setup and outbound consulting'
const DENTAL = 'd'.repeat(24), OLD = 'c'.repeat(24)
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-offerjourney-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
migrateAllSqlite(db)
const session = user => { const t = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(t).digest('hex'), user, Math.floor(Date.now() / 1000) + 3600); return t }
db.prepare("INSERT INTO users (id, email, password_hash, salt, business_name, sells, website) VALUES ('u1', 'owner@seller.test', 'x', 'y', 'Synthetic Co', ?, 'https://seller.example')").run(DENTAL_SELLER)
db.prepare("INSERT INTO users (id, email, password_hash, salt, business_name, sells) VALUES ('u2', 'other@other.test', 'x', 'y', 'Other Co', 'Other offer')").run()
const tokenA = session('u1'), tokenB = session('u2')
// a synthetic AI key, sealed with a master generated for this run only (test/helpers/ui-provider-stub.ts hands the same
// master to the fenced server and answers every provider request in-process, recording it in PROVIDER_LOG)
const MASTER = randomBytes(32), PROVIDER_LOG = path.join(tmp, 'provider.jsonl'); writeFileSync(PROVIDER_LOG, '')
db.prepare("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES ('u1', 'anthropic', ?, 'AAAA', 0)").run(encryptSecret('sk-ant-synthetic-AAAAAAAAAAAAAAAAAAAAAAAA', 'llm-key:u1:anthropic', MASTER))
// this process acts as the scan worker for step 3, so it runs under the same fence and the same provider fake
const RESEARCH_URL = 'https://news.example/synthetic-london-saas-hiring'
Object.assign(process.env, { SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', DAZL_UI_SYNTHETIC_MASTER: MASTER.toString('base64'), DAZL_UI_PROVIDER_LOG: PROVIDER_LOG, DAZL_UI_RESEARCH_URL: RESEARCH_URL })
await import(path.join(dir, 'test/helpers/net-fence.ts')); await import(path.join(dir, 'test/helpers/ui-provider-stub.ts'))
const providerCalls = () => readFileSync(PROVIDER_LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const play = (id, query, seller) => {
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller) VALUES (?, 'u1', 'Synthetic Co', 'i', 'l', 'running', ?, ?)").run(id, query, seller)
  for (const [n, who] of [['aaaa', 'pat'], ['bbbb', 'sam']]) db.prepare("INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, evidence_excerpt, confidence, human_confirmed_at, human_confirmed_from) VALUES (?, ?, ?, ?, ?, 'Hiring', 'https://news.example/a', 'Synthetic Buyer is hiring.', 90, 1, 'test_review')").run(`${id.slice(0, 20)}${n}`, id, `Synthetic Buyer ${n}`, who, `${who}@${id.slice(0, 4)}${n}.example`)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)
  return `${id.slice(0, 20)}aaaa`
}
play(DENTAL, 'Independent dental practices in New York City hiring a front-desk coordinator. We sell appointment booking and reminder software.', `${DENTAL_SELLER} - https://seller.example`)
const oldLead = play(OLD, 'Find Berlin agencies hiring. We sell SEO audits.', `${DENTAL_SELLER} - https://seller.example`)
const oldLead2 = `${OLD.slice(0, 20)}bbbb` // no draft yet
db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES (?, 'u1', ?, 'pat@cccc.example', 'Hello', 'A synthetic draft body for the contested play.', 'draft')").run('f'.repeat(24), oldLead)
db.close()

const read = () => { const d = new Database(DB, { readonly: true }); try { return {
  jobs: d.prepare('SELECT id, query, offer, seller FROM scan_jobs ORDER BY created_at, rowid').all(),
  sells: d.prepare("SELECT sells FROM users WHERE id = 'u1'").get().sells,
  drafts: d.prepare('SELECT id, lead_id, body, status FROM outreach_messages ORDER BY created_at, rowid').all(),
} } finally { d.close() } }
const s0 = read()

const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', SCAN_MAX_CONCURRENT: '0', DAZL_UI_SYNTHETIC_MASTER: MASTER.toString('base64'), DAZL_UI_PROVIDER_LOG: PROVIDER_LOG, DAZL_UI_RESEARCH_URL: RESEARCH_URL, NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')} --import ${path.join(dir, 'test/helpers/ui-provider-stub.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }
const b = await chromium.launch()
const ICP = { summary: 'London SaaS startups hiring their first sales rep', who: ['Founders of SaaS startups'], industries: ['SaaS'], sizes: ['1-50 employees'], where: ['London'], signals: ['Hiring a first sales rep'], exclude: [] }
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: false }) }
async function context(token, width) {
  const ctx = await b.newContext({ viewport: { width, height: 900 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const page = await ctx.newPage(); await page.route(u => u.origin !== base, r => r.abort())
  // the one paid boundary: inferring the profile calls a model, so its answer is synthetic
  await page.route('**/api/scan/icp', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ icp: ICP, inferred: true }) }))
  return { ctx, page }
}
// same-origin API calls from the page itself, as the app makes them
const api = (page, method, url, body) => page.evaluate(async ([m, u, bd]) => { const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: bd === undefined ? undefined : JSON.stringify(bd) }); return { status: r.status, json: await r.json().catch(() => null) } }, [method, url, body])
const offerOn = async (page, url, wrap) => {
  await page.goto(base + url, { waitUntil: 'networkidle' })
  const card = page.getByTestId(wrap); await card.waitFor({ timeout: 15000 }); await card.scrollIntoViewIfNeeded()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${url}: horizontal scroll`)
  return { conflict: await card.getByTestId('play-offer-conflict').count(), offer: await card.getByTestId('play-offer-text').count() ? (await card.getByTestId('play-offer-text').innerText()).trim() : null }
}

try {
  const { ctx, page } = await context(tokenA, 1280)
  // 1. review asks which offer this play is for; a direct run without a choice is refused and queues nothing
  await page.goto(base + '/app/leads', { waitUntil: 'networkidle' })
  await page.getByPlaceholder('Find people who...').fill(QUERY)
  await page.getByRole('button', { name: 'Review profile first' }).click()
  const chooser = page.getByTestId('offer-chooser'); await chooser.waitFor({ timeout: 15000 })
  assert.match(await chooser.innerText(), /CRM setup and outbound consulting/); assert.match(await chooser.innerText(), /appointment booking and reminder software/)
  assert.ok(await page.getByRole('button', { name: 'Run scan with this profile' }).first().isDisabled(), 'Run is disabled until the offer is chosen')
  await shot(page, 'journey-1-choice-1280')
  const direct = await api(page, 'POST', '/api/scan', { query: QUERY })
  assert.equal(direct.status, 409); assert.equal(direct.json.error, 'offer_conflict')
  assert.equal(read().jobs.length, s0.jobs.length, 'a refused admission queues nothing')

  // 2. the explicit choice, then the estimate confirmation, creates the play with that offer stored on it
  await page.getByTestId('offer-use-stated').click()
  assert.equal(await page.getByTestId('review-offer-input').inputValue(), CRM)
  await page.getByRole('button', { name: 'Run scan with this profile' }).first().click()
  await page.getByTestId('estimate-confirm-run').click({ timeout: 15000 })
  let s1
  for (let i = 0; i < 50 && !(s1 = read()).jobs.find(j => j.query === QUERY); i++) await new Promise(r => setTimeout(r, 200))
  const london = s1.jobs.find(j => j.query === QUERY)
  assert.ok(london, 'the play was created')
  assert.equal(london.offer, CRM, 'the chosen offer is stored with this play')
  assert.equal(s1.sells, DENTAL_SELLER, 'the saved profile is unchanged')
  assert.deepEqual(s1.jobs.filter(j => j.id !== london.id), s0.jobs, 'the dental and older plays are unchanged')
  await shot(page, 'journey-2-created-1280')

  // 3. research for the new play uses the chosen offer (its scoring context), never the dental one
  { const d = new Database(DB, { readonly: true }); try {
    const block = offerBlockFor(d, 'u1', london.id)
    assert.match(block, /CRM setup and outbound consulting/); assert.doesNotMatch(block, /appointment booking/)
  } finally { d.close() } }

  // 3b. the worker runs the London play. The server runs no scans (SCAN_MAX_CONCURRENT=0), so it stays pending until this
  // process claims it, as a separate worker would: the real claim (pending -> running) and the real runner, forward to
  // done. Stand-ins: the provider (test/helpers/ui-provider-stub.ts) and one synthetic evidence page for the cited URL.
  const pageText = 'Synthetic SaaS Ltd is hiring its first account executive in London. The London-based SaaS startup is building its first sales team and is hiring its first account executive. Contact hello@syntheticsaas.example.'
  const synthPage = async u => u === RESEARCH_URL ? { text: pageText, title: 'Synthetic SaaS Ltd careers', retrievedAt: Math.floor(Date.now() / 1000), published: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10) } : { fail: 'not_found' }
  let londonLead
  { const wdb = new Database(DB); try {
    assert.equal(wdb.prepare('SELECT status FROM scan_jobs WHERE id = ?').get(london.id).status, 'pending', 'the server ran nothing')
    const job = claimKeyedJob(wdb, london.id); assert.ok(job, 'the worker claims the pending play')
    assert.equal(await runJob(wdb, job, { fetchPage: synthPage }), 'done')
    const leads = wdb.prepare('SELECT id, contact FROM leads WHERE scan_job_id = ?').all(london.id)
    assert.equal(leads.length, 1); assert.equal(leads[0].contact, 'hello@syntheticsaas.example'); londonLead = leads[0].id
  } finally { wdb.close() } }
  const runCalls = providerCalls()
  // every model call of that run that carries an offer carries the chosen one; none carries the dental offer
  assert.ok(runCalls.some(c => c.research && c.prompt.includes(CRM)), 'the research prompt states the chosen offer')
  assert.ok(runCalls.some(c => c.prompt.startsWith('You are grading sales leads') && c.prompt.includes(CRM)), 'the scoring prompt states the chosen offer')
  assert.ok(runCalls.every(c => !c.prompt.includes('appointment booking')), 'no research or scoring prompt carries the dental offer')

  // 3c. the London play's own draft: the template states the chosen offer, the rendered draft preview shows it, and the
  // AI rewrite (the real button) sends the model the chosen offer only and replaces the draft; the profile is unchanged
  // drafting a machine-verified lead first needs the user's own review of its source (the currentness gate): the real route
  const noReview = await api(page, 'POST', '/api/outreach', { lead_id: londonLead })
  assert.deepEqual([noReview.status, noReview.json?.code], [409, 'lead_currentness_unconfirmed'], 'the currentness gate is not bypassed')
  assert.deepEqual(await api(page, 'POST', `/api/leads/${londonLead}/confirm`), { status: 200, json: { confirmed: true } })
  const madeLondon = await api(page, 'POST', '/api/outreach', { lead_id: londonLead })
  assert.ok(madeLondon.status === 200 || madeLondon.status === 201, JSON.stringify(madeLondon))
  const londonDraft = read().drafts.find(m => m.lead_id === londonLead)
  assert.match(londonDraft.body, /CRM setup and outbound consulting/); assert.doesNotMatch(londonDraft.body, /appointment booking/)
  for (const w of [1280, 390]) {
    const { ctx: c, page: p } = await context(tokenA, w)
    await p.goto(base + `/app/outreach?job_id=${london.id}`, { waitUntil: 'networkidle' })
    const card = p.locator('.card', { hasText: 'hello@syntheticsaas.example' }).first(); await card.waitFor({ timeout: 15000 })
    assert.match(await card.innerText(), /CRM setup and outbound consulting/); assert.doesNotMatch(await card.innerText(), /appointment booking/)
    await card.scrollIntoViewIfNeeded(); await shot(p, `journey-3c-london-draft-${w}`)
    await c.close()
  }
  const nBefore = providerCalls().length
  { const { ctx: c, page: p } = await context(tokenA, 1280)
    await p.goto(base + `/app/outreach?job_id=${london.id}`, { waitUntil: 'networkidle' })
    const card = p.locator('.card', { hasText: 'hello@syntheticsaas.example' }).first(); await card.waitFor({ timeout: 15000 })
    await card.getByRole('button', { name: 'Rewrite with AI (uses your key)' }).click()
    await p.getByText(/Rewritten with your Anthropic key/).waitFor({ timeout: 15000 })
    await p.locator('.card', { hasText: 'I saw the role you are hiring for' }).first().waitFor({ timeout: 15000 })
    await shot(p, 'journey-3c-london-rewritten-1280')
    await c.close() }
  const rewriteCalls = providerCalls().slice(nBefore)
  assert.equal(rewriteCalls.length, 1, 'one model call for one rewrite')
  assert.match(rewriteCalls[0].prompt, /CRM setup and outbound consulting/); assert.doesNotMatch(rewriteCalls[0].prompt, /appointment booking/)
  const rewritten = read().drafts.find(m => m.id === londonDraft.id)
  assert.match(rewritten.body, /I saw the role you are hiring for/); assert.equal(rewritten.status, 'draft')
  assert.equal(read().sells, DENTAL_SELLER, 'the global profile is unchanged'); assert.equal(read().jobs.find(j => j.id === london.id).offer, CRM)

  // 5. a contested play refuses drafts and rewrites, makes no model call, and writes nothing
  const before5 = read(), calls5 = providerCalls().length
  const refusedDraft = await api(page, 'POST', '/api/outreach', { lead_id: oldLead2 })
  assert.equal(refusedDraft.status, 409); assert.equal(refusedDraft.json?.code, 'offer_conflict')
  // the rewrite now runs with a decryptable key and a working provider fake, so it reaches the offer check itself
  const refusedPolish = await api(page, 'POST', '/api/outreach/polish', { message_id: 'f'.repeat(24) })
  assert.equal(refusedPolish.status, 200, JSON.stringify(refusedPolish))
  assert.deepEqual([refusedPolish.json.rewritten, refusedPolish.json.reason], [false, 'offer_conflict'])
  // and through the rendered button on the drafts page: the refusal message, the original draft text kept
  await page.goto(base + `/app/outreach?job_id=${OLD}`, { waitUntil: 'networkidle' })
  const oldCard = page.locator('.card', { hasText: 'A synthetic draft body for the contested play.' }).first(); await oldCard.waitFor({ timeout: 15000 })
  await oldCard.getByRole('button', { name: 'Rewrite with AI (uses your key)' }).click()
  await page.getByText(/names a different offer than the one it was created with/).waitFor({ timeout: 15000 })
  await shot(page, 'journey-5-rewrite-refused-1280')
  assert.equal(providerCalls().length, calls5, 'no provider call for a contested play')
  assert.deepEqual(read(), before5, 'refusals wrote nothing')
  // its explicit choice on its own campaign page stores that play's offer only; then a draft states it
  await page.goto(base + `/app/campaigns/${OLD}`, { waitUntil: 'networkidle' })
  await page.getByTestId('campaign-offer').getByTestId('play-offer-conflict').waitFor({ timeout: 15000 })
  await shot(page, 'journey-5-contested-1280')
  await page.getByTestId('campaign-offer').getByTestId('play-offer-use-stated').click()
  await page.getByTestId('campaign-offer').getByTestId('play-offer-text').waitFor({ timeout: 15000 })
  const after5 = read()
  assert.equal(after5.jobs.find(j => j.id === OLD).offer, 'SEO audits', 'the choice is stored on that play')
  assert.deepEqual(after5.jobs.filter(j => j.id !== OLD), before5.jobs.filter(j => j.id !== OLD), 'no other play changed')
  assert.equal(after5.sells, DENTAL_SELLER)
  const made = await api(page, 'POST', '/api/outreach', { lead_id: oldLead2 })
  assert.ok(made.status === 200 || made.status === 201, `draft created after the choice: ${JSON.stringify(made)}`)
  const drafted = read().drafts.find(m => m.lead_id === oldLead2)
  assert.match(drafted.body, /SEO audits/, 'the new draft states the chosen offer'); assert.doesNotMatch(drafted.body, /appointment booking/)
  await shot(page, 'journey-5-chosen-1280')
  await ctx.close()

  // 4. every view agrees with the stored state, at both widths and after a reload; viewing writes nothing
  const s4 = read()
  for (const w of [1280, 390]) {
    const { ctx: c, page: p } = await context(tokenA, w)
    for (let pass = 0; pass < 2; pass++) {
      for (const [url, wrap, name, want] of [[`/app/campaigns/${london.id}`, 'campaign-offer', 'campaign-london', CRM], [`/app/outreach?job_id=${london.id}`, 'outreach-play-offer', 'drafts-london', CRM],
        [`/app/campaigns/${DENTAL}`, 'campaign-offer', 'campaign-dental', DENTAL_SELLER], [`/app/outreach?job_id=${DENTAL}`, 'outreach-play-offer', 'drafts-dental', DENTAL_SELLER]]) {
        const r = await offerOn(p, url, wrap)
        assert.deepEqual([r.conflict, r.offer], [0, want], `${name}@${w}${pass ? ' after reload' : ''}`)
        if (!pass) await shot(p, `journey-4-${name}-${w}`)
      }
      // Home shows the current play (the newest): the London play and its CRM offer
      const home = await offerOn(p, '/app', 'journey-play-offer')
      assert.deepEqual([home.conflict, home.offer], [0, CRM], `home@${w}${pass ? ' after reload' : ''}`)
      if (!pass) await shot(p, `journey-4-home-${w}`)
    }
    await c.close()
  }
  assert.deepEqual(read(), s4, 'viewing chose nothing and rewrote nothing')

  // 6. another workspace can neither read nor choose this play's offer
  { const { ctx: c, page: p } = await context(tokenB, 1280)
    await p.goto(base + '/app', { waitUntil: 'networkidle' })
    const r = await api(p, 'GET', `/api/campaigns/${london.id}`)
    assert.equal(r.status, 404, 'another workspace cannot read the play')
    const w = await api(p, 'POST', `/api/campaigns/${london.id}`, { offer: 'Something else entirely' })
    assert.ok(w.status === 404 || w.status === 403, `another workspace cannot choose its offer: ${w.status}`)
    assert.deepEqual(read(), s4, 'nothing changed')
    await c.close() }

  // 7. a later profile edit does not rewrite the confirmed play
  { const { ctx: c, page: p } = await context(tokenA, 1280)
    await p.goto(base + '/app', { waitUntil: 'networkidle' })
    const e = await api(p, 'POST', '/api/settings/profile', { sells: 'We sell payroll software to restaurants.' })
    assert.equal(e.status, 200, JSON.stringify(e))
    const s7 = read()
    assert.equal(s7.sells, 'We sell payroll software to restaurants.')
    assert.equal(s7.jobs.find(j => j.id === london.id).offer, CRM, 'the confirmed play keeps its offer')
    const camp = await offerOn(p, `/app/campaigns/${london.id}`, 'campaign-offer')
    assert.deepEqual([camp.conflict, camp.offer], [0, CRM], 'campaign after a profile edit')
    await shot(p, 'journey-7-campaign-after-profile-edit-1280')
    await c.close() }

  // 8. mobile creation and choice, for a request that only withdraws the saved offer: nothing is invented, Run stays
  // disabled until the user keeps the saved offer or writes this play's own, and the written offer is stored on the play
  { const { ctx: c, page: p } = await context(tokenA, 390)
    const SAVED8 = 'We sell payroll software to restaurants.', Q8 = 'Find Manchester agencies hiring. We no longer sell payroll software.', OWN = 'Bookkeeping for agencies'
    const s8 = read(); assert.equal(s8.sells, SAVED8)
    await p.goto(base + '/app/leads', { waitUntil: 'networkidle' })
    const direct8 = await api(p, 'POST', '/api/scan', { query: Q8 })
    assert.equal(direct8.status, 409); assert.deepEqual([direct8.json.error, direct8.json.stated, direct8.json.withdrawn], ['offer_conflict', null, 'payroll software'])
    assert.deepEqual(read(), s8, 'a refused admission queues nothing')
    await p.getByPlaceholder('Find people who...').fill(Q8)
    await p.getByRole('button', { name: 'Review profile first' }).click()
    const ch = p.getByTestId('offer-chooser'); await ch.waitFor({ timeout: 15000 })
    assert.match(await ch.getByTestId('offer-withdrawn').innerText(), /do not offer payroll software/)
    assert.equal(await ch.getByTestId('offer-use-stated').count(), 0, 'no offer is invented for a withdrawal')
    const run8 = p.getByRole('button', { name: 'Run scan with this profile' }).first()
    assert.ok(await run8.isDisabled(), 'Run is disabled until resolved')
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no horizontal scroll at 390')
    await ch.scrollIntoViewIfNeeded(); await shot(p, 'journey-8-withdrawn-choice-390')
    await ch.getByTestId('offer-write').click()
    assert.equal(await p.getByTestId('review-offer-input').inputValue(), '', 'the offer field starts empty: nothing invented')
    assert.ok(await run8.isDisabled(), 'Run stays disabled with no offer')
    await p.getByTestId('review-offer-input').fill(OWN)
    await shot(p, 'journey-8-written-offer-390')
    await run8.click()
    await p.getByTestId('estimate-confirm-run').click({ timeout: 15000 })
    let s9
    for (let i = 0; i < 50 && !(s9 = read()).jobs.find(j => j.query === Q8); i++) await new Promise(r => setTimeout(r, 200))
    const made8 = s9.jobs.find(j => j.query === Q8)
    assert.ok(made8, 'the play was created from mobile'); assert.equal(made8.offer, OWN, 'the written offer is stored on that play')
    assert.equal(s9.sells, SAVED8, 'the saved profile is unchanged')
    assert.deepEqual(s9.jobs.filter(j => j.id !== made8.id), s8.jobs, 'no other play changed')
    const camp8 = await offerOn(p, `/app/campaigns/${made8.id}`, 'campaign-offer')
    assert.deepEqual([camp8.conflict, camp8.offer], [0, OWN], 'its campaign page shows the written offer')
    await shot(p, 'journey-8-campaign-390')
    await c.close() }

  console.log('offer journey passed: review asked for a choice and refused a direct run; the chosen CRM offer was stored on that play only and research uses it; a contested play refused drafts and rewrites until its own choice, then drafted with it; Home, campaign and drafts agree at 1280 and 390 and after reload; another workspace cannot read or choose; a later profile edit leaves the play unchanged; the London play ran through the real worker with its offer in research and scoring, drafted and rewrote with it; a withdrawal was resolved on mobile by writing the offer')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
