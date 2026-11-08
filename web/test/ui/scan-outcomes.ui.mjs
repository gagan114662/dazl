// Rendered check for scan outcomes in scan history (Leads "Past scans"), Home ("Your plays") and the campaign page.
// NOT part of `npm test`. Run:  cd web && npm run build && node test/ui/scan-outcomes.ui.mjs   (SHOTS=<dir> saves screenshots;
// BEFORE_ONLY=1 only takes the screenshots, for a build without this change).
// Real production build, throwaway database, server under test/helpers/net-fence.ts, and EVERY /api/* CALL ANSWERED
// FROM A STUB in the browser: no scan runs, nothing is drafted or sent. Off-host requests are aborted. It proves:
//   1. a failed scan, a none-extracted scan (never called "no matches"; the recorded diagnostic kept, so pages read but
//      nothing extracted differs from no search hits), an all-dropped scan, a budget stop, an older scan without
//      counts, an interrupted enrichment and a rejected key (known free-search key vs. neutral otherwise) each read as
//      their own outcome in Past scans, each with one next-step link;
//   2. the campaign page shows the same outcome, next step and diagnostic, including a scan still enriching (#254);
//   3. Home's plays use short words for the same outcomes (key rejections worded the same way);
//   4. nothing is written.
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import { createRequire } from 'node:module'
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
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-scanoutcomes-')); const DB = path.join(tmp, 'app.db'); const db = new Database(DB)
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch())); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('u1','s@example.test','x','y')").run()
const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'u1', Math.floor(Date.now() / 1000) + 3600); db.close()
const port = pickUiPort(); const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }

