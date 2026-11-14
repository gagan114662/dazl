// #1099 root cause 7: the local matrix runner's measuring code (scripts/matrix-score.mts) and its script. No network, no model:
// stored rows measured as the staging matrix measures them, one real stubbed scan through the runner, and the script's refusals.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { measureCase, verdict, matrixTable, funnelOf, DEFINITIONS, type CaseResult, type MatrixCase, type MatrixThresholds } from '../scripts/matrix-score.mts'
import { runCase, spentUsd, sellerLineFor } from '../scripts/matrix-run.mts'
import { parseEnvFile } from '../scripts/matrix-env.mts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { heldReason } from '../lib/journey.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const T: MatrixThresholds = { ready_leads_min: 10, named_contact_min_pct: 80, dated_source_min_pct: 70, location_category_match_min_pct: 90, per_case_confirm_cap_usd: 0.5 }
const expect = { location_keywords: ['toronto', 'ontario'], category_keywords: ['dental', 'clinic'] }
const NOW = Math.floor(Date.now() / 1000)
const DAY = new Date(Date.now() - 9 * 86_400_000).toISOString().slice(0, 10)

function seed() {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, candidates, created_at) VALUES ('j1', 'A', 'x', '(from request)', '-', 'Dental clinics in Toronto that opened a new location', 'running', 12, ?)").run(NOW)
  const lead = (id: string, o: { company: string; name?: string; contact?: string | null; signal?: string; domain?: string | null; date?: string | null; proof?: string | null; q?: boolean; fit?: number | null }) =>
    db.prepare('INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, company_domain, event_date, event_date_proof, quarantined_at, fit, created_at) VALUES (?, \'j1\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, o.company, o.name ?? '', o.contact ?? null, o.signal ?? 'Dental clinic in Toronto opened a new location', `https://news.example/${id}`, o.domain ?? null, o.date ?? null, o.proof ?? null, o.q ? NOW : null, o.fit ?? null, NOW)
  return { db, lead, enrich: (leadId: string, kind: string, value: string) => db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'sitecrawl', ?, ?, 'https://x.example/team', '2026-11-01', ?)").run(randomBytes(6).toString('hex'), leadId, kind, value, NOW) }
}

test('measureCase: candidates, named, email, dated, place+category are counted from the stored rows; a rejected lead and a poor fit are not', () => {
  const { db, lead, enrich } = seed()
  lead('a', { company: 'Smile Dental', name: 'Dana Lee', contact: 'dana@smile.example', date: DAY, proof: 'page_bound' })     // named, email, dated, in place and category
  lead('b', { company: 'Maple Clinic' })                                                                                                  // nobody named, no email, undated
  lead('c', { company: 'Roof Co', signal: 'Roofing company in Austin hiring' })                                                          // wrong place and category
  lead('d', { company: 'Gone Dental', q: true })                                                                                          // rejected: not counted
  lead('e', { company: 'Weak Dental', fit: 1 })                                                                                           // a poor fit: hidden like on Leads
  enrich('b', 'person', 'Priya Nair')                                                                                                     // a named person from the company's own site counts
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j1'").run()
  const m = measureCase(db, 'A', 'j1', { expect })
  assert.equal(m.candidates, 12); assert.equal(m.leads, 3, 'a, b, c: the rejected and the poor-fit leads are not listed')
  assert.equal(m.named_pct, 67, 'a (own name) and b (site person) of 3')
  assert.equal(m.email_pct, 33); assert.equal(m.dated_pct, 33)
  assert.equal(m.match_pct, 67, 'a and b match the place and category, c does not')
  assert.equal(m.ready, 0, 'none is ready: the product rule needs more than a date (verified date, source checks)')
  assert.ok(Object.keys(m.held).length > 0 && Object.values(m.held).reduce((x, y) => x + y, 0) === 3, 'every company not ready says why, in the product\'s hold words')
})

