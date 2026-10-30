// The offer journey end to end (#349). NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/offer-journey.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, a throwaway synthetic database, the REAL routes and pages. Only the paid boundary is stubbed:
// the browser's /api/scan/icp answer (it calls a model); the server runs under test/helpers/net-fence.ts, so any
// non-loopback request throws and inherited secrets are scrubbed (no provider, Gmail or search call can happen), and the
// browser aborts off-host requests. The tenant's saved profile sells dental appointment software in New York City.
//   1. Review: a London SaaS play selling CRM setup and outbound consulting is reviewed on Find leads. The page asks
//      which offer this play is for; Run stays disabled. A direct POST /api/scan without a choice is refused
//      (409 offer_conflict) and queues nothing.
//   2. Explicit choice: the user picks the CRM offer on the page, confirms the estimate, and the play is created with
//      that offer stored on the play only (scan_jobs.offer); the saved profile and the dental play are unchanged.
//   3. Context: research scoring for that play (offerBlockFor) states the CRM offer, never the dental one.
//   4. Views agree with the stored state at 1280 and 390, and after a reload: Home, the campaign page and the play's
//      drafts page show the CRM offer; the dental play's pages still show the dental offer. Viewing writes nothing.
//   5. Conflicts block: an older contested play refuses a draft (POST /api/outreach) and an AI rewrite (POST
//      /api/outreach/polish) with offer_conflict, and writes nothing. Its explicit choice on its campaign page stores
//      that play's offer only, and a draft made after it states the chosen offer.
//   6. Another workspace can neither read the play (GET /api/campaigns/<id> 404) nor choose its offer (POST 404/403),
//      and nothing changes.
//   7. A later edit of the saved profile does not rewrite the confirmed play: it still sells CRM setup everywhere.
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
const { offerBlockFor } = await import(path.join(dir, 'lib/scan/runner.ts'))

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
// an AI key row so admission sees a funded account; it never decrypts and the fence blocks any provider call
db.prepare("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES ('u1', 'anthropic', 'synthetic-not-a-key', 'test', 0)").run()
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
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
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

  // 5. a contested play refuses drafts and rewrites, and writes nothing
  const before5 = read()
  const refusedDraft = await api(page, 'POST', '/api/outreach', { lead_id: oldLead2 })
  assert.equal(refusedDraft.status, 409); assert.equal(refusedDraft.json?.code, 'offer_conflict')
  // the rewrite never happens and writes nothing. In this harness it cannot reach the offer check: the fence scrubs every
  // *KEY* variable, so the server has no master key and the route fails (500) before any provider or offer logic. The
  // offer_conflict refusal of the rewrite with a working provider is proved in test/play-offer-349.test.ts ("the AI
  // rewrite refuses with no model call"). NOT proved here: the rendered rewrite button's refusal message.
  const refusedPolish = await api(page, 'POST', '/api/outreach/polish', { message_id: 'f'.repeat(24) })
  assert.notEqual(refusedPolish.json?.rewritten, true, JSON.stringify(refusedPolish))
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

  console.log('offer journey passed: review asked for a choice and refused a direct run; the chosen CRM offer was stored on that play only and research uses it; a contested play refused drafts and rewrites until its own choice, then drafted with it; Home, campaign and drafts agree at 1280 and 390 and after reload; another workspace cannot read or choose; a later profile edit leaves the play unchanged')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
