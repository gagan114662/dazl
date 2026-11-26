// Rendered check for the compact lead cards on Leads. NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/lead-cards.ui.mjs   (SHOTS=<dir> also saves screenshots)
// Real production build, throwaway database, server under test/helpers/net-fence.ts, and EVERY /api/* CALL ANSWERED
// FROM A STUB in the browser: no scan, no draft is really created, nothing is sent. Off-host requests are aborted.
// It proves, on the rendered page:
//   0. viewing a scan, Leads links to that scan's campaign page;
//   1. each card shows company, contact, one line of why, source link + date, and Approve / Reject; Details is closed;
//   1b. the contact's uncertainty is visible beside it on the collapsed card: name-guessed website (Instinct's repro),
//      conflicting websites, restricted inbox, past-title people; only cited/own-site/user-checked reads "Confirmed";
//   2. Approve on an eligible lead sends one POST /api/outreach { lead_id } per attempt (the existing draft action),
//      even on a double click against a slow server; after a failure it can be retried; nothing else is written;
//   3. Held leads omit Approve and show the reason (no email, window, timing);
//   4. Reject opens an optional-reason step (presets, free text, Cancel/Escape writes nothing); Confirm reject sends the
//      existing quarantine POST with "Rejected: <reason>" (or just "Rejected" with none); the card leaves To decide, the
//      result line says so and the card shows its reason under Rejected; Undo (on the card or the result) sends its DELETE;
//   5. an interrupted (HELD) enrichment lookup surfaces with its exact cost wording; the owner's Retry posts
//      /api/leads/<id>/enrich-retry once, and the notice clears when nothing is held.
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import { createRequire } from 'node:module'
const UNVERIFIED_COST = 'Retry unavailable: what this lookup costs on your Apollo account has not been verified, so it stays held and no new lookup is made. Whether the earlier interrupted attempt was already billed is not known. Apollo documents contact search as 0 credits on current plans, but older plans can differ. It can be retried once the cost on your account is confirmed.'
import { fileURLToPath } from 'node:url'
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-leadcards-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), email_verified_at INTEGER); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt,email_verified_at) VALUES ('u1','s@example.test','x','y',1)").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const JOB = 'b'.repeat(24)
const ICP = { summary: 'Growing dental practices', who: ['Practice owner'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['new location'], exclude: [] }
const lead = (id, company, over = {}) => ({ id, name: '', company, contact: null, signal: `${company} opened a second office`, source_url: `https://www.news.example/${id.slice(0, 4)}`, score: 70, evidence_excerpt: `${company} opened a second office`, event_date: '2026-10-01', date_status: 'unverified', confidence: 80, review_reason: null, company_domain: null, human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 3, action: 3, why: `${company} is a two-location practice that matches your dental owner profile. More detail follows.`, signals: null, icp_match: null, enrichments: [], events: [], ...over })
const dom = (site, token, url = 'https://www.news.example/x') => ({ connector: 'sitecrawl', kind: 'domain', value: `${site}|${token}`, label: `domain-basis-v1:${token}`, source_url: url, source_date: '2026-10-20', confidence: null })
const row = (kind, value) => ({ connector: 'sitecrawl', kind, value, label: null, source_url: 'https://name-guessed.example/team', source_date: '2026-10-20', confidence: null })
const LEADS = [
  lead('a'.repeat(24), 'Bright Dental', { contact: 'hello@brightdental.example', enrichments: [{ connector: 'signals:greenhouse-gtm', kind: 'hiring', value: 'Senior Sales Ops Manager - posted 2026-10-01', label: 'Requested role: sales operations manager; London', confidence: 70, source_url: 'https://boards.greenhouse.io/bright/jobs/1', source_date: '2026-10-01' }, { connector: 'signals:greenhouse', kind: 'hiring', value: '6 open roles', label: 'Account Executive', confidence: 70, source_url: 'https://boards.greenhouse.io/bright', source_date: '2026-10-20' }, { connector: 'signals:careers-gtm', kind: 'hiring', value: 'Open role on its careers page: CRM Administrator', label: 'Requested role: CRM administrator; CRM Administrator listed on the Bright Dental careers page', confidence: 60, source_url: 'https://brightdental.example/careers/crm', source_date: '2026-10-28' }, { connector: 'signals:careers-gtm', kind: 'hiring', value: 'Open role on its careers page: RevOps Lead - posted 2026-10-15', label: 'Requested role: revops lead; Greenhouse first-published date read from the linked posting; RevOps Lead at Bright Dental', confidence: 60, source_url: 'https://boards.greenhouse.io/bright/jobs/77', source_date: '2026-10-15' }, { connector: 'signals:careers-gtm', kind: 'hiring-role', value: 'Open role on its careers page: Sales Ops Lead - posted 2026-03-01', label: 'Long-open: first published 2026-03-01, older than the last 90 days (repost history unknown, not renewed demand); requested role: sales ops lead; Sales Ops Lead', confidence: null, source_url: 'https://boards.greenhouse.io/bright/jobs/78', source_date: '2026-03-01' }, { connector: 'signals:greenhouse-gtm', kind: 'hiring-role', value: 'Office Manager', label: 'Board listing audit (all listed titles): title listed on the board; its posting date was not read', confidence: null, source_url: 'https://boards.greenhouse.io/bright', source_date: '2026-10-21' }] }),
  lead('c'.repeat(24), 'Lakeside Smiles'),
  lead('d'.repeat(24), 'Old Town Dental', { contact: 'info@oldtown.example', window_held: true }),
  // Instinct's repro: website guessed from the name, crawled address on it, a listed person.
  lead('e'.repeat(24), 'Pico Dental', { contact: 'hello@name-guessed.example', enrichments: [dom('name-guessed.example', 'name_probe', 'https://name-guessed.example/'), row('email', 'hello@name-guessed.example'), row('person', 'Dana Smith, Practice owner')] }),
  lead('f'.repeat(24), 'Twin Dental', { contact: 'hello@a-dental.example', enrichments: [dom('a-dental.example', 'name_probe'), dom('b-dental.example', 'evidence_link_domain_label'), row('email', 'hello@a-dental.example')] }),
  lead('1'.repeat(24), 'Quiet Dental', { contact: 'privacy@quietdental.example' }),
  lead('2'.repeat(24), 'Former Dental', { contact: 'hello@formerdental.example', enrichments: [row('person', 'Pat Lee, Former practice owner')] }),
  // #1837: the full three-action row (Approve held - no email; Message on LinkedIn; Reject) under a long one-line summary.
  lead('3'.repeat(24), 'Northgate Dental', { signal: 'Northgate Dental opened a second office in Columbus, OH and is expanding its front-desk team across both locations this quarter', why: null, source_kind: 'discover', enrichments: [{ connector: 'discover', kind: 'person', value: 'Dana Ruiz, Practice Owner', label: null, source_url: 'https://northgate.example/team', source_date: '2026-10-20', confidence: null }, { connector: 'discover', kind: 'linkedin', value: 'https://www.linkedin.com/in/dana-ruiz', label: 'linked from a public page', source_url: 'https://northgate.example/team', source_date: '2026-10-20', confidence: null }] }),
]
let outreachMode = 'ok'
let heldMode = false; const retryCalls = []
const writes = []; const outreachBodies = []; const quarantineCalls = []
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
// One API stub for every context in this file: register it on each new context (a context without it
// would hit the real server and see no seeded leads - the first 390px run failed exactly this way).
const routeApi = async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method()
  if (u.origin !== base) return route.abort()
  if (!u.pathname.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (m !== 'GET') writes.push(`${m} ${u.pathname}`)
  if (u.pathname === '/api/scan/status') return json({ status: 'done', lead_count: LEADS.length, icp: ICP, icp_source: 'user', attempts: 1, max_attempts: 3, query: 'Dental practice owners in Ohio opening a new location' })
  if (u.pathname === '/api/leads') return json({ job_id: JOB, status: 'done', hidden_count: 0, leads: LEADS })
  if (u.pathname === '/api/scan/jobs') return json({ jobs: [] })
  if (u.pathname === '/api/outreach' && m === 'POST') {
    outreachBodies.push(JSON.parse(req.postData()))
    await new Promise(res => setTimeout(res, 800)) // a slow server: a double click lands while the first request is in flight
    if (outreachMode === 'fail') { outreachMode = 'ok'; return json({ error: 'Could not create the draft right now' }, 500) }
    return json({ ok: true, message_id: 'm1' })
  }
  const q = /^\/api\/leads\/([a-f0-9]{24})\/quarantine$/.exec(u.pathname)
  if (q) { quarantineCalls.push({ method: m, lead: q[1], body: req.postData() ? JSON.parse(req.postData()) : null }); return json({ quarantined: m === 'POST' }) }
  if (u.pathname === '/api/enrich/held') return json(heldMode ? { held: [{ leadId: 'a'.repeat(24), company: 'Bright Dental', provider: 'apollo', step: 'people', since: 1762000000, costText: UNVERIFIED_COST, retryable: false }] } : { held: [] })
  const er = /^\/api\/leads\/([a-f0-9]{24})\/enrich-retry$/.exec(u.pathname)
  if (er && m === 'POST') { retryCalls.push({ lead: er[1], body: req.postData() ? JSON.parse(req.postData()) : null }); return json({ retried: true, attached: 1, releases: ['apollo people'] }) }
  return json({}, 404)
}
await ctx.route('**/*', routeApi)
const page = await ctx.newPage()
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
try {
  await page.goto(`${base}/app/leads?job_id=${JOB}&passive=1`, { waitUntil: 'networkidle' })
  // Card-content checks: select the Cards view explicitly - the default view is the table (#1038).
  await page.getByTestId('view-cards').click()
  const cards = page.getByTestId('lead-card')
  await cards.first().waitFor({ timeout: 15000 })
  assert.equal(await cards.count(), 8)
  assert.equal(await page.getByTestId('campaign-page-link').getAttribute('href'), `/app/campaigns/${JOB}`, 'Leads links the scan being viewed to its campaign page')
  await page.locator('main').evaluate(m => m.scrollTo(0, m.scrollHeight)); await shot('cards')

  const bright = cards.filter({ hasText: 'Bright Dental' })
  assert.match(await bright.textContent(), /hello@brightdental\.example/)
  assert.equal(await bright.getByTestId('contact-status').textContent(), 'Confirmed: address printed on the cited page.')

  // Contact uncertainty is on the collapsed card, beside the contact, not only in Details.
  const statusOf = name => cards.filter({ hasText: name }).getByTestId('contact-status')
  const pico = cards.filter({ hasText: 'Pico Dental' })
  // #1037: a person on a site only guessed by name is never presented as the buyer: the card shows the address and names nobody
  assert.match(await pico.textContent(), /hello@name-guessed\.example/)
  assert.doesNotMatch(await pico.textContent(), /Dana Smith/)
  assert.equal(await statusOf('Pico Dental').isVisible(), true)
  assert.equal(await statusOf('Pico Dental').textContent(), 'Unconfirmed - name match only: name-guessed.example: found by name search, not linked from the source. No buyer named on the company\'s own site.')
  assert.equal(await pico.getByRole('button', { name: 'Approve', exact: true }).count(), 0)
  assert.equal(await pico.getByTestId('approve-hold').isVisible(), true)
  assert.match(await statusOf('Twin Dental').textContent(), /^Unconfirmed - name match only: several websites recorded \(a-dental\.example, b-dental\.example\); which one is theirs is not settled\./)
  assert.match(await statusOf('Quiet Dental').textContent(), /Restricted inbox \(privacy\): not a sales contact\./)
  assert.doesNotMatch(await cards.filter({ hasText: 'Former Dental' }).textContent(), /Pat Lee/)
  assert.match(await statusOf('Former Dental').textContent(), /Listed people have past, negated or assistant titles; no current buyer named\./)
  assert.match(await bright.textContent(), /Bright Dental is a two-location practice that matches your dental owner profile\./)
  assert.doesNotMatch(await bright.textContent(), /More detail follows/, 'one line of why, not the whole rationale')
  assert.match(await bright.textContent(), /news\.example · claimed event date 1 Oct 2026/)
  // The card's Details disclosure is its following sibling (the card div closes at the hold/approve line).
  const brightDetails = bright.locator('xpath=following-sibling::details[1]')
  await brightDetails.getByText('Details', { exact: true }).click()
  await brightDetails.getByText("Hiring for Senior Sales Ops Manager. This may relate to your offer; buying need isn't verified.", { exact: true }).waitFor()
  // AC5: the matched posting's title and its own board date sit beside the qualified line
  await brightDetails.getByText(/posting date 2026-10-01/).waitFor()
  // AC3: generic GTM hiring that never matched the requested role is labeled generic, never role-qualified
  await brightDetails.getByText('Hiring activity only. A requested-role match and buying need are not verified.', { exact: true }).waitFor()
  await brightDetails.getByText(/checked 2026-10-20; original posting date unknown/).waitFor()
  // AC5: a hiring signal alone never produces a high-intent-style claim
  assert.equal(await page.getByText(/high.intent/i).count(), 0, 'no high-intent-style claim anywhere on the page')
  // direct-career render arm: the careers-page role match renders the same qualified line with the clean posting title,
  // and its date arm is unambiguous - the check day is labeled checked, the original posting date is honestly unknown
  await brightDetails.getByText("Hiring for CRM Administrator. This may relate to your offer; buying need isn't verified.", { exact: true }).waitFor()
  await brightDetails.getByText(/checked 2026-10-28; original posting date unknown/).waitFor()
  // #533 AC4 careers->ATS: a careers link to a public ATS posting renders the clean title and the posting's own first-published date
  await brightDetails.getByText("Hiring for RevOps Lead. This may relate to your offer; buying need isn't verified.", { exact: true }).waitFor()
  await brightDetails.getByText(/posting date 2026-10-15/).waitFor()
  // long-open: shown with its own old date and the long-open label, never as a qualified hiring line
  await brightDetails.getByText(/Long-open: first published 2026-03-01/).waitFor()
  assert.equal(await brightDetails.getByText(/Hiring for Sales Ops Lead/).count(), 0, 'a long-open posting is never rendered as current hiring')
  // an audit title whose posting date was never read renders as date unknown, never as a dated sighting
  await brightDetails.getByText(/checked 2026-10-21; posting date unknown/).waitFor()
  await shot('hiring-provenance')
  await brightDetails.getByText('Details', { exact: true }).click()
  assert.equal(await bright.getByRole('link', { name: 'news.example' }).getAttribute('href'), 'https://www.news.example/aaaa')
  assert.equal(await page.getByText('Reported event: Bright Dental opened a second office').isVisible(), false, 'Details are closed by default')

  // Held leads omit Approve and explain the hold on the card.
  const lakeside = cards.filter({ hasText: 'Lakeside Smiles' })
  assert.equal(await lakeside.getByRole('button', { name: 'Approve', exact: true }).count(), 0)
  assert.match(await lakeside.textContent(), /No contact found yet[\s\S]*Can't approve yet\. No published email address to draft to yet/)
  const old = cards.filter({ hasText: 'Old Town Dental' })
  assert.equal(await old.getByRole('button', { name: 'Approve', exact: true }).count(), 0)
  assert.match(await old.textContent(), /Can't approve yet\. Outside the time window/)

  assert.deepEqual(writes, [], 'nothing written by loading the page')
  // First attempt fails: the button comes back for a retry. A double click while in flight sends one request.
  outreachMode = 'fail'
  await bright.getByRole('button', { name: 'Approve' }).dblclick()
  await bright.getByText('Could not create the draft right now').waitFor()
  assert.equal(outreachBodies.length, 1, 'a double click while the request is in flight sends one request')
  assert.equal(await bright.getByRole('button', { name: 'Approve' }).isEnabled(), true, 'retry is possible after a failure')
  await bright.getByRole('button', { name: 'Approve' }).dblclick()
  // Success: a one-line result, and the card moves from To decide to Approved (it is a draft now).
  await page.getByTestId('card-result').getByText(/Bright Dental: draft created/).waitFor()
  assert.deepEqual(outreachBodies, [{ lead_id: 'a'.repeat(24) }, { lead_id: 'a'.repeat(24) }], 'one request per attempt: the failed one and the retry')
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid=lead-card]')].some(c => c.textContent.includes('Bright Dental')))
  await page.getByTestId('tab-approved').click()
  assert.equal(await bright.getByRole('button', { name: 'Approve' }).isDisabled(), true, 'cannot approve again after success')
  await page.getByTestId('tab-review').click()

  // Reject asks for an optional reason; Cancel and Escape write nothing.
  await lakeside.getByRole('button', { name: 'Reject' }).click()
  const reasonRow = lakeside.getByTestId('reject-reason'); await reasonRow.waitFor()
  assert.deepEqual(await reasonRow.getByRole('button').allTextContents(), ['i', 'Wrong industry', 'Wrong location', 'Wrong timing', 'Competitor', 'Already a customer', 'Not useful', 'Confirm reject', 'Cancel']) // the (i) holds what rejecting does; no person on this lead, so no 'Wrong person'
  await reasonRow.getByRole('button', { name: 'Cancel' }).click()
  assert.equal(await lakeside.getByTestId('reject-reason').count(), 0)
  await lakeside.getByRole('button', { name: 'Reject' }).click()
  await lakeside.getByLabel('Reason (optional)').press('Escape')
  assert.equal(await lakeside.getByTestId('reject-reason').count(), 0)
  assert.deepEqual(quarantineCalls, [], 'cancelling writes nothing')
  // A preset reason.
  await lakeside.getByRole('button', { name: 'Reject' }).click()
  await lakeside.getByTestId('reject-reason').getByRole('button', { name: 'Wrong industry' }).click()
  await shot('reject-reason')
  await lakeside.getByRole('button', { name: 'Confirm reject' }).click()
  // The rejected card leaves the list; the result line says so, and the card is under Rejected with its reason.
  const result = page.getByTestId('card-result')
  await result.getByText(/Lakeside Smiles \(Wrong industry\) left the list\./).waitFor()
  assert.equal(await lakeside.count(), 0)
  await page.getByTestId('tab-rejected').click()
  assert.match(await lakeside.textContent(), /^LSLakeside Smiles Rejected[\s\S]*Rejected: Wrong industryiKept with its evidence; it will not be drafted, sent or exported\./)
  await shot('after-actions')
  await lakeside.getByRole('button', { name: 'Undo' }).click()
  await page.getByTestId('tab-review').click()
  await lakeside.getByRole('button', { name: 'Reject' }).waitFor()
  // No reason at all: just "Rejected" (Enter in the box confirms); Undo from the result line.
  await lakeside.getByRole('button', { name: 'Reject' }).click()
  await lakeside.getByLabel('Reason (optional)').press('Enter')
  await result.getByText(/^Lakeside Smiles left the list\./).waitFor()
  await result.getByRole('button', { name: 'Undo' }).click()
  await lakeside.getByRole('button', { name: 'Reject' }).waitFor()
  const C = 'c'.repeat(24)
  assert.deepEqual(quarantineCalls, [
    { method: 'POST', lead: C, body: { reason: 'Rejected: Wrong industry', feedback_reason: 'wrong_industry' } }, { method: 'DELETE', lead: C, body: {} },
    { method: 'POST', lead: C, body: { reason: 'Rejected' } }, { method: 'DELETE', lead: C, body: {} },
  ])
  assert.deepEqual(writes, ['POST /api/outreach', 'POST /api/outreach', `POST /api/leads/${C}/quarantine`, `DELETE /api/leads/${C}/quarantine`, `POST /api/leads/${C}/quarantine`, `DELETE /api/leads/${C}/quarantine`], 'no other writes')

  await page.getByTestId('tab-approved').click() // Bright Dental is under Approved now
  await page.locator('summary:not([data-testid=caveat] summary)', { hasText: 'Details' }).first().click() // a lead's Details, not a page caveat's
  assert.equal(await page.getByText('Reported event: Bright Dental opened a second office').isVisible(), true, 'everything else is still there under Details')

  // 5. A HELD (interrupted) enrichment lookup surfaces with its exact cost wording; the owner's Retry posts once and the notice clears.
  heldMode = true
  await page.reload({ waitUntil: 'networkidle' })
  const heldSection = page.getByTestId('enrich-held')
  await heldSection.waitFor()
  assert.match(await heldSection.textContent(), /Contact enrichment needs attention/)
  assert.match(await heldSection.textContent(), /Bright Dental/)
  assert.equal(await heldSection.getByTestId('enrich-held-cost').textContent(), UNVERIFIED_COST)
  await heldSection.scrollIntoViewIfNeeded(); await shot('enrich-held')
  const retryBtn = heldSection.getByTestId(`enrich-retry-${'a'.repeat(24)}-apollo-people`)
  assert.equal(await retryBtn.isDisabled(), true, 'with the account cost unverified the retry action is disabled')
  assert.deepEqual(retryCalls, [], 'nothing was posted')
  heldMode = false // the retry cleared it
  await page.reload({ waitUntil: 'networkidle' })
  assert.equal(await page.getByTestId('enrich-held').count(), 0, 'the notice clears once nothing is held')
  // #1837: at 390x844 the full action row (Approve / Message on LinkedIn / Reject) and the summary text stay inside
  // the phone - the row wraps instead of forcing the centered column wider than the viewport (prod clipped the row's
  // right edge and the summary's left edge with no sideways scroll).
  const ctx390 = await b.newContext({ viewport: { width: 390, height: 844 } })
  await ctx390.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx390.route('**/*', routeApi)
  const p390 = await ctx390.newPage()
  await p390.goto(`${base}/app/leads?job_id=${JOB}&passive=1`, { waitUntil: 'networkidle' })
  // Card layout is what this scenario asserts: select the Cards view explicitly where the view toggle exists
  // (#1038 makes the table the default; the toggle is absent on bases before it, where cards are the only view).
  if (await p390.getByTestId('view-cards').count()) await p390.getByTestId('view-cards').click()
  const north = p390.getByTestId('lead-card').filter({ hasText: 'Northgate Dental' })
  await north.waitFor({ timeout: 15000 })
  assert.equal(await p390.evaluate(() => document.documentElement.scrollWidth <= 390), true, 'the page never grows wider than a 390px phone')
  const actions = north.getByTestId('card-actions')
  await actions.getByRole('link', { name: 'Message on LinkedIn' }).waitFor()
  for (const el of await actions.locator('button, a').all()) {
    const r = await el.boundingBox()
    assert.ok(r && r.x >= -0.5 && r.x + r.width <= 390.5, `every action stays inside 390px, got ${JSON.stringify(r)}`)
  }
  const whyText = 'Northgate Dental opened a second office in Columbus, OH and is expanding its front-desk team across both locations this quarter'
  const wr = await north.getByText(whyText, { exact: true }).boundingBox()
  const cr = await north.boundingBox()
  assert.ok(wr && cr && wr.x >= cr.x - 0.5 && wr.x + wr.width <= cr.x + cr.width + 0.5, `the summary line stays inside its card: ${JSON.stringify({ wr, cr })}`)
  if (process.env.SHOTS) { await north.scrollIntoViewIfNeeded(); await p390.screenshot({ path: path.join(process.env.SHOTS, 'cards-390.png') }) }
  await ctx390.close()

  // #1038: the table is the default Leads view - 16 dense rows, fit/date sort that survives a reload, cards behind
  // a toggle, and a 390px phone gets the same table with the page itself never widening (it scrolls inside).
  // A scenario-local /api/leads override seeds 16 rows; the shared 8-lead fixture above is untouched.
  const tblLeads = Array.from({ length: 16 }, (_, k) => {
    const i = k + 1
    return lead(String.fromCharCode(102 + i).repeat(24), `Table Co ${i}`, {
      fit: i, event_date: `2026-10-${String(17 - i).padStart(2, '0')}`,
      enrichments: i <= 2 ? [row('person', `Person ${i}, Practice owner`)] : [],
    })
  })
  const tblRoute = route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ job_id: JOB, status: 'done', hidden_count: 0, leads: tblLeads }) })
  const tblMatch = u => u.pathname === '/api/leads'
  await ctx.route(tblMatch, tblRoute)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('view-table').click()
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByTestId('leads-table').waitFor()
  const trows = page.getByTestId('leads-row')
  assert.equal(await trows.count(), 16, 'every lead is a table row')
  let fullyVisible = 0
  for (const r of await trows.all()) { const bb = await r.boundingBox(); if (bb && bb.y >= 0 && bb.y + bb.height <= 900) fullyVisible++ }
  assert.ok(fullyVisible >= 15, `15+ rows visible at 1440x900 without scrolling, got ${fullyVisible}`)
  const firstRowId = async () => trows.first().getAttribute('data-lead-id')
  assert.equal(await firstRowId(), 'v'.repeat(24), 'default sort: highest fit first')
  await page.getByTestId('sort-fit').click()
  assert.equal(await firstRowId(), 'g'.repeat(24), 'clicking fit reverses the order')
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByTestId('leads-table').waitFor()
  assert.equal(await firstRowId(), 'g'.repeat(24), 'the sort choice survives a reload')
  await page.getByTestId('sort-date').click()
  assert.equal(await firstRowId(), 'g'.repeat(24), 'date sort: newest first (2026-10-16 is lead g)')
  await page.getByTestId('sort-date').click()
  assert.equal(await firstRowId(), 'v'.repeat(24), 'date sort toggled: oldest first (2026-10-01 is lead v)')
  if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'leads-table-1440.png') })
  await page.getByTestId('view-cards').click()
  await page.getByTestId('lead-card').first().waitFor()
  await page.reload({ waitUntil: 'networkidle' })
  assert.equal(await page.getByTestId('lead-card').count() > 0, true, 'the cards choice survives a reload')
  await page.getByTestId('view-table').click()
  await page.getByTestId('leads-table').waitFor()
  // #1038 PR 2: a row click opens the side panel; prev/next walk the visible (sorted) order; close returns.
  // The sort here is date ascending (from the toggles above), so the first row is the oldest: Table Co 16.
  // Keyboard first (review of #1869): the table is one tab stop, an arrow key focuses the first row, Enter opens it.
  await page.locator('div[aria-label^="Leads table"]').focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const kpanel = page.getByTestId('leads-side-panel')
  await kpanel.waitFor()
  assert.ok((await kpanel.textContent()).includes('Table Co 16'), 'keyboard: Enter opens the arrow-focused first row')
  await kpanel.getByRole('button', { name: 'Close' }).click()
  assert.equal(await page.getByTestId('leads-side-panel').count(), 0, 'the keyboard-opened panel closes')
  await trows.first().click()
  const panel = page.getByTestId('leads-side-panel')
  await panel.waitFor()
  assert.ok((await panel.textContent()).includes('Table Co 16'), 'the panel shows the clicked (first visible) lead')
  assert.equal(await page.getByTestId('side-panel-prev').isDisabled(), true, 'prev disables at the first row')
  await page.getByTestId('side-panel-next').click()
  assert.ok((await panel.textContent()).includes('Table Co 15'), 'next walks the visible order')
  assert.equal(await page.getByTestId('side-panel-prev').isDisabled(), false, 'prev re-enables off the edge')
  await page.getByTestId('side-panel-prev').click()
  assert.ok((await panel.textContent()).includes('Table Co 16'), 'prev walks back')
  await panel.getByRole('button', { name: 'Close' }).click()
  assert.equal(await page.getByTestId('leads-side-panel').count(), 0, 'close dismisses the panel')
  // Quest on #1869: the panel's Review in Cards button (Approval section, non-rejected leads only)
  // switches to the Cards view, closes the panel, and scrolls to + focuses that lead's card.
  // Sort is still date ascending, so the first row is Table Co 16 (id v*24).
  const co16 = 'v'.repeat(24)
  await trows.first().click()
  await page.getByTestId('leads-side-panel').waitFor()
  await page.getByTestId('side-panel-review-in-cards').click()
  assert.equal(await page.getByTestId('leads-side-panel').count(), 0, 'Review in Cards closes the panel')
  await page.getByTestId('lead-card').first().waitFor()
  assert.equal(await page.getByTestId('view-cards').getAttribute('aria-pressed'), 'true', 'Review in Cards switches to the Cards view')
  await page.waitForFunction(id => document.activeElement && document.activeElement.id === `lead-card-${id}`, co16)
  const co16Box = await page.locator(`#lead-card-${co16}`).boundingBox()
  assert.ok(co16Box && co16Box.y >= 0 && co16Box.y < 900, 'Review in Cards scrolls the lead card into the viewport')
  const ctx390b = await b.newContext({ viewport: { width: 390, height: 844 } })
  await ctx390b.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx390b.route('**/*', routeApi)
  await ctx390b.route(tblMatch, tblRoute)
  const p390b = await ctx390b.newPage()
  await p390b.goto(`${base}/app/leads?job_id=${JOB}&passive=1`, { waitUntil: 'networkidle' })
  await p390b.getByTestId('leads-table').waitFor()
  assert.equal(await p390b.evaluate(() => document.documentElement.scrollWidth <= 390), true, 'at 390px the page never widens; the table scrolls inside')
  await p390b.getByTestId('leads-row').first().click()
  await p390b.getByTestId('leads-side-panel').waitFor()
  assert.equal(await p390b.evaluate(() => document.documentElement.scrollWidth <= 390), true, 'the open panel never widens a 390px phone')
  await p390b.getByTestId('leads-side-panel').getByRole('button', { name: 'Close' }).click()
  assert.equal(await p390b.getByTestId('leads-side-panel').count(), 0, 'the panel closes at phone width too')
  if (process.env.SHOTS) { await p390b.getByTestId('leads-table').scrollIntoViewIfNeeded(); await p390b.screenshot({ path: path.join(process.env.SHOTS, 'leads-table-390.png') }) }
  await ctx390b.close()
  console.log('lead cards UI check passed:', writes.join(', '))
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