test('measureCase: the ready count is the product rule (heldReason) and counts a company once, ready winning', () => {
  const { db, lead } = seed()
  lead('a1', { company: 'Smile Dental', domain: 'smile.example' }); lead('a2', { company: 'Smile Dental Inc', domain: 'smile.example' })
  lead('z', { company: 'Zed Clinic' })
  const m = measureCase(db, 'A', 'j1', { expect })
  assert.equal(m.leads, 3)
  assert.equal(Object.values(m.held).reduce((x, y) => x + y, 0) + m.ready, 2, 'a1 and a2 share a domain: two companies, not three')
  // the table's reason words are exactly heldReason's
  for (const why of Object.keys(m.held)) assert.ok(typeof why === 'string' && why.length > 0)
  assert.equal(typeof heldReason, 'function')
})

test('measureCase on an empty or unknown scan: zeros on an empty scan, a clear error on an unknown one', () => {
  const { db } = seed()
  assert.deepEqual({ ...measureCase(db, 'A', 'j1', { expect }), held: {} }, { candidates: 12, leads: 0, ready: 0, named_pct: 0, email_pct: 0, dated_pct: 0, match_pct: 0, held: {} })
  assert.throws(() => measureCase(db, 'B', 'j1', { expect }), /no scan j1 for tenant B/, 'another tenant cannot measure this scan')
})

test('verdict and table: the staging pass rule, the reasons in its words, the same columns', () => {
  const good = { candidates: 30, leads: 14, ready: 12, named_pct: 85, email_pct: 40, dated_pct: 75, match_pct: 95, held: {} }
  assert.deepEqual(verdict(good, T), { pass: true, why: [] })
  const bad = verdict({ ...good, ready: 0, named_pct: 0, dated_pct: 0, match_pct: 0 }, T)
  assert.equal(bad.pass, false); assert.equal(bad.why.length, 4); assert.match(bad.why[0], /^0 ready, needs >=10$/)
  assert.equal(verdict({ ...good, ready: 10, named_pct: 80, dated_pct: 70, match_pct: 90 }, T).pass, true, 'the thresholds are inclusive')
  const rows: CaseResult[] = [
    { id: 'toronto-dental', label: 'x', status: 'done', error: null, seconds: 61, usd: 0.1234, pass: true, why: [], ...good },
    { id: 'berlin-fintech', label: 'y', status: 'INCOMPLETE', error: 'scan_timeout', seconds: 300, usd: null, pass: false, why: ['0 ready, needs >=10'], candidates: 3, leads: 0, ready: 0, named_pct: 0, email_pct: 0, dated_pct: 0, match_pct: 0, held: { 'no verified date': 2 } },
  ]
  const t = matrixTable(rows, T, { commit: 'abc1234', date: '2026-11-14 00:00' })
  assert.match(t, /^MATRIX local @ abc1234 2026-11-14 00:00: 1\/2 PASS/)
  for (const col of ['case', 'cand', 'leads', 'ready', 'named%', 'email%', 'dated%', 'match%', 'secs', 'usd', 'verdict']) assert.ok(t.includes(col), col)
  assert.match(t, /toronto-dental\s+done\s+30\s+14\s+12\s+85\s+40\s+75\s+95\s+61\s+0\.123\s+PASS/)
  assert.match(t, /berlin-fintech: scan_timeout; 0 ready, needs >=10 \| held: no verified date 2/)
  assert.match(t, /\?\s+FAIL/, 'an unmeasured cost prints ?, never 0')
})

