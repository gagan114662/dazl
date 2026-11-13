// #899 decision (Hermes, delegated, 2026-11-12): free-tier mailbox verification (ZeroBounce), capped at the free allowance, never
// auto-upgraded; without a key, today's behaviour. Stubbed HTTP only: no network, no real key, no credit used.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { zeroBounceVerifier, VerifierError, ZEROBOUNCE_FREE_MONTHLY, ZEROBOUNCE_URL, ZEROBOUNCE_STAGING_FAKE } from '../lib/people/zerobounce.ts'
import { recordEmailGuesses, verifyCandidates, verifierFromEnv, verifyMonthlyCap, migrateEmailGuess, verifyJobCandidates } from '../lib/people/email-pattern.ts'
import { runPostFinishBounded, emailVerifyBudgetMs } from '../lib/scan/runner.ts'
import { EnrichmentTrace } from '../lib/scan/enrichment-trace.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'

const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

test('#899 ZeroBounce mapping: only "valid" is deliverable; catch-all, invalid, unknown and do-not-mail stay non-verified', async () => {
  const cases: [string, string][] = [['valid', 'deliverable'], ['catch-all', 'catch_all'], ['invalid', 'undeliverable'], ['unknown', 'unknown'], ['spamtrap', 'refused'], ['abuse', 'refused'], ['do_not_mail', 'refused']]
  for (const [status, outcome] of cases) assert.equal((await zeroBounceVerifier('k', answer({ address: 'a@b.example', status, sub_status: '' })).verify('a@b.example')).outcome, outcome, status)
})

test('#899 ZeroBounce request: the documented endpoint, key, address and a bounded validation timeout', async () => {
  let url = ''
  await zeroBounceVerifier('zb-test-key', (async (u: RequestInfo | URL) => { url = String(u); return new Response(JSON.stringify({ status: 'valid' })) }) as typeof fetch).verify('dana.lee@acme.example')
  const u = new URL(url)
  assert.equal(`${u.origin}${u.pathname}`, ZEROBOUNCE_URL)
  assert.equal(u.searchParams.get('api_key'), 'zb-test-key'); assert.equal(u.searchParams.get('email'), 'dana.lee@acme.example'); assert.equal(u.searchParams.get('timeout'), '10')
})

