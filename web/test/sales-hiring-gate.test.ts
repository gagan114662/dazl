// "Seed funding AND hiring sales": the funding quote alone no longer carries a lead. A dated sales / GTM posting on a public Greenhouse /
// Lever / Ashby board bound to the lead's own domain (or the source quote itself naming the hiring) keeps it; otherwise it goes to review as
// `no_sales_hiring_evidence`. Stubbed board JSON, invented companies, no network. The quote / date / identity gates are untouched.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { applySalesHiringGate, salesHiringRequired, quoteNamesSalesHiring } from '../lib/scan/sales-hiring-gate.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, enrichmentsForLeads } from '../lib/connectors/store.ts'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'

// CI runs with SITECRAWL_ENABLED=0 (npm test). The runJob fixtures below need their STUBBED crawl (an injected crawlGet, no network) to establish the lead's domain,
// so the crawl is switched on for the duration of one fixture run only and restored; the domain gate itself is unchanged.
async function runCrawl(f: Fixture) {
  const saved = process.env.SITECRAWL_ENABLED; process.env.SITECRAWL_ENABLED = '1'
  try { return await runFixture(f) } finally { if (saved === undefined) delete process.env.SITECRAWL_ENABLED; else process.env.SITECRAWL_ENABLED = saved }
}
const NOW = Date.parse('2026-10-28T12:00:00Z')
const d = (n: number) => new Date(NOW - n * 86_400_000).toISOString()
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
const no = () => new Response('nope', { status: 404 })
const GH = 'https://boards-api.greenhouse.io/v1/boards/brightloop'
const board = (over: Record<string, unknown> = {}) => ({
  [`${GH}/jobs`]: { jobs: [{ id: 1, title: 'Account Executive' }] },
  [`${GH}/jobs/1`]: { id: 1, title: 'Account Executive', first_published: d(12), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/1', location: { name: 'London, UK' }, content: '&lt;p&gt;Brightloop is hiring. Write to jobs@brightloop.io&lt;/p&gt;' },
  ...over,
})
const serve = (m: Record<string, unknown>, seen: string[] = []) => (async (u: RequestInfo | URL) => { seen.push(String(u)); return m[String(u)] ? ok(m[String(u)]) : no() }) as never

const REQUEST = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days and are hiring sales staff.'
const ICP = JSON.stringify({ summary: 's', where: ['London, UK'], who: ['Founder'], signals: ['announced seed funding', 'hiring sales staff'], exclude: [] })
const QUOTE = 'Brightloop, a London B2B SaaS startup, raised a 3m GBP seed round this month'

function seed(over: { extra?: number; domain?: string | null; excerpt?: string; query?: string; icp?: string; basis?: string | null } = {}) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', query = ?, icp = ? WHERE id = ?").run(over.query ?? REQUEST, over.icp ?? ICP, jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, confidence, score, why, event_date, date_status) VALUES ('L1', ?, '', 'Brightloop', ?, 'raised a seed round', 'https://news.example/1', ?, 80, 80, 'Seed-funded London SaaS.', ?, 'unverified')")
    .run(jobId, over.domain === undefined ? 'brightloop.io' : over.domain, over.excerpt ?? QUOTE, d(12).slice(0, 10))
  const basis = over.basis === undefined ? 'evidence_own_domain' : over.basis   // how the crawl chose the lead's domain (own = the cited page is hosted on it)
  if (basis && (over.domain === undefined || over.domain)) db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('D1', 'L1', 'u1', 'sitecrawl', 'domain', ?, 'x', NULL, 'https://brightloop.io/', '2026-10-28', 1)").run(`${over.domain ?? 'brightloop.io'}|${basis}`)
  for (let i = 2; i <= 1 + (over.extra ?? 0); i++) db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, confidence, score, why, event_date, date_status) VALUES (?, ?, '', ?, 'brightloop.io', 'raised a seed round', 'https://news.example/1', ?, 80, ?, 'Seed-funded.', ?, 'verified')").run(`L${i}`, jobId, `Brightloop${i}`, `Brightloop${i} raised a seed round in London`, 80 - i, d(12).slice(0, 10))
  db.prepare("UPDATE scan_jobs SET status = 'done', verified = ?, needs_review = 0 WHERE id = ?").run(1 + (over.extra ?? 0), jobId)
  return { db, job: { id: jobId, user_id: 'u1', query: over.query ?? REQUEST, icp: over.icp ?? ICP } }
}
const lead = (db: Database.Database) => db.prepare("SELECT review_reason, confidence, why FROM leads WHERE id = 'L1'").get() as { review_reason: string | null; confidence: number | null; why: string }
const counts = (db: Database.Database) => db.prepare('SELECT verified, needs_review FROM scan_jobs').get() as { verified: number; needs_review: number }