// One scan through the real runner with stubbed model and HTTP (the careers-runner-dates pattern): the measuring code reads what the
// pipeline really wrote, including the structured date's proof.
test('a stubbed scan through runJob is measured: its lever-dated lead counts as dated', async () => {
  const master = randomBytes(32)
  const LEVER = 'https://jobs.lever.co/brightloop/abc-123', DESC = 'Brightloop is hiring an Account Executive to own the sales cycle end to end.'
  const http: SafeGet = async url => {
    const u = new URL(url)
    if (u.hostname === 'hn.algolia.com') return null
    if (u.hostname === 'api.lever.co') return { status: 200, body: JSON.stringify({ text: 'Account Executive', descriptionPlain: DESC, createdAt: Date.parse(`${DAY}T09:00:00Z`) }) }
    if (u.hostname === 'brightloop.io' && u.pathname === '/careers') return { status: 200, body: `<html><body><ul><li><a href="${LEVER}">Account Executive</a></li></ul></body></html>` }
    return { status: 404, body: '' }
  }
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migrateConnectors(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const icp = JSON.stringify({ summary: 'x', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] })
  const id = createQueryJob(db, 'A', { query: 'London B2B SaaS startups hiring sales staff', icp, sources: JSON.stringify({ adapters: ['careers'], pages: ['https://brightloop.io'] }) } as never)
  const cand = { name: '', company: 'Brightloop', contact: null, signal: 'hiring an Account Executive', score: 85, source_url: LEVER, excerpt: DESC, event_date: DAY }
  const prov = {
    anthropic: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async (_k: string, p: string) => (p.startsWith('You check one claim') ? 'supports' : JSON.stringify([cand])) },
    openai: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async () => '[]' },
  }
  const page = async () => ({ text: `Account Executive\n${DESC} Apply today.`, title: 'Brightloop jobs', retrievedAt: NOW })
  assert.equal(await runJob(db, claimKeyedJob(db, id)!, { providers: prov as never, master, fetchPage: page as never, sourceHttp: http, crawlGet: async () => null, score: false, now: new Date() }), 'done')
  const m = measureCase(db, 'A', id, { expect: { location_keywords: ['london'], category_keywords: ['sales', 'account executive'] } })
  assert.equal(m.leads, 1); assert.equal(m.dated_pct, 100, 'the board\'s own publish date is a proven day')
  assert.equal(m.named_pct, 0); assert.equal(m.email_pct, 0)
})

test('the script: --dry prints the plan and exits 2 naming the missing keys; a real run without keys is refused before any request', () => {
  const dir = fileURLToPath(new URL('../', import.meta.url))
  const env = { ...process.env, TINYFISH_API_KEY: '', MATRIX_ANTHROPIC_KEY: '', SCOREBOARD_ANTHROPIC_KEY: '', DAZL_TRIAL_ANTHROPIC_KEY: '' } as NodeJS.ProcessEnv; delete env.NODE_TEST_CONTEXT
  const run = (...a: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', 'scripts/matrix-local.mts', ...a], { cwd: dir, env, encoding: 'utf8', timeout: 60000 })
  const matrix = fileURLToPath(new URL('./fixtures/matrix-1099.json', import.meta.url))
  const dry = run('--dry', '--matrix', matrix, '--cases', 'toronto-dental')
  assert.equal(dry.status, 2, dry.stdout + dry.stderr)
  assert.match(dry.stdout, /1 case\(s\).*cap US\$0\.50 each \(total at most US\$0\.50\)/)
  assert.match(dry.stdout, /toronto-dental\s+Dental clinics in Toronto/)
  assert.match(dry.stdout, /TINYFISH_API_KEY MISSING; Anthropic key MISSING/)
  const live = run('--matrix', matrix)
  assert.equal(live.status, 2); assert.match(live.stderr, /No model key/); assert.match(live.stderr, /Not running/)
  // unfenced on purpose: the net fence removes key variables from the environment, and this run must see one. It refuses before any request (no TinyFish key).
  const tf = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/matrix-local.mts', '--matrix', matrix], { cwd: dir, env: { ...env, MATRIX_ANTHROPIC_KEY: 'sk-ant-x' }, encoding: 'utf8', timeout: 60000 })
  assert.equal(tf.status, 2); assert.match(tf.stderr, /TINYFISH_API_KEY is required/)
  assert.equal(run('--matrix', matrix, '--cases', 'nope', '--dry').status, 2, 'an unknown case is refused')
  const high = run('--dry', '--matrix', matrix, '--cap', '9')
  assert.match(high.stdout, /cap US\$0\.50 each/, 'a higher --cap never raises the US$0.50 lane cap')
})

test('measureCase: a company is one company whether or not each lead has the domain (Home\'s domain-or-name merge)', () => {
  const { db, lead } = seed()
  lead('a1', { company: 'Smile Dental', domain: 'smile.example' }); lead('a2', { company: 'Smile Dental' })   // the same name, one with a domain and one without
  const m = measureCase(db, 'A', 'j1', { expect })
  assert.equal(m.leads, 2)
  assert.equal(m.ready + Object.values(m.held).reduce((x, y) => x + y, 0), 1, 'one company, not two')
})

test('spentUsd: a call the cap refused is not spend; settled calls at their reported cost, reserved at their worst case', () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at) VALUES ('j9', 'A', 'x', '-', '-', 'q', 'running', ?)").run(NOW)
  const call = (id: string, reserve: number, actual: number | null, status: string) => db.prepare("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, created_at) VALUES (?, 'A', 'j9', 1, 'llm', ?, ?, ?, ?)").run(id, reserve, actual, status, NOW)
  call('c1', 0.2, 0.05, 'settled'); call('c2', 0.1, null, 'reserved'); call('c3', 0.4, null, 'refused')
  assert.equal(spentUsd(db, 'j9'), 0.15, '0.05 settled + 0.10 reserved; the refused 0.40 was never sent')
  assert.equal(spentUsd(db, 'nope'), 0)
})