const J = c => c.repeat(24)
const job = (id, query, o) => ({ id: J(id), query, business_name: '', csv_domain: null, created_at: 1761500000, finished_at: 1761500100, error: null, funded_by: 'user', candidates: null, verified: null, needs_review: null, dropped: null, enrich_started_at: null, enrich_finished_at: null, lead_count: 0, test_only: false, empty_reason: null, ...o })
// Diagnostics exactly as the server writes them (lib/scan/extraction-note.ts emptyExtractionReason).
const NO_HITS = 'The search returned 0 results; dazl asked to read 0 pages and read 0. The extraction step was given 0 items and returned 0 candidates. That is what is known: it does not show that no matching companies exist. Try rewording the request or widening the place or window.'
const READ_NONE = 'The search returned 8 results; dazl asked to read 5 pages and read 4 (1 page could not be read). The extraction step was given 6 items (4 page texts, 2 search snippets) and returned 0 candidates. That is what is known: it does not show that no matching companies exist. Try rewording the request or widening the place or window.'
const STALE = Math.floor(Date.now() / 1000) - 3600
const ALL = {
  leads: job('a', 'Dentists in Ohio opening a second location', { status: 'done', candidates: 9, verified: 4, needs_review: 1, dropped: 2, lead_count: 5 }),
  dropped: job('b', 'Roofers in Texas hiring estimators', { status: 'done', candidates: 6, verified: 0, needs_review: 0, dropped: 6 }),
  readNone: job('c', 'Breweries in Maine that just raised a round', { status: 'failed', error: 'no_candidates', candidates: 0, empty_reason: READ_NONE }),
  noHits: job('1', 'Lighthouse keepers in Kansas', { status: 'failed', error: 'no_candidates', candidates: 0, empty_reason: NO_HITS }),
  budget: job('d', 'Law firms in Denver moving offices', { status: 'failed', error: 'budget_stopped', stop_refusal_reason: 'over_limit' }),
  // A legacy budget_stopped row kept no reason: neutral words, never a budget-cause claim or budget-change advice.
  legacyBudget: job('j', 'Roofers in Boise', { status: 'failed', error: 'budget_stopped', stop_refusal_reason: null }),
  poolStop: job('k', 'Dentists in Akron', { status: 'failed', error: 'budget_stopped', stop_refusal_reason: 'owner_pool_limit' }),
  hardCap: job('m', 'Plumbers in Reno', { status: 'failed', error: 'budget_stopped', stop_refusal_reason: 'over_cap' }),
  failed: job('e', 'Gyms in Austin switching software', { status: 'failed', error: 'upstream 502' }),
  old: job('f', 'Cafes in Leeds', { status: 'done' }),
  ownKey: job('7', 'Florists in Bristol', { status: 'failed', error: 'key_rejected', funded_by: 'user' }),
  trialKey: job('8', 'Bakeries in Porto', { status: 'failed', error: 'key_rejected', funded_by: 'trial' }),
  unknownKey: job('9', 'Tailors in Lyon', { status: 'failed', error: 'key_rejected', funded_by: null }),
  enriching: job('2', 'Vets in Cork adding a clinic', { status: 'enriching', candidates: 5, verified: 2, needs_review: 0, dropped: 3, lead_count: 2 }),
  interrupted: job('3', 'Opticians in Bath hiring', { status: 'done', candidates: 5, verified: 2, needs_review: 0, dropped: 3, lead_count: 2, enrich_started_at: STALE }),
  // Stop-class contract: a source failure with the fallback held is never a budget stop, an in-scope empty search
  // never claims nothing exists, and an unbounded paid fallback hold names itself. Copy from lib/scan/scan-outcome.ts.
  sourceErr: job('g', 'Plumbers in Reno expanding crews', { status: 'failed', error: 'source_error', failed_sources: ['News'] }),
  noDisc: job('h', 'Bookbinders in Ghent', { status: 'failed', error: 'no_discovery' }),
  holdErr: job('i', 'Chandlers in York', { status: 'failed', error: 'unbounded_fallback_hold' }),
}
let JOBS = Object.values(ALL)
const writes = []
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 1100 } })
await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
await ctx.route('**/*', async route => {
  const req = route.request(); const u = new URL(req.url()); const m = req.method()
  if (u.origin !== base) return route.abort()
  if (!u.pathname.startsWith('/api/')) return route.continue()
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (m !== 'GET') writes.push(`${m} ${u.pathname}`)
  if (u.pathname === '/api/scan/jobs') return json({ jobs: JOBS })
  // Single-scan status read (deep link): the failed source-error scan also carries the QA-shaped cost state - one
  // model call recorded with reported tokens but no settleable USD, plus a spend-cap reservation. The summary string
  // is exactly what compareActual (lib/scan/price-estimate.ts) produces for that input: unknown cost is named
  // unknown (never $0/free) and the reservation is named a reservation (never an invoice or a settled charge).
  if (u.pathname === '/api/scan/status') {
    const id = u.searchParams.get('job_id')
    // The QA truth (job 70a6111e): the served id claude-sonnet-4-5-20250929 is a KNOWN dated model - priceOf strips the
    // date, so 368in/74out prices to $0.002214, never "no listed price". The cap reservation is named as itself.
    if (id === ALL.sourceErr.id) return json({ status: 'failed', error: 'source_error', provider_issues: [], cost: { estimate: { total: { min: 0.001, max: 0.01 } }, actual: { summary: "Actual model cost at least $0.0022 from the tokens the provider reported; cache token usage was not recorded, so this is the recorded-token component, not the full cost, against an estimate of $0.00-$0.01. Not an invoice. Reserved under this run's spend cap: $0.01 (a reservation, not a settled charge).", model_usd: 0.002214, model_usd_complete: false, cap_reserved_usd: 0.012504, within: 'unknown' } } })
    // The genuinely-unlisted case separately: recorded calls, no priced model -> honestly unknown, never $0.
    if (id === ALL.holdErr.id) return json({ status: 'failed', error: 'unbounded_fallback_hold', provider_issues: [], cost: { estimate: { total: { min: 0.001, max: 0.01 } }, actual: { summary: '1 model call recorded (368 input / 74 output tokens), but no USD cost could be settled (the served model has no listed price) - the actual cost is unknown, not $0. Estimate was $0.00-$0.01.', model_usd: null, within: 'unknown' } } })
    if (id === ALL.noDisc.id) return json({ status: 'failed', error: 'no_discovery', provider_issues: [] })
    if (id === ALL.budget.id) return json({ status: 'failed', error: 'budget_stopped', provider_issues: [], stop_refusal_reason: 'over_limit' })
    if (id === ALL.legacyBudget.id) return json({ status: 'failed', error: 'budget_stopped', provider_issues: [], stop_refusal_reason: null })
    if (id === ALL.poolStop.id) return json({ status: 'failed', error: 'budget_stopped', provider_issues: [], stop_refusal_reason: 'owner_pool_limit' })
    if (id === ALL.hardCap.id) return json({ status: 'failed', error: 'budget_stopped', provider_issues: [], stop_refusal_reason: 'over_cap' })
  }
  const one = Object.values(ALL).find(j => u.pathname === `/api/campaigns/${j.id}`)
  // The campaign read: stored status (never 'enriching') plus the enrichment marks, and the server's empty_reason.
  if (one) return json({ job: { id: one.id, query: one.query, status: one.status === 'enriching' ? 'done' : one.status, error: one.error, funded_by: one.funded_by, created_at: one.created_at, candidates: one.candidates, verified: one.verified, needs_review: one.needs_review, dropped: one.dropped, enrich_started_at: one.status === 'enriching' ? Math.floor(Date.now() / 1000) - 20 : one.enrich_started_at, enrich_finished_at: null, empty_reason: one.empty_reason, failed_sources: one.failed_sources ?? null, stop_refusal_reason: one.stop_refusal_reason ?? null }, leads: [], messages: [] })
  return json({}, 404)
})
const page = await ctx.newPage()
const shot = async name => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`), fullPage: true }) }
const before = process.env.BEFORE_ONLY === '1'
const EXPECT = {
  leads: ['leads', /9 found: 4 source-checked, 1 needs your review, 2 dropped/, null, null],
  dropped: ['all_dropped', /6 found, all dropped by the checks/, 'See why they were dropped', `/app/leads?job_id=${J('b')}`],
  readNone: ['none_extracted', /No candidates were extracted/, 'See what the scan read', `/app/leads?job_id=${J('c')}`],
  noHits: ['none_extracted', /No candidates were extracted/, 'See what the scan read', `/app/leads?job_id=${J('1')}`],
  budget: ['stopped', /Stopped by its budget - not an empty search/, 'Run it again with a larger budget', '/app/leads'],
  failed: ['failed', /Failed/, 'Try again', '/app/leads'],
  old: ['unrecorded', /did not record whether nothing matched or everything was dropped/, 'Run the search again', '/app/leads'],
  // The jobs read never reports 'user' (it is the column default, not proof); even if it did, the wording stays neutral.
  ownKey: ['failed', /Failed - the AI provider rejected the key this scan used/, 'Check your AI key in Settings', '/app/settings'],
  trialKey: ['failed', /Failed - the free-search key had trouble \(not your key\)/, 'Try again later', '/app/leads'],
  unknownKey: ['failed', /Failed - the AI provider rejected the key this scan used/, 'Check your AI key in Settings', '/app/settings'],
  enriching: ['enriching', /Finishing - finding contacts and checking fit/, null, null],
  interrupted: ['leads', /5 found: 2 source-checked, 0 need your review, 3 dropped; contacts and fit checks did not finish/, null, null],
  sourceErr: ['failed', /Failed - News had an error/, 'Try again', '/app/leads'],
  noDisc: ['stopped', /Nothing found in the sources this run could use/, 'Run a broader search', '/app/leads'],
  holdErr: ['stopped', /Stopped - the free sources could not conclude/, 'Try again', '/app/leads'],
  legacyBudget: ['stopped', /Stopped before it could conclude/, 'Run the search again', '/app/leads'],
  poolStop: ['stopped', /Stopped by the shared account spending limit - not an empty search/, 'Try again later', '/app/leads'],
  hardCap: ['stopped', /Stopped by its spending cap - not an empty search/, 'View search options', '/app/leads'],
}
try {
  // An enriching scan is the active one (#254): Leads opens its progress instead of the history, so the history is
  // checked without it and the enriching outcome is checked on the campaign page and Home.
  JOBS = Object.values(ALL).filter(j => j !== ALL.enriching)
  await page.goto(`${base}/app/leads`, { waitUntil: 'networkidle' })
  await page.getByText('Past scans').waitFor({ timeout: 15000 })
  await page.getByText('Past scans').scrollIntoViewIfNeeded()
  await shot('history')
  if (!before) {
    const rows = await page.getByTestId('past-scan').evaluateAll(els => els.map(e => ({ q: e.querySelector('[data-testid=past-scan-title]')?.textContent.trim(), kind: e.dataset.outcome, text: e.textContent, detail: e.querySelector('[data-testid=outcome-detail]')?.textContent ?? null, next: e.querySelector('[data-testid=next-step]')?.textContent ?? null, href: e.querySelector('[data-testid=next-step]')?.getAttribute('href') ?? null })))
    for (const [k, [kind, label, next, href]] of Object.entries(EXPECT)) {
      if (k === 'enriching') continue
      const r = rows.find(x => x.q === ALL[k].query); assert.ok(r, k)
      assert.equal(r.kind, kind, k); assert.match(r.text, label, k); assert.equal(r.next, next, k); assert.equal(r.href, href, k)
    }
    const row = k => rows.find(x => x.q === ALL[k].query)
    assert.equal(row('readNone').detail, READ_NONE, 'the recorded diagnostic is kept: pages were read, nothing extracted')
    assert.equal(row('noHits').detail, NO_HITS, 'truly no search hits reads differently')
    assert.doesNotMatch(rows.map(r => r.text).join(' '), /No matches|scan service had trouble|found no companies|rejected your key/)
  }
  // Campaign page: same outcome, next step and diagnostic, from the campaign read.
  for (const k of ['dropped', 'readNone', 'noHits', 'ownKey', 'trialKey', 'unknownKey', 'enriching', 'interrupted', 'sourceErr', 'noDisc', 'holdErr', 'budget', 'legacyBudget', 'poolStop', 'hardCap']) {
    await page.goto(`${base}/app/campaigns/${ALL[k].id}`, { waitUntil: 'networkidle' })
    const st = page.getByTestId('campaign-status'); await st.waitFor({ timeout: 15000 })
    if (['dropped', 'readNone', 'ownKey'].includes(k)) await shot(`campaign-${k}`)
    if (before) continue
    const [kind, label, next, href] = EXPECT[k]
    assert.equal(await st.getAttribute('data-outcome'), kind, k)
    assert.match(await st.textContent(), label, k)
    if (next) { assert.equal(await st.getByTestId('next-step').textContent(), next, k); assert.equal(await st.getByTestId('next-step').getAttribute('href'), href, k) } else assert.equal(await st.getByTestId('next-step').count(), 0, k)
    if (k === 'readNone' || k === 'noHits') assert.equal(await st.getByTestId('outcome-detail').textContent(), ALL[k].empty_reason, k)
  }
  // Home: short words for the same outcomes, newest five plays at a time.
  const home = async (keys, words) => {
    JOBS = keys.map(k => ALL[k])
    await page.goto(`${base}/app`, { waitUntil: 'networkidle' })
    await page.getByTestId('setup-details').evaluate(d => { d.open = true }, null, { timeout: 15000 }) // "Your plays" is secondary, under Setup details
    await page.getByTestId('play-campaign-link').first().waitFor({ timeout: 15000 })
    if (!before) for (const t of words) await page.locator('main').getByRole('link', { name: t, exact: true }).first().waitFor({ timeout: 5000 })
  }
  await home(['readNone', 'budget', 'dropped', 'failed', 'interrupted'], ['no candidates extracted', 'stopped', '6 found, all dropped by the checks', 'failed', '2 source-checked, 0 need your review'])
  await page.getByTestId('play-campaign-link').first().scrollIntoViewIfNeeded()
  await shot('home-plays')
  await home(['ownKey', 'trialKey', 'unknownKey', 'enriching', 'noHits'], ['failed: AI key rejected', 'failed: free-search key trouble', 'failed: AI key rejected', 'finishing', 'no candidates extracted'])
  await page.getByTestId('play-campaign-link').first().scrollIntoViewIfNeeded()
  await shot('home-plays-keys')
  // Home short words for the stop classes (lib/readiness.ts outcomeOf over scanOutcome): source error is 'failed',
  // in-scope-empty and the unbounded fallback hold are 'stopped' - never 'stopped by budget' words.
  await home(['sourceErr', 'noDisc', 'holdErr', 'legacyBudget', 'poolStop', 'hardCap'], ['failed', 'stopped'])
  await page.getByTestId('play-campaign-link').first().scrollIntoViewIfNeeded()
  await shot('home-plays-stop-classes')
  // Deep links: the long per-class copy (leads-client.tsx) and the cost states. sourceErr carries the QA-shaped
  // unsettled cost plus the spend-cap reservation; holdErr/noDisc have no cost record, so no cost line renders.
  await page.goto(`${base}/app/leads?job_id=${ALL.sourceErr.id}`, { waitUntil: 'networkidle' })
  const costEl = page.getByTestId('scan-cost'); await costEl.waitFor({ timeout: 15000 })
  await page.getByText(/A source this run depends on failed, so the run stopped before it could conclude/).waitFor({ timeout: 15000 })
  await shot('deep-source-error-cost')
  if (!before) {
    assert.equal(await costEl.getAttribute('data-within'), 'unknown', 'cache usage is not stored: the component is never placed in the range')
    assert.equal((await costEl.textContent()).trim(), "Estimated $0.00 - $0.01 at start. Actual model cost at least $0.0022 from the tokens the provider reported; cache token usage was not recorded, so this is the recorded-token component, not the full cost, against an estimate of $0.00-$0.01. Not an invoice. Reserved under this run's spend cap: $0.01 (a reservation, not a settled charge).", 'the QA cost truth, verbatim: priced dated model as at-least component, cache unknown, reservation named as itself')
    await page.goto(`${base}/app/leads?job_id=${ALL.holdErr.id}`, { waitUntil: 'networkidle' })
    await page.getByText(/the broader paid research step has no price bound, so the run stopped instead of starting it/).waitFor({ timeout: 15000 })
    const holdCost = page.getByTestId('scan-cost')
    assert.equal(await holdCost.getAttribute('data-within'), 'unknown', 'a genuinely unlisted model stays unknown')
    assert.match((await holdCost.textContent()) ?? '', /no listed price.*unknown, not \$0/s, 'unknown is named, never $0')
    await shot('deep-unbounded-hold')
    await page.goto(`${base}/app/leads?job_id=${ALL.noDisc.id}`, { waitUntil: 'networkidle' })
    await page.getByText(/The sources this run was allowed to use searched and found nothing, and broader paid research was out of scope/).waitFor({ timeout: 15000 })
    await shot('deep-no-discovery')
    // Legacy vs typed budget stops in the long copy: typed over_limit names the per-run control; legacy stays neutral.
    await page.goto(`${base}/app/leads?job_id=${ALL.budget.id}`, { waitUntil: 'networkidle' })
    await page.getByText(/its per-run budget refused the next paid step/).waitFor({ timeout: 15000 })
    await page.goto(`${base}/app/leads?job_id=${ALL.legacyBudget.id}`, { waitUntil: 'networkidle' })
    await page.getByText(/recorded as a budget stop, but its exact reason was not kept/).waitFor({ timeout: 15000 })
    await shot('deep-legacy-budget-neutral')
    await page.goto(`${base}/app/leads?job_id=${ALL.poolStop.id}`, { waitUntil: 'networkidle' })
    await page.getByText(/shared account spending limit \(its day\/month pool\) refused the next paid step/).waitFor({ timeout: 15000 })
    await shot('deep-pool-limit')
    await page.goto(`${base}/app/leads?job_id=${ALL.hardCap.id}`, { waitUntil: 'networkidle' })
    await page.getByText(/recorded spending cap refused the next paid step/).waitFor({ timeout: 15000 })
    await shot('deep-hard-cap')
  }
  assert.deepEqual(writes, [], 'loading writes nothing')
  console.log(before ? 'screenshots taken (BEFORE_ONLY)' : 'scan outcomes UI check passed: failed, none-extracted (read-but-none vs no hits, diagnostic kept), all-dropped, stopped, unrecorded, enriching/interrupted and key-rejected (own/trial/unknown) scans are distinct in Past scans, on the campaign page and on Home, each with one next step; the stop classes (source error, in-scope empty, unbounded fallback hold) read as themselves in all three views, never as budget stops; the deep-link cost line names an unsettled known-call cost as unknown (never $0) and a spend-cap reservation as a reservation (never an invoice); no writes')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