test('when is the sales-hiring proof required: only seed/event + sales hiring requests; seed-only and hiring-only are untouched', () => {
  assert.equal(salesHiringRequired(REQUEST, ICP), true)
  assert.equal(salesHiringRequired('Find London UK startups that announced seed funding within the past 90 days.', JSON.stringify({ signals: ['announced seed funding'] })), false, 'seed only')
  assert.equal(salesHiringRequired('Find London UK companies hiring sales account executives.', JSON.stringify({ signals: ['hiring sales account executives'] })), false, 'hiring only')
  assert.equal(salesHiringRequired('Find dental practices that opened a new location or posted a front desk receptionist job', JSON.stringify({ signals: ['opened a new location', 'posted a receptionist job'] })), false, 'not a sales role')
  assert.equal(salesHiringRequired(null, null), false)
  assert.equal(quoteNamesSalesHiring('Brightloop raised a seed round and is hiring two account executives.', null), true)
  assert.equal(quoteNamesSalesHiring(QUOTE, 'raised a seed round'), false)
})

test('PASS: a dated sales posting on a Greenhouse board bound to the lead’s domain keeps it verified; the card why names the role and posting date', async () => {
  const { db, job } = seed()
  const r = await applySalesHiringGate(db, job, serve(board()), { now: NOW })
  assert.deepEqual([r.required, r.checked, r.passed, r.demoted], [true, 1, 1, 0])
  const l = lead(db); assert.equal(l.review_reason, null); assert.equal(l.confidence, 80)
  assert.match(l.why, new RegExp(`^Hiring sales: Account Executive posted ${d(12).slice(0, 10)} on its Greenhouse job board \\(brightloop\\.io\\)\\. Seed-funded`))
  assert.deepEqual(counts(db), { verified: 1, needs_review: 0 })
  const e = (enrichmentsForLeads(db, 'u1', ['L1']).L1 ?? []).filter(x => x.kind === 'hiring'); assert.equal(e.length, 1); assert.equal(e[0].source_date, d(12).slice(0, 10))
})

test('PASS (source): the saved quote itself names the sales hiring, so no board lookup is made', async () => {
  const seen: string[] = []
  const { db, job } = seed({ excerpt: 'Brightloop raised a seed round and is hiring two account executives to build its sales team' })
  const r = await applySalesHiringGate(db, job, serve({}, seen), { now: NOW })
  assert.equal(r.passed, 1); assert.equal(seen.length, 0); assert.equal(lead(db).review_reason, null)
})