test('#899 ZeroBounce failures never verify: an error body (bad key / no credits) stops; a 5xx, unreadable body or unknown status fails', async () => {
  await assert.rejects(zeroBounceVerifier('k', answer({ error: 'Invalid API key or your account ran out of credits' })).verify('a@b.example'), (e: unknown) => e instanceof VerifierError && e.kind === 'stop')
  await assert.rejects(zeroBounceVerifier('k', answer({}, 503)).verify('a@b.example'), (e: unknown) => e instanceof VerifierError && e.kind === 'failed')
  await assert.rejects(zeroBounceVerifier('k', (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch).verify('a@b.example'), (e: unknown) => e instanceof VerifierError && e.kind === 'failed')
  await assert.rejects(zeroBounceVerifier('k', answer({ status: 'gold' })).verify('a@b.example'), (e: unknown) => e instanceof VerifierError && e.kind === 'failed')
})

test('#899 env: no ZEROBOUNCE_API_KEY = no verifier (today\'s behaviour); a key = the ZeroBounce verifier', () => {
  assert.equal(verifierFromEnv({}), null)
  assert.equal(verifierFromEnv({ ZEROBOUNCE_API_KEY: '  ' }), null)
  assert.equal(verifierFromEnv({ ZEROBOUNCE_API_KEY: 'k' })?.name, 'zerobounce')
})

test('#899 monthly cap: default and ceiling = the free allowance; the setting can only lower it; garbage = no check', () => {
  assert.equal(ZEROBOUNCE_FREE_MONTHLY, 100)
  assert.equal(verifyMonthlyCap({}), 100)
  assert.equal(verifyMonthlyCap({ EMAIL_VERIFY_MONTHLY_CAP: '40' }), 40)
  assert.equal(verifyMonthlyCap({ EMAIL_VERIFY_MONTHLY_CAP: '5000' }), 100, 'never past the free tier')
  for (const bad of ['-1', '1e3', 'ten', '2.5']) assert.equal(verifyMonthlyCap({ EMAIL_VERIFY_MONTHLY_CAP: bad }), 0, bad)
})

function seeded(tenant: string, lead: string, db = new Database(':memory:')) {
  const on = { EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '50' }
  recordEmailGuesses(db, tenant, lead, 'acme.com', ['dana.lee', 'ben.ortiz'], ['Dana Lee, CEO', 'Ben Ortiz, CFO', 'Cara Diaz, COO', 'Eve Ng, CTO', 'Finn Roe, VP'], { env: on, homeText: '120 Main St, Austin, TX 78701' })
  return { db, on }
}
const NOW = Date.parse('2026-11-12T12:00:00Z')

test('#899 the monthly cap is the verifier\'s per database, across tenants: once it is used up, another tenant gets no check', async () => {
  const { db, on } = seeded('A', 'L1')
  seeded('B', 'L2', db)
  let calls = 0
  const v = { name: 'zerobounce', async verify() { calls++; return { outcome: 'deliverable' as const } } }
  const a = await verifyCandidates(db, 'A', 'L1', v, { env: { ...on, EMAIL_VERIFY_MONTHLY_CAP: '2' }, now: NOW })
  assert.equal(a.checked, 2); assert.ok(a.capped > 0)
  const b = await verifyCandidates(db, 'B', 'L2', v, { env: { ...on, EMAIL_VERIFY_MONTHLY_CAP: '2' }, now: NOW + 3_600_000 })
  assert.equal(b.checked, 0, 'tenant B gets nothing: the free allowance is spent'); assert.equal(calls, 2)
  const next = await verifyCandidates(db, 'B', 'L2', v, { env: { ...on, EMAIL_VERIFY_MONTHLY_CAP: '2' }, now: Date.parse('2026-12-01T00:00:05Z') })
  assert.equal(next.checked, 2, 'a new calendar month starts a new allowance')
})

test('#899 a "stop" answer (bad key / no credits) ends the run after that one request; the address stays uncertain', async () => {
  const { db, on } = seeded('A', 'L1')
  let calls = 0
  const run = await verifyCandidates(db, 'A', 'L1', zeroBounceVerifier('k', (async () => { calls++; return new Response(JSON.stringify({ error: 'Invalid API key or your account ran out of credits' })) }) as unknown as typeof fetch), { env: on, now: NOW })
  assert.equal(calls, 1); assert.match(run.stopped ?? '', /ran out of credits/); assert.equal(run.verified, 0)
  const st = db.prepare("SELECT verification, count(*) AS n FROM email_candidates WHERE verifier = 'zerobounce' GROUP BY verification").all()
  assert.deepEqual(st, [{ verification: 'uncertain', n: 1 }])
})

test('#899 the daily cap count reads an index; the monthly allowance is an operator ledger (SQLite twin of 0063_email_verify_caps.sql)', () => {
  const db = new Database(':memory:'); migrateEmailGuess(db)
  const plan = (sql: string, ...a: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...a) as { detail: string }[]).map(r => r.detail).join(' | ')
  assert.match(plan('SELECT count(*) AS n FROM email_candidates WHERE tenant_id = ? AND checked_at >= ?', 'A', 0), /email_candidates_tenant_checked/)
  assert.match(plan('SELECT n FROM email_verify_usage WHERE verifier = ? AND month = ?', 'zerobounce', '2026-11'), /PRIMARY KEY|sqlite_autoindex_email_verify_usage/)
})

test('#899 deleting a tenant\'s candidate rows never frees allowance already spent', async () => {
  const { db, on } = seeded('A', 'L1')
  seeded('B', 'L2', db)
  let calls = 0
  const v = { name: 'zerobounce', async verify() { calls++; return { outcome: 'deliverable' as const } } }
  const env = { ...on, EMAIL_VERIFY_MONTHLY_CAP: '2' }
  await verifyCandidates(db, 'A', 'L1', v, { env, now: NOW })
  db.prepare("DELETE FROM email_candidates WHERE tenant_id = 'A'").run() // tenant A erased
  const b = await verifyCandidates(db, 'B', 'L2', v, { env, now: NOW + 60_000 })
  assert.equal(b.checked, 0); assert.equal(calls, 2)
})