test('runCase: the case runs under its own run budget (max_usd) and the staging seller line; a hung run is INCOMPLETE, stopped, and cannot pass', async () => {
  const master = randomBytes(32)
  const db = new Database(':memory:'); migrateAllSqlite(db); saveKey(db, 'matrix-x', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const logged: string[] = []; const err = console.error; console.error = (...a: unknown[]) => { logged.push(a.join(' ')) }
  const c: MatrixCase = { id: 'x', label: 'x', seller: 'ChairSide', offer: 'Online booking for dental clinics', query: 'Dental clinics in Toronto that opened a new location', expect }
  const hang = new Promise<string>(() => {})
  const providers = { anthropic: { research: () => hang, complete: () => hang }, openai: { research: () => hang, complete: () => hang } }
  let r: CaseResult
  try { r = await runCase(db, c, { tenant: 'matrix-x', cap: 0.5, timeoutS: 0.3, thresholds: T, deps: { providers: providers as never, master, sourceHttp: (() => hang) as never, newsHttp: (() => hang) as never, crawlGet: (() => hang) as never, score: false } }) } finally { console.error = err }
  const row = db.prepare('SELECT run_budget, seller, status, error FROM scan_jobs WHERE user_id = ?').get('matrix-x') as { run_budget: string; seller: string; status: string; error: string | null }
  assert.deepEqual(JSON.parse(row.run_budget), { max_usd: 0.5 }, 'the case\'s own US$0.50 budget is on the job row')
  assert.equal(row.seller, 'Online booking for dental clinics'); assert.equal(sellerLineFor(c), row.seller)
  assert.equal(r.error, 'scan_timeout', JSON.stringify(r)); assert.equal(r.status, 'INCOMPLETE'); assert.equal(r.pass, false)
  assert.equal(row.status, 'failed', 'the abandoned run is stopped: later paid reservations are refused')
  assert.ok(r.usd !== null && r.usd <= 0.5, 'the printed US$ stays under the cap')
  assert.deepEqual(logged.filter(l => /no such table/i.test(l)), [], 'no pipeline step fails on a missing table: the store has every table the app\'s has')
})

test('the env file: quotes, inline comments, = in values, export; an empty shell value does not block it', () => {
  const e = parseEnvFile(['# a comment', 'TINYFISH_API_KEY="abc" # staging', "MATRIX_ANTHROPIC_KEY='sk-ant-x=y'", 'export SITECRAWL_ENABLED=1', 'NEWS_SEARCH_ENABLED=0   # off', '', 'BAD LINE', 'EMAIL_GUESS_ENABLED=', '  TINYFISH_FETCHES_PER_SCAN = 40  '].join('\n'))
  assert.deepEqual(e, { TINYFISH_API_KEY: 'abc', MATRIX_ANTHROPIC_KEY: 'sk-ant-x=y', SITECRAWL_ENABLED: '1', NEWS_SEARCH_ENABLED: '0', EMAIL_GUESS_ENABLED: '', TINYFISH_FETCHES_PER_SCAN: '40' })
})

test('the table prints its definitions, and the script refuses a bad cap or timeout', () => {
  const t = matrixTable([], T, { commit: 'x', date: 'y' })
  for (const d of DEFINITIONS) assert.ok(t.includes(d))
  assert.match(t, /usd: settled model and paid-vendor calls/); assert.match(t, /icp: inferred by the runner/)
  const dir = fileURLToPath(new URL('../', import.meta.url))
  const matrix = fileURLToPath(new URL('./fixtures/matrix-1099.json', import.meta.url))
  const run = (...a: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', 'scripts/matrix-local.mts', '--matrix', matrix, '--dry', ...a], { cwd: dir, env: { ...process.env, TINYFISH_API_KEY: '', MATRIX_ANTHROPIC_KEY: '' } as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 60000 })
  assert.match(run('--timeout', 'x').stderr, /--timeout must be a number of seconds above 0/)
  assert.match(run('--timeout', '0').stderr, /--timeout must be a number/)
  assert.match(run('--cap', '-1').stderr, /per-case cap must be a number above 0/)
  assert.match(run('--cap', 'abc').stderr, /per-case cap must be a number above 0/)
})

test('funnelOf: where the candidates went, read from the scan\'s run report; no report is null, never a zero', () => {
  const { db } = seed()
  assert.equal(funnelOf(db, 'j1'), null, 'no report recorded')
  const report = { v: 1, queries: ['q1', 'q2', 'q3'], query_source: 'model', search: { attempted: 3, ok: 2, hits_raw: 20, hits_unique_urls: 14, hits_complete: true },
    urls: [{ url: 'https://a.example', selected: true, walled: false }, { url: 'https://b.example', selected: true, walled: true }, { url: 'https://c.example', selected: false, walled: false }],
    evidence: { items: 5, with_page_text: 2, snippet_only: 3 }, extracted_candidates: 6, stop: null,
    candidates: [{ company: 'Smile Dental', url: 'https://a.example', outcome: 'review', reason: 'quote_unconfirmed' }],
    funnel: { candidates: 6, verified: 0, needs_review: 3, dropped: 3, review_reasons: { quote_unconfirmed: 3 }, drop_reasons: { blocked_by_site: 2, not_found: 1 }, verifier_drop_counts: { blocked: 2 } } }
  db.prepare('INSERT INTO scan_run_report (job_id, attempt, report) VALUES (?, ?, ?)').run('j1', 1, JSON.stringify(report))
  const f = funnelOf(db, 'j1')!
  assert.deepEqual({ q: f.queries, s: f.searches_ok, u: f.hits_unique_urls, sel: f.selected, w: f.walled, ev: f.evidence_items, txt: f.with_page_text, x: f.extracted, v: f.verified, r: f.needs_review, d: f.dropped },
    { q: 3, s: '2/3', u: 14, sel: 2, w: 1, ev: 5, txt: 2, x: 6, v: 0, r: 3, d: 3 })
  assert.deepEqual(f.drop_reasons, { blocked_by_site: 2, not_found: 1 }); assert.equal(f.candidates[0].reason, 'quote_unconfirmed')
  const row: CaseResult = { id: 'toronto-dental', label: 'x', status: 'done', error: null, seconds: 60, usd: 0.03, pass: false, why: ['0 ready, needs >=10'], candidates: 6, leads: 3, ready: 0, named_pct: 0, email_pct: 0, dated_pct: 0, match_pct: 100, held: {}, funnel: f }
  const t = matrixTable([row, { ...row, id: 'x2', funnel: null }], T, { commit: 'x', date: 'y' })
  assert.match(t, /toronto-dental: 3 queries \(model\); search ok 2\/3, 14 unique urls, 2 selected, 1 walled; evidence 5 \(2 with page text\); extracted 6 -> verified 0, review 3, dropped 3/)
  assert.match(t, /review: quote_unconfirmed 3 \| drops: blocked_by_site 2, not_found 1 \| verifier: blocked 2/)
  assert.match(t, /x2: run report not recorded/)
})