test('STALE: a sales posting older than the 90-day window is not evidence; the lead goes to review as no_sales_hiring_evidence', async () => {
  const { db, job } = seed()
  const stale = board({ [`${GH}/jobs/1`]: { id: 1, title: 'Account Executive', first_published: d(200), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/1', content: 'x' } })
  const r = await applySalesHiringGate(db, job, serve(stale), { now: NOW })
  assert.deepEqual([r.passed, r.demoted], [0, 1])
  const l = lead(db); assert.equal(l.review_reason, 'no_sales_hiring_evidence'); assert.equal(l.confidence, null)
  assert.match(l.why, /^No sales-hiring evidence: no sales or GTM posting dated in the last 90 days was found on a public job board tied to brightloop\.io \(a board that could not be reached looks the same as none/)
  assert.deepEqual(counts(db), { verified: 0, needs_review: 1 })
})

test('WRONG DOMAIN: a board whose postings name another company’s site (brightloop.com) is refused, not used', async () => {
  const { db, job } = seed()
  const wrong = board({ [`${GH}/jobs/1`]: { id: 1, title: 'Account Executive', first_published: d(12), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/1', content: '&lt;p&gt;Write to jobs@brightloop.com&lt;/p&gt;' } })
  const r = await applySalesHiringGate(db, job, serve(wrong), { now: NOW })
  assert.equal(r.demoted, 1); assert.equal(lead(db).review_reason, 'no_sales_hiring_evidence')
})

test('NO BOARD / NO DOMAIN: nothing found is a distinct outcome, not a silent pass; without a confirmed domain no board is even tried', async () => {
  const a = seed(); await applySalesHiringGate(a.db, a.job, serve({}), { now: NOW })
  assert.equal(lead(a.db).review_reason, 'no_sales_hiring_evidence')
  const seen: string[] = []; const b = seed({ domain: null })
  await applySalesHiringGate(b.db, b.job, serve(board(), seen), { now: NOW })
  assert.equal(lead(b.db).review_reason, 'no_sales_hiring_evidence'); assert.equal(seen.length, 0, 'no domain: no board lookup')
  assert.match(lead(b.db).why, /a confirmed company domain \(none found\)/)
})

test('JUICEBOX-TYPE: a perfect board under a domain matched only by company NAME (probe / link) is NOT this lead\u2019s hiring: no_sales_hiring_evidence, not a pass', async () => {
  for (const basis of ['name_probe', 'evidence_link_text', 'evidence_link_domain_label', null]) {
    const { db, job } = seed({ basis })
    const r = await applySalesHiringGate(db, job, serve(board({ [`${GH}/jobs/1`]: { id: 1, title: 'Account Executive', first_published: d(12), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/1', content: '&lt;p&gt;Join Brightloop in London&lt;/p&gt;' } })), { now: NOW })
    assert.deepEqual([r.passed, r.demoted], [0, 1], String(basis)); assert.equal(lead(db).review_reason, 'no_sales_hiring_evidence')
    assert.match(lead(db).why, /not established as this company's board/)
  }
  const confirmed = seed({ basis: null }); confirmed.db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('R1', 'L1', 'u1', 'user', 'domain_review', 'brightloop.io', 'domain-review-v1:x', NULL, 'https://brightloop.io/', '2026-10-28', 1)").run()
  assert.equal((await applySalesHiringGate(confirmed.db, confirmed.job, serve(board({ [`${GH}/jobs/1`]: { id: 1, title: 'Account Executive', first_published: d(12), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/1', content: '&lt;p&gt;Join Brightloop in London&lt;/p&gt;' } })), { now: NOW })).passed, 1, 'a domain the user confirmed is established')
  const named = seed({ basis: 'name_probe' })
  assert.equal((await applySalesHiringGate(named.db, named.job, serve(board()), { now: NOW })).passed, 1, 'the board\u2019s own postings name the lead\u2019s domain (jobs@brightloop.io): bound by the board itself')
})

test('JUICEBOX-TYPE job ad: a lead whose quote shows only a London office / sales-leadership opening does NOT stand in for "seed funding"; it is no_event_evidence', async () => {
  const ad = 'Brightloop is opening a second office in London and hiring a Head of Sales to lead the new team'
  const { db, job } = seed({ excerpt: ad })
  const seen: string[] = []
  const r = await applySalesHiringGate(db, job, serve(board(), seen), { now: NOW })
  assert.deepEqual([r.passed, r.demoted], [0, 1]); assert.equal(lead(db).review_reason, 'no_event_evidence'); assert.equal(lead(db).confidence, null)
  assert.match(lead(db).why, /^No event evidence: /); assert.equal(seen.length, 0, 'no board lookup was spent on it')
  assert.deepEqual(counts(db), { verified: 0, needs_review: 1 })
  // control: another verified candidate for the same company carries the funding (kept out as a duplicate) -> the event half is met
  const other = seed({ excerpt: ad }); const row = other.db.prepare("SELECT dedup_key FROM leads").get() as { dedup_key: string | null }
  other.db.prepare("UPDATE leads SET dedup_key = 'k1' WHERE id = 'L1'").run(); void row
  assert.equal((await applySalesHiringGate(other.db, other.job, serve(board()), { now: NOW, quotes: new Map([['k1', [{ url: 'https://news.example/other', excerpt: 'Brightloop raised a seed round in London', date: null }]]]) })).passed, 1)
})

test('seed-only and hiring-only requests are not touched, and review / human-confirmed rows are never promoted or changed', async () => {
  const seen: string[] = []
  const s = seed({ query: 'Find London UK startups that announced seed funding.', icp: JSON.stringify({ where: ['London, UK'], signals: ['announced seed funding'] }) })
  assert.equal((await applySalesHiringGate(s.db, s.job, serve({}, seen), { now: NOW })).required, false); assert.equal(lead(s.db).review_reason, null); assert.equal(seen.length, 0)
  const r = seed(); r.db.prepare("UPDATE leads SET review_reason = 'quote_unconfirmed', confidence = NULL WHERE id = 'L1'").run()
  await applySalesHiringGate(r.db, r.job, serve(board()), { now: NOW }); assert.equal(lead(r.db).review_reason, 'quote_unconfirmed', 'a review row stays as it was, even with a perfect board')
  const h = seed(); h.db.prepare("UPDATE leads SET human_confirmed_at = 1, human_confirmed_from = 'x' WHERE id = 'L1'").run()
  assert.equal((await applySalesHiringGate(h.db, h.job, serve({}), { now: NOW })).checked, 0)
})

// ---- through the real runJob: the funding article is verified by the normal gates, then the board decides ----
const NEWS = 'https://sifted.example/brightloop-raises-seed'
const pad = (s: string) => `${s} ${'More about the company and its people. '.repeat(15)}`
function london(boardJson: Record<string, unknown>, quote = QUOTE): Fixture {
  const page = { title: 'Brightloop raises seed round', text: pad(`Published ${daysAgo(12)}. ${quote}.`) }
  const crawl = async (url: string) => {
    const u = new URL(url)
    if (u.hostname === 'sifted.example') return { status: 200, body: `<html><body><a href="https://brightloop.io/">Brightloop</a> ${page.text}</body></html>`, finalUrl: url }
    if (u.hostname === 'brightloop.io') return u.pathname === '/robots.txt' ? { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url } : u.pathname === '/' ? { status: 200, body: pad('<html><body>Brightloop - London SaaS, 1 Old Street, London EC1V 9HX.'), finalUrl: url } : { status: 404, body: '', finalUrl: url }
    return null
  }
  return {
    request: REQUEST, modelIcp: { summary: 's', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding', 'hiring sales staff'], exclude: [], country: 'GB', language: 'en', window_days: 90 },
    modelQueries: ['London SaaS startup seed round'], hits: [{ url: NEWS, title: page.title, snippet: quote, date: daysAgo(12) }], tfPages: { [NEWS]: page }, own: { [NEWS]: page },
    extraction: [{ company: 'Brightloop', signal: 'raised a seed round', source_url: NEWS, excerpt: quote, event_date: daysAgo(12) }],
    deps: {
      crawlGet: crawl as never,
      fetchImpl: (async (u: RequestInfo | URL, init?: RequestInit) => { const k = String(u); return boardJson[k] ? ok(boardJson[k]) : k.includes('greenhouse.io') || k.includes('lever.co') || k.includes('ashbyhq.com') ? no() : globalThis.fetch(u, init) }) as never,
    },
  }
}
test('through the real runJob: the seed lead passes the normal gates; with a board bound to its domain it stays verified (why names the role + date), without one it is no_sales_hiring_evidence', async () => {
  const withBoard = await runCrawl(london({
    'https://boards-api.greenhouse.io/v1/boards/brightloop/jobs': { jobs: [{ id: 1, title: 'Account Executive' }] },
    'https://boards-api.greenhouse.io/v1/boards/brightloop/jobs/1': { id: 1, title: 'Account Executive', first_published: new Date(Date.now() - 12 * 86_400_000).toISOString(), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/1', content: '&lt;p&gt;Write to jobs@brightloop.io&lt;/p&gt;' },
  }))
  const l1 = withBoard.db.prepare("SELECT company_domain, review_reason, confidence, why FROM leads WHERE company = 'Brightloop'").get() as { company_domain: string | null; review_reason: string | null; confidence: number | null; why: string | null }
  assert.equal(l1.company_domain, 'brightloop.io', JSON.stringify(l1)); assert.equal(l1.review_reason, null); assert.ok(l1.confidence !== null)
  assert.match(l1.why ?? '', /^Hiring sales: Account Executive posted \d{4}-\d{2}-\d{2} on its Greenhouse job board \(brightloop\.io\)\./)
  const none = await runCrawl(london({}))
  const l2 = none.db.prepare("SELECT company_domain, review_reason, confidence, why FROM leads WHERE company = 'Brightloop'").get() as { company_domain: string | null; review_reason: string | null; confidence: number | null; why: string | null }
  assert.equal(l2.review_reason, 'no_sales_hiring_evidence', JSON.stringify(l2)); assert.equal(l2.confidence, null)
  const job = none.db.prepare('SELECT verified, needs_review FROM scan_jobs').get() as { verified: number; needs_review: number }
  assert.deepEqual(job, { verified: 0, needs_review: 1 })
  // the saved run report shows the FINAL outcome, not the pre-gate one
  const rep = JSON.parse((none.db.prepare('SELECT report FROM scan_run_report ORDER BY attempt DESC LIMIT 1').get() as { report: string }).report) as { funnel: { verified: number; needs_review: number; review_reasons: Record<string, number> }; candidates: { company: string; fate: string }[]; final_gate?: string }
  assert.equal(rep.funnel.verified, 0); assert.equal(rep.funnel.needs_review, 1); assert.equal(rep.funnel.review_reasons.no_sales_hiring_evidence, 1)
  assert.equal(rep.candidates.find(c => c.company === 'Brightloop')!.fate, 'review:no_sales_hiring_evidence'); assert.equal(rep.final_gate, 'sales_hiring')
})

test('through the real runJob: "has announced plans for a seed round" (and plans to / intends to / aims to / is preparing / will raise) is NOT a completed seed raise', async () => {
  const board = {
    'https://boards-api.greenhouse.io/v1/boards/brightloop/jobs': { jobs: [{ id: 1, title: 'Account Executive' }] },
    'https://boards-api.greenhouse.io/v1/boards/brightloop/jobs/1': { id: 1, title: 'Account Executive', first_published: new Date(Date.now() - 12 * 86_400_000).toISOString(), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/1', content: '&lt;p&gt;Write to jobs@brightloop.io&lt;/p&gt;' },
  }
  for (const q of ['Brightloop, a London B2B SaaS startup, has announced plans for a 3m GBP seed round this month', 'Brightloop, a London B2B SaaS startup, plans to raise a 3m GBP seed round this month', 'Brightloop, a London B2B SaaS startup, intends to raise a 3m GBP seed round this month', 'Brightloop, a London B2B SaaS startup, aims to raise a 3m GBP seed round this month', 'Brightloop, a London B2B SaaS startup, is preparing a 3m GBP seed round this month', 'Brightloop, a London B2B SaaS startup, will raise a 3m GBP seed round this month']) {
    const r = await runCrawl(london(board, q))
    const l = r.db.prepare("SELECT review_reason, confidence FROM leads WHERE company = 'Brightloop'").get() as { review_reason: string | null; confidence: number | null } | undefined
    assert.ok(l, q); assert.equal(l!.review_reason, 'no_event_evidence', q); assert.equal(l!.confidence, null, q)
    assert.deepEqual(r.db.prepare('SELECT verified, needs_review FROM scan_jobs').get(), { verified: 0, needs_review: 1 }, q)
  }
})

test('through the real runJob: a Series A-only article with a perfect sales board is NOT a seed lead (no_event_evidence, report agrees)', async () => {
  const board = {
    'https://boards-api.greenhouse.io/v1/boards/brightloop/jobs': { jobs: [{ id: 1, title: 'Account Executive' }] },
    'https://boards-api.greenhouse.io/v1/boards/brightloop/jobs/1': { id: 1, title: 'Account Executive', first_published: new Date(Date.now() - 12 * 86_400_000).toISOString(), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/1', content: '&lt;p&gt;Write to jobs@brightloop.io&lt;/p&gt;' },
  }
  const r = await runCrawl(london(board, 'Brightloop, a London B2B SaaS startup, raised a 3m GBP Series A round this month'))
  const l = r.db.prepare("SELECT review_reason, confidence FROM leads WHERE company = 'Brightloop'").get() as { review_reason: string | null; confidence: number | null }
  assert.equal(l.review_reason, 'no_event_evidence', JSON.stringify(l)); assert.equal(l.confidence, null)
  assert.deepEqual(r.db.prepare('SELECT verified, needs_review FROM scan_jobs').get(), { verified: 0, needs_review: 1 })
  const rep = JSON.parse((r.db.prepare('SELECT report FROM scan_run_report ORDER BY attempt DESC LIMIT 1').get() as { report: string }).report) as { funnel: { verified: number } }
  assert.equal(rep.funnel.verified, 0)
})

test('affirmative hiring only: negated or near-miss sentences are NOT sales-hiring evidence', () => {
  const no = [
    'Brightloop raised a $3M seed round but is not hiring any sales staff.',
    'Brightloop raised a seed round and has no plans to hire sales reps this year.',
    'Brightloop announced seed funding; a hiring freeze on sales roles remains in place.',
    'Brightloop raised seed funding and paused hiring of account executives.',
    'Brightloop raised a seed round and will not be hiring SDRs.',
    'Brightloop raised a seed round and is hiring engineers to support its sales team.',
    'Brightloop raised a seed round and is hiring two backend engineers and a Salesforce developer.',
    'Brightloop raised a seed round. Its sales team is based in London.',
    'Brightloop raised a seed round and cancelled its open sales roles.',
    'Brightloop raised seed funding and is hiring a recruiter.',
    // denial / refutation
    'Brightloop denies hiring sales staff.', 'Brightloop rules out hiring sales reps.', 'Brightloop refutes reports it is hiring account executives.', 'Brightloop rejects reports of hiring SDRs.', 'Brightloop dismissed rumours it is hiring sales staff.',
    // sales as a modifier of another role
    'Brightloop is hiring sales tax accountants.', 'Brightloop is hiring a sales operations accountant.', 'Brightloop is hiring sales tax counsel.', 'Brightloop is hiring a sales compliance lawyer.',
    // conditional / hypothetical / planned / hearsay / past
    'Brightloop is hiring sales staff only if funding closes.', 'Brightloop will hire sales staff once the round closes.', 'Brightloop would hire account executives if it hits revenue targets.', 'Brightloop may hire SDRs later this year.', 'Brightloop plans to hire a Head of Sales.', 'Brightloop could be hiring sales reps when it scales.', 'Brightloop was hiring sales reps last year.', 'Brightloop is reportedly hiring account executives.', 'Brightloop previously hired a VP of Sales.',
  ]
  for (const t of no) { assert.equal(quoteNamesSalesHiring(t, null), false, t); assert.equal(quoteNamesSalesHiring(t, null, 'Brightloop'), false, `${t} (with company)`) }
  const yes = [
    'Brightloop raised a seed round and is hiring two account executives.',
    'Brightloop raised a $3M seed round, and is now hiring SDRs in London.',
    'Brightloop raised a seed round and is looking to hire its first AE.',
    'Brightloop raised a seed round; it has two open sales roles in London.',
    'Brightloop raised seed funding but is still hiring a Head of Sales.',
    'Brightloop raised a seed round and is hiring across sales and customer success.',
    'Brightloop raised a seed round. The London startup is now hiring sales reps.',
    'Brightloop raised a seed round and is hiring a Head of Sales to lead its team.',
  ]
  for (const t of yes) { assert.equal(quoteNamesSalesHiring(t, null), true, t); assert.equal(quoteNamesSalesHiring(t, null, 'Brightloop Ltd'), true, `${t} (with company)`) }
})

test('through applySalesHiringGate: denied / modifier / conditional / other-company hiring quotes are demoted; attribution binds BOTH halves to the lead', async () => {
  for (const hiring of ['Brightloop denies hiring sales staff.', 'Brightloop is hiring sales tax accountants.', 'Brightloop is hiring sales staff only if funding closes.', 'Separately, Othercorp is hiring sales staff.', 'Brightloop raised a seed round but is not hiring any sales staff.']) {
    const { db, job } = seed({ domain: null, excerpt: `Brightloop raised a seed round in London. ${hiring}` })
    const r = await applySalesHiringGate(db, job, serve({}), { now: NOW })
    assert.deepEqual([r.passed, r.demoted], [0, 1], hiring); assert.equal(lead(db).review_reason, 'no_sales_hiring_evidence', hiring); assert.equal(lead(db).confidence, null)
  }
  const okQ = seed({ domain: null, excerpt: 'Brightloop raised a seed round in London. Brightloop is hiring two account executives.' })
  assert.equal((await applySalesHiringGate(okQ.db, okQ.job, serve({}), { now: NOW })).passed, 1, 'a plain affirmative own-company clause still passes')
  const ev = seed({ domain: null, excerpt: 'Othercorp raised a seed round in London. Brightloop is hiring two account executives.' })
  await applySalesHiringGate(ev.db, ev.job, serve({}), { now: NOW }); assert.equal(lead(ev.db).review_reason, 'no_event_evidence', 'the funding sentence is another company\'s')
})

test('no processing cap bypasses the gate: with 21 source-checked leads every one is passed or held, the 21st is held as NOT CHECKED', async () => {
  const { db, job } = seed({ extra: 20 })
  const r = await applySalesHiringGate(db, job, serve(board()), { now: NOW })
  assert.equal(r.checked, 21); assert.equal(r.passed + r.demoted, 21, 'no lead is left unexamined')
  const rows = db.prepare("SELECT id, review_reason, confidence, why FROM leads ORDER BY score DESC").all() as { id: string; review_reason: string | null; confidence: number | null; why: string }[]
  assert.equal(rows.filter(x => x.review_reason === null).length, r.passed)
  const held = rows.filter(x => x.review_reason === 'no_sales_hiring_evidence'); assert.equal(held.length, 1); assert.equal(held[0].confidence, null)
  assert.match(held[0].why, /not checked - this scan had more leads than the job-board lookup limit \(20\)/)
})

test('gate negative controls: lowercase other company, negated seed, wrong stage, and same-name evidence from another domain are all held', async () => {
  const cases: [string, string][] = [
    ['Brightloop raised a seed round in London. Separately, othercorp is hiring sales staff.', 'no_sales_hiring_evidence'],
    ['othercorp raised a seed round in London. Brightloop is hiring sales staff.', 'no_event_evidence'],
    ['Brightloop did not raise a seed round in London. Brightloop is hiring sales staff.', 'no_event_evidence'],
    ['Brightloop raised a Series A round in London. Brightloop is hiring sales staff.', 'no_event_evidence'],
    ['Brightloop plans to raise a seed round in London. Brightloop is hiring sales staff.', 'no_event_evidence'],
    ['Brightloop raised a seed extension after its Series A in London. Brightloop is hiring sales staff.', 'no_event_evidence'],
  ]
  for (const [excerpt, reason] of cases) {
    const { db, job } = seed({ domain: null, excerpt }); const r = await applySalesHiringGate(db, job, serve({}), { now: NOW })
    assert.deepEqual([r.passed, r.demoted], [0, 1], excerpt); assert.equal(lead(db).review_reason, reason, excerpt); assert.equal(lead(db).confidence, null, excerpt)
  }
  // controls that must still pass
  for (const excerpt of ['Brightloop raised a seed round in London. Brightloop is hiring sales staff.', 'Brightloop raised a pre-seed round led by Octopus Ventures and is hiring two account executives.', 'Brightloop, the London startup, closed a seed round. It is hiring sales reps.']) {
    const { db, job } = seed({ domain: null, excerpt }); assert.equal((await applySalesHiringGate(db, job, serve({}), { now: NOW })).passed, 1, excerpt)
  }
  // same name, different domain: hiring evidence found on brightloop.com is not credited to the brightloop.io lead (and vice versa), a third-party page is
  const mk = (url: string, domain: string | null) => { const x = seed({ domain, excerpt: 'Brightloop raised a seed round in London.' }); x.db.prepare("UPDATE leads SET dedup_key = 'brightloop' WHERE id = 'L1'").run(); return { ...x, quotes: new Map([['brightloop', [{ url, excerpt: 'Brightloop is hiring two account executives in London.', date: null }]]]) } }
  for (const [url, domain, passes] of [['https://brightloop.com/careers', 'brightloop.io', 0], ['https://brightloop.com/careers', null, 0], ['https://brightloop.io/careers', 'brightloop.io', 1], ['https://sifted.example/brightloop-hiring', 'brightloop.io', 1]] as const) {
    const x = mk(url, domain); const r = await applySalesHiringGate(x.db, x.job, serve({}), { now: NOW, quotes: x.quotes })
    assert.equal(r.passed, passes, `${url} for ${domain}`); if (!passes) assert.equal(lead(x.db).review_reason, 'no_sales_hiring_evidence')
  }
})

test('#276 review: planned / ongoing fundraising is never a completed seed raise, and a partner\'s hiring is not the lead\'s (gate level, exact sentences)', async () => {
  const held: [string, string][] = [
    ['Brightloop is raising a seed round in London. Brightloop is hiring sales staff.', 'no_event_evidence'],
    ['Brightloop is in talks to raise a seed round in London. Brightloop is hiring sales staff.', 'no_event_evidence'],
    ['Brightloop is set to raise a seed round in London. Brightloop is hiring sales staff.', 'no_event_evidence'],
    ['Brightloop is expected to close a seed round in London. Brightloop is hiring sales staff.', 'no_event_evidence'],
    ['Brightloop has an ongoing seed round in London. Brightloop is hiring sales staff.', 'no_event_evidence'],
    ['Brightloop will close a seed round in London next month. Brightloop is hiring sales staff.', 'no_event_evidence'],
    ['Brightloop is closing a seed round in London. Brightloop is hiring sales staff.', 'no_event_evidence'],
    ['Brightloop has announced plans for a 3m GBP seed round in London. Brightloop is hiring sales staff.', 'no_event_evidence'],
    ['Brightloop has announced plans for a seed round in London. Brightloop is hiring sales staff.', 'no_event_evidence'],
    ['Brightloop plans to raise a seed round in London. Brightloop is hiring sales staff.', 'no_event_evidence'],
    ['Brightloop intends to raise a seed round in London. Brightloop is hiring sales staff.', 'no_event_evidence'],
    ['Brightloop aims to close a seed round in London. Brightloop is hiring sales staff.', 'no_event_evidence'],
    ['Brightloop is preparing a seed round in London. Brightloop is hiring sales staff.', 'no_event_evidence'],
    ['Brightloop will raise a seed round in London. Brightloop is hiring sales staff.', 'no_event_evidence'],
    ['Brightloop raised a seed round in London. Brightloop partners with othercorp, which is hiring sales staff.', 'no_sales_hiring_evidence'],
    ['Brightloop raised a seed round in London and partners with othercorp, which is hiring sales staff.', 'no_sales_hiring_evidence'],
  ]
  for (const [excerpt, reason] of held) {
    const { db, job } = seed({ domain: null, excerpt }); const r = await applySalesHiringGate(db, job, serve({}), { now: NOW })
    assert.deepEqual([r.passed, r.demoted], [0, 1], excerpt); assert.equal(lead(db).review_reason, reason, excerpt); assert.equal(lead(db).confidence, null, excerpt)
  }
  for (const excerpt of ['Brightloop raised a seed round in London and will use it to hire sales staff. Brightloop is hiring two account executives.', 'Brightloop raised a seed round in London, which is hiring sales reps.', 'Brightloop raised a seed round in London and partners with othercorp. Brightloop is hiring sales staff.', 'Brightloop closed a seed round in London and is hiring sales staff.']) {
    const { db, job } = seed({ domain: null, excerpt }); assert.equal((await applySalesHiringGate(db, job, serve({}), { now: NOW })).passed, 1, excerpt)
  }
})

test('appositive subject: "Brightloop, a London B2B SaaS startup with 24 employees, raised a seed round and is hiring two account executives" counts for Brightloop; a different name in front still does not', async () => {
  const good = 'Brightloop, a London B2B SaaS startup with 24 employees, raised a 3m GBP seed round this month and is hiring two account executives to build its sales team'
  const { db, job } = seed({ domain: null, excerpt: good }); assert.equal((await applySalesHiringGate(db, job, serve({}), { now: NOW })).passed, 1)
  const bad = seed({ domain: null, excerpt: 'othercorp, a London B2B SaaS startup with 24 employees, raised a 3m GBP seed round this month and is hiring two account executives' })
  assert.equal((await applySalesHiringGate(bad.db, bad.job, serve({}), { now: NOW })).passed, 0)
})