test('#899 401, 403 and 429 stop the run (the account cannot check now); a 5xx only fails that one check', async () => {
  for (const status of [401, 403, 429]) await assert.rejects(zeroBounceVerifier('k', answer({}, status)).verify('a@b.example'), (e: unknown) => e instanceof VerifierError && e.kind === 'stop', String(status))
  await assert.rejects(zeroBounceVerifier('k', answer({}, 500)).verify('a@b.example'), (e: unknown) => e instanceof VerifierError && e.kind === 'failed')
})

// The crawl (the only writer of guesses) records candidates; the check is the scan's LAST post-finish step (runner), so a slow
// check can never delay or cut off a site read. The outcome stays on the candidate row: a guess never becomes a contact.
const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>We have served the community for many years and we care about every family that walks through our doors every single day.</p>'
async function crawl(env: Record<string, string>, opts: { leads?: number } = {}) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'Acme Logistics', null, 'Acme Logistics is hiring', 'https://news.example.test/a', 'Acme Logistics is hiring', 90, 80)
  if ((opts.leads ?? 1) > 1) db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('L2', job, 'Beta Freight', null, 'Beta Freight is hiring', 'https://news.example.test/b', 'Beta Freight is hiring', 90, 79)
  const pages: Record<string, string> = {
    '/a': html('<a href="https://acmelogistics.com/">site</a>'),
    '/b': html('<a href="https://betafreight.com/">site</a>'),
    '/robots.txt': 'User-agent: *\nAllow: /',
    '/': html('Acme Logistics 120 Main St, Austin, TX 78701 <a href="/team">Team</a>'),
    '/team': html(`${PROSE}<h3>Dana Lee</h3><p>CEO</p><h3>Ben Ortiz</h3><p>CFO</p><h3>Cara Diaz</h3><p>COO</p><p>Press: dana.lee@acmelogistics.com, ben.ortiz@acmelogistics.com</p>`),
  }
  const beta: Record<string, string> = { '/': html('Beta Freight 9 Elm St, Dallas, TX 75201 <a href="/team">Team</a>'), '/team': html(`${PROSE}<h3>Gil Park</h3><p>CEO</p><h3>Hal Rowe</h3><p>CFO</p><h3>Ivy Sol</h3><p>COO</p><p>Press: gil.park@betafreight.com, hal.rowe@betafreight.com</p>`) }
  const get: Get = async url => { const u = new URL(url); const p = u.hostname.includes('betafreight') && u.pathname !== '/robots.txt' ? beta[u.pathname] : pages[u.pathname]; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env, now: NOW })
  return { db, job }
}
const ON = { EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '5' }

test('#899 the crawl itself sends no mailbox check (it only records guesses), even with a key set', async () => {
  const { db } = await crawl({ ...ON, ZEROBOUNCE_API_KEY: 'k' })
  assert.deepEqual(db.prepare("SELECT verification FROM email_candidates WHERE tier = 'guessed'").all(), [{ verification: 'none' }])
})

test('#899 job check: the guessed (not the published) address is checked; only the candidate row changes', async () => {
  const { db, job } = await crawl(ON)
  const sent: string[] = []
  const v = await verifyJobCandidates(db, 'A', job, zeroBounceVerifier('k', (async (u: RequestInfo | URL) => { sent.push(new URL(String(u)).searchParams.get('email')!); return new Response(JSON.stringify({ status: 'valid' })) }) as typeof fetch), { env: ON, now: NOW })
  assert.deepEqual(sent, ['cara.diaz@acmelogistics.com'], 'only the high-confidence guess, never a published address')
  assert.deepEqual({ leads: v.leads, checked: v.checked, verified: v.verified }, { leads: 1, checked: 1, verified: 1 })
  assert.deepEqual(db.prepare("SELECT address, verification, verifier FROM email_candidates WHERE tier = 'guessed'").all(), [{ address: 'cara.diaz@acmelogistics.com', verification: 'verified', verifier: 'zerobounce' }])
  assert.deepEqual(db.prepare("SELECT value FROM lead_enrichments WHERE value LIKE '%cara.diaz%'").all(), [], 'a verified guess is still not a contact')
})

test('#899 job check: a stop (no credits) ends the whole job after one request; the key never reaches a stored row', async () => {
  const { db, job } = await crawl(ON, { leads: 2 })
  assert.deepEqual(db.prepare("SELECT lead_id FROM email_candidates WHERE tier = 'guessed' AND confidence = 'high' ORDER BY lead_id").all(), [{ lead_id: 'L1' }, { lead_id: 'L2' }], 'both leads had a high-confidence guess to check')
  let calls = 0
  const v = await verifyJobCandidates(db, 'A', job, zeroBounceVerifier('zb-secret-key', (async () => { calls++; return new Response(JSON.stringify({ error: 'Invalid API key or your account ran out of credits' })) }) as unknown as typeof fetch), { env: ON, now: NOW })
  assert.equal(calls, 1); assert.match(v.stopped ?? '', /ran out of credits/)
  for (const t of ['email_candidates', 'connector_audit', 'email_verify_usage']) assert.ok(!JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()).includes('zb-secret-key'), t)
})

test('#899 job check: no verifier, flag off, daily cap 0 or monthly cap 0 -> no request at all', async () => {
  const { db, job } = await crawl(ON)
  let calls = 0
  const zb = zeroBounceVerifier('k', (async () => { calls++; return new Response(JSON.stringify({ status: 'valid' })) }) as unknown as typeof fetch)
  assert.equal((await verifyJobCandidates(db, 'A', job, null, { env: ON })).skipped, 'no verifier configured')
  assert.equal((await verifyJobCandidates(db, 'A', job, zb, { env: { EMAIL_VERIFY_DAILY_CAP: '5' } })).skipped, 'EMAIL_GUESS_ENABLED is off')
  assert.equal((await verifyJobCandidates(db, 'A', job, zb, { env: { EMAIL_GUESS_ENABLED: '1' } })).skipped, 'EMAIL_VERIFY_DAILY_CAP is 0')
  assert.equal((await verifyJobCandidates(db, 'A', job, zb, { env: { ...ON, EMAIL_VERIFY_MONTHLY_CAP: '0' } })).skipped, 'EMAIL_VERIFY_MONTHLY_CAP is 0')
  assert.equal(calls, 0)
})

test('#899 runner: the check is the LAST post-finish step, traced as email_verify; without a key it is skipped visibly', async () => {
  const { db, job } = await crawl(ON)
  const keep = { ...process.env }
  Object.assign(process.env, { ...ON, SITECRAWL_ENABLED: '0', SIGNALS_ENRICH: '0' })
  try {
    delete process.env.ZEROBOUNCE_API_KEY
    const t0 = new EnrichmentTrace()
    await runPostFinishBounded(db, { id: job, user_id: 'A', attempts: 1 } as never, { creditEnrichment: false } as never, t0)
    const s0 = JSON.stringify(t0)
    assert.match(s0, /email_verify/); assert.match(s0, /no ZEROBOUNCE_API_KEY/)
    process.env.ZEROBOUNCE_API_KEY = 'k'
    let calls = 0
    const t1 = new EnrichmentTrace()
    await runPostFinishBounded(db, { id: job, user_id: 'A', attempts: 1 } as never, { creditEnrichment: false, fetchImpl: (async () => { calls++; return new Response(JSON.stringify({ status: 'valid' })) }) as unknown as typeof fetch } as never, t1)
    assert.equal(calls, 1)
    const s1 = JSON.stringify(t1)
    assert.match(s1, /email_verify/); assert.match(s1, /"verified":1/)
    for (const before of ['crawl', 'signals', 'paid_enrichment']) assert.ok(s1.indexOf(before) >= 0 && s1.indexOf(before) < s1.indexOf('email_verify'), `after ${before}`)
  } finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep) }
})

test('#899 job check stops when the scan is cancelled or taken over (alive false): no further request', async () => {
  const { db, job } = await crawl(ON, { leads: 2 })
  let calls = 0, alive = true
  const v = await verifyJobCandidates(db, 'A', job, zeroBounceVerifier('k', (async () => { calls++; alive = false; return new Response(JSON.stringify({ status: 'valid' })) }) as unknown as typeof fetch), { env: ON, now: NOW, alive: () => alive })
  assert.deepEqual(db.prepare("SELECT lead_id FROM email_candidates WHERE tier = 'guessed' AND confidence = 'high' ORDER BY lead_id").all(), [{ lead_id: 'L1' }, { lead_id: 'L2' }])
  assert.equal(calls, 1); assert.equal(v.aborted, true)
})

test('#899 cut off by its own budget mid-call: the address goes back to unchecked, its slot stays counted (over-count, never under)', async () => {
  const { db, job } = await crawl(ON)
  const ctrl = new AbortController()
  const v = await verifyJobCandidates(db, 'A', job, zeroBounceVerifier('k', (async () => { ctrl.abort(); throw new DOMException('aborted', 'AbortError') }) as unknown as typeof fetch), { env: ON, now: NOW, signal: ctrl.signal })
  assert.equal(v.aborted, true)
  assert.deepEqual(db.prepare("SELECT verification FROM email_candidates WHERE tier = 'guessed'").all(), [{ verification: 'none' }])
  assert.deepEqual(db.prepare('SELECT n FROM email_verify_usage').all(), [{ n: 1 }])
})

test('#899 an address another run already took is skipped, not reported as a cap', async () => {
  const { db, on } = seeded('A', 'L1')
  let calls = 0
  const v = { name: 'zerobounce', async verify() {
    if (calls++ === 0) db.prepare("UPDATE email_candidates SET verification = 'verified' WHERE lead_id = 'L1' AND verification = 'none' AND address = (SELECT max(address) FROM email_candidates WHERE lead_id = 'L1' AND verification = 'none')").run()
    return { outcome: 'deliverable' as const } } }
  const run = await verifyCandidates(db, 'A', 'L1', v, { env: on, now: NOW })
  assert.equal(run.capped, 0, 'a lost race is not a cap')
  assert.ok(run.checked >= 2, `the remaining addresses were still checked (${run.checked})`)
})

test('#899 runner: a stop shows a generic line in the tenant trace, never the provider\'s account message', async () => {
  const { db, job } = await crawl(ON)
  const keep = { ...process.env }
  Object.assign(process.env, { ...ON, SITECRAWL_ENABLED: '0', SIGNALS_ENRICH: '0', ZEROBOUNCE_API_KEY: 'k' })
  const err = console.error; console.error = () => {}
  try {
    const t = new EnrichmentTrace()
    await runPostFinishBounded(db, { id: job, user_id: 'A', attempts: 1 } as never, { creditEnrichment: false, fetchImpl: (async () => new Response(JSON.stringify({ error: 'Invalid API key or your account ran out of credits' }))) as unknown as typeof fetch } as never, t)
    const s = JSON.stringify(t)
    assert.match(s, /the mailbox check is unavailable right now/)
    assert.ok(!/ran out of credits|Invalid API key/.test(s), s)
  } finally { console.error = err; for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep) }
})

test('#899 the check\'s own budget: default 20 s, clamped to 1-60 s', () => {
  assert.equal(emailVerifyBudgetMs({}), 20_000)
  assert.equal(emailVerifyBudgetMs({ EMAIL_VERIFY_BUDGET_MS: '500' }), 1_000)
  assert.equal(emailVerifyBudgetMs({ EMAIL_VERIFY_BUDGET_MS: '900000' }), 60_000)
  assert.equal(emailVerifyBudgetMs({ EMAIL_VERIFY_BUDGET_MS: 'x' }), 20_000)
})

test('#899 a later crawl that no longer shows a US address clears the unchecked guesses\' US basis: nothing of them is checked', async () => {
  const { db, on } = seeded('A', 'L1')
  assert.ok((db.prepare("SELECT count(*) AS n FROM email_candidates WHERE tier = 'guessed' AND country_basis IS NOT NULL").get() as { n: number }).n > 0)
  recordEmailGuesses(db, 'A', 'L1', 'acme.com', ['dana.lee', 'ben.ortiz'], ['Dana Lee, CEO', 'Ben Ortiz, CFO', 'Cara Diaz, COO'], { env: on, homeText: '100 King St W, Toronto, ON M5X 1A9' })
  let calls = 0
  const run = await verifyCandidates(db, 'A', 'L1', { name: 'zerobounce', async verify() { calls++; return { outcome: 'deliverable' as const } } }, { env: on, now: NOW })
  assert.equal(calls, 0); assert.equal(run.checked, 0)
})

test('#899 runner: a job row that cannot be read counts as NOT alive: no address is sent (fail closed)', async () => {
  const { db, job } = await crawl(ON)
  const keep = { ...process.env }
  Object.assign(process.env, { ...ON, SITECRAWL_ENABLED: '0', SIGNALS_ENRICH: '0', ZEROBOUNCE_API_KEY: 'k' })
  let calls = 0
  try {
    db.exec('ALTER TABLE scan_jobs RENAME TO scan_jobs_unreadable')
    const t = new EnrichmentTrace()
    await runPostFinishBounded(db, { id: job, user_id: 'A', attempts: 1 } as never, { creditEnrichment: false, fetchImpl: (async () => { calls++; return new Response(JSON.stringify({ status: 'valid' })) }) as unknown as typeof fetch } as never, t)
    assert.equal(calls, 0)
    assert.match(JSON.stringify(t), /its state could not be read/)
  } finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep) }
})

test('#899 US -> non-US -> US re-crawls: the guess gets its US basis back and is checked once', async () => {
  const { db, on } = seeded('A', 'L1')
  const people = ['Dana Lee, CEO', 'Ben Ortiz, CFO', 'Cara Diaz, COO', 'Eve Ng, CTO', 'Finn Roe, VP']
  recordEmailGuesses(db, 'A', 'L1', 'acme.com', ['dana.lee', 'ben.ortiz'], people, { env: on, homeText: '100 King St W, Toronto, ON M5X 1A9' })
  recordEmailGuesses(db, 'A', 'L1', 'acme.com', ['dana.lee', 'ben.ortiz'], people, { env: on, homeText: '120 Main St, Austin, TX 78701' })
  const sent: string[] = []
  await verifyCandidates(db, 'A', 'L1', { name: 'zerobounce', async verify(a) { sent.push(a); return { outcome: 'deliverable' as const } } }, { env: on, now: NOW })
  assert.ok(sent.length >= 1, 'the unchecked guesses are checkable again')
  assert.equal(new Set(sent).size, sent.length, 'each at most once')
})

test('#899 a US re-crawl that finds no pattern still restores the unchecked guesses\' US basis', async () => {
  const { db, on } = seeded('A', 'L1')
  const people = ['Dana Lee, CEO', 'Ben Ortiz, CFO', 'Cara Diaz, COO', 'Eve Ng, CTO', 'Finn Roe, VP']
  recordEmailGuesses(db, 'A', 'L1', 'acme.com', ['dana.lee', 'ben.ortiz'], people, { env: on, homeText: '100 King St W, Toronto, ON M5X 1A9' })
  recordEmailGuesses(db, 'A', 'L1', 'acme.com', [], ['Dana Lee, CEO'], { env: on, homeText: '120 Main St, Austin, TX 78701' }) // no pattern this time
  let calls = 0
  await verifyCandidates(db, 'A', 'L1', { name: 'zerobounce', async verify() { calls++; return { outcome: 'deliverable' as const } } }, { env: on, now: NOW })
  assert.ok(calls >= 1)
})

test('#899 the US basis is restored only for guesses on the site this crawl read', async () => {
  const { db, on } = seeded('A', 'L1')
  const people = ['Dana Lee, CEO', 'Ben Ortiz, CFO', 'Cara Diaz, COO', 'Eve Ng, CTO', 'Finn Roe, VP']
  recordEmailGuesses(db, 'A', 'L1', 'acme.com', ['dana.lee', 'ben.ortiz'], people, { env: on, homeText: '100 King St W, Toronto, ON M5X 1A9' })
  recordEmailGuesses(db, 'A', 'L1', 'other-site.com', [], ['Dana Lee, CEO'], { env: on, homeText: '120 Main St, Austin, TX 78701' })
  assert.equal((db.prepare("SELECT count(*) AS n FROM email_candidates WHERE address LIKE '%@acme.com' AND tier = 'guessed' AND country_basis IS NOT NULL").get() as { n: number }).n, 0)
})

test('#899 staging fake verifier: only with DAZL_ENV=staging AND DAZL_STAGING_FAKE_ZEROBOUNCE=1; never in production; deterministic, no network', async () => {
  assert.equal(verifierFromEnv({ DAZL_STAGING_FAKE_ZEROBOUNCE: '1' }), null, 'not staging: the flag is inert')
  assert.equal(verifierFromEnv({ DAZL_ENV: 'production', DAZL_STAGING_FAKE_ZEROBOUNCE: '1' }), null)
  assert.equal(verifierFromEnv({ DAZL_ENV: 'production', DAZL_STAGING_FAKE_ZEROBOUNCE: '1', ZEROBOUNCE_API_KEY: 'k' })?.name, 'zerobounce', 'production uses only the real key')
  const fake = verifierFromEnv({ DAZL_ENV: 'staging', DAZL_STAGING_FAKE_ZEROBOUNCE: '1' })!
  assert.equal(fake.name, ZEROBOUNCE_STAGING_FAKE)
  const out: Record<string, string> = {}
  for (const a of ['dana.lee@acme.example', 'invalid.x@acme.example', 'catchall@acme.example', 'unknown.y@acme.example', 'spamtrap@acme.example']) out[a] = (await fake.verify(a)).outcome
  assert.deepEqual(Object.values(out), ['deliverable', 'undeliverable', 'catch_all', 'unknown', 'refused'])
  await assert.rejects(fake.verify('nocredits@acme.example'), (e: unknown) => e instanceof VerifierError && e.kind === 'stop')
  assert.equal(verifierFromEnv({ DAZL_ENV: 'staging' }), null, 'staging without the flag and without a key: no verifier')
})

test('#899 ZeroBounce "valid" on a catch-all domain is a catch-all, never verified (accept_all, role_based_accept_all, catchall_domain)', async () => {
  for (const body of [{ status: 'valid', sub_status: 'accept_all' }, { status: 'valid', sub_status: 'role_based_accept_all' }, { status: 'valid', sub_status: '', catchall_domain: true }])
    assert.equal((await zeroBounceVerifier('k', answer(body)).verify('a@b.example')).outcome, 'catch_all', JSON.stringify(body))
  assert.equal((await zeroBounceVerifier('k', answer({ status: 'valid', sub_status: '', catchall_domain: false })).verify('a@b.example')).outcome, 'deliverable')
})

test('#899 tenant scoping: another tenant gets no lead and sends nothing while this tenant\'s guess is still unchecked', async () => {
  const { db, job } = await crawl(ON)
  assert.deepEqual(db.prepare("SELECT tenant_id, verification FROM email_candidates WHERE tier = 'guessed'").all(), [{ tenant_id: 'A', verification: 'none' }])
  let calls = 0
  const v = await verifyJobCandidates(db, 'B', job, zeroBounceVerifier('k', (async () => { calls++; return new Response(JSON.stringify({ status: 'valid' })) }) as unknown as typeof fetch), { env: ON, now: NOW })
  assert.equal(calls, 0); assert.equal(v.leads, 0)
  assert.deepEqual(db.prepare("SELECT verification, verifier FROM email_candidates WHERE tier = 'guessed'").all(), [{ verification: 'none', verifier: null }])
  let callsLead = 0
  const r = await verifyCandidates(db, 'B', 'L1', zeroBounceVerifier('k', (async () => { callsLead++; return new Response(JSON.stringify({ status: 'valid' })) }) as unknown as typeof fetch), { env: ON, now: NOW })
  assert.equal(callsLead, 0); assert.equal(r.checked, 0)
})
