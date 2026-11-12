// #899 decision (Hermes, delegated, 2026-11-12): free-tier mailbox verification (ZeroBounce), capped at the free allowance, never
// auto-upgraded; without a key, today's behaviour. Stubbed HTTP only: no network, no real key, no credit used.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { zeroBounceVerifier, VerifierError, ZEROBOUNCE_FREE_MONTHLY, ZEROBOUNCE_URL } from '../lib/people/zerobounce.ts'
import { recordEmailGuesses, verifyCandidates, verifierFromEnv, verifyMonthlyCap, migrateEmailGuess } from '../lib/people/email-pattern.ts'
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

test('#899 the monthly cap is the verifier ACCOUNT\'s, across tenants: once it is used up, another tenant gets no check', async () => {
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

test('#899 both cap counts read an index (SQLite twin of 0064_email_verify_caps.sql)', () => {
  const db = new Database(':memory:'); migrateEmailGuess(db)
  const plan = (sql: string, ...a: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...a) as { detail: string }[]).map(r => r.detail).join(' | ')
  assert.match(plan('SELECT count(*) AS n FROM email_candidates WHERE verifier = ? AND checked_at >= ?', 'zerobounce', 0), /email_candidates_verifier_checked/)
  assert.match(plan('SELECT count(*) AS n FROM email_candidates WHERE tenant_id = ? AND checked_at >= ?', 'A', 0), /email_candidates_tenant_checked/)
})

// The crawl (the only writer of guesses) runs the capped check for the lead's high-confidence US guess, and records it on the
// candidate row only: the guess never becomes a contact.
const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>We have served the community for many years and we care about every family that walks through our doors every single day.</p>'
async function crawl(env: Record<string, string>, verifyFetch: typeof fetch) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'Acme Logistics', null, 'Acme Logistics is hiring', 'https://news.example.test/a', 'Acme Logistics is hiring', 90, 80)
  const pages: Record<string, string> = {
    '/a': html('<a href="https://acmelogistics.com/">site</a>'),
    '/robots.txt': 'User-agent: *\nAllow: /',
    '/': html('Acme Logistics 120 Main St, Austin, TX 78701 <a href="/team">Team</a>'),
    '/team': html(`${PROSE}<h3>Dana Lee</h3><p>CEO</p><h3>Ben Ortiz</h3><p>CFO</p><h3>Cara Diaz</h3><p>COO</p><p>Press: dana.lee@acmelogistics.com, ben.ortiz@acmelogistics.com</p>`),
  }
  const get: Get = async url => { const p = pages[new URL(url).pathname]; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env, now: NOW, verifyFetch })
  return db
}

test('#899 crawl: with a key, flag and caps, the guessed (not the published) address is checked and only the candidate row changes', async () => {
  const sent: string[] = []
  const db = await crawl({ EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '5', ZEROBOUNCE_API_KEY: 'k' }, (async (u: RequestInfo | URL) => { sent.push(new URL(String(u)).searchParams.get('email')!); return new Response(JSON.stringify({ status: 'valid' })) }) as typeof fetch)
  assert.deepEqual(sent, ['cara.diaz@acmelogistics.com'], 'only the high-confidence guess, never a published address')
  assert.deepEqual(db.prepare("SELECT address, tier, verification, verifier FROM email_candidates WHERE tier = 'guessed'").all(), [{ address: 'cara.diaz@acmelogistics.com', tier: 'guessed', verification: 'verified', verifier: 'zerobounce' }])
  const enr = db.prepare("SELECT value FROM lead_enrichments WHERE value LIKE '%cara.diaz%'").all()
  assert.deepEqual(enr, [], 'a verified guess is still not a contact here')
  const audit = db.prepare("SELECT status, results FROM connector_audit WHERE connector = 'email-verify'").all()
  assert.deepEqual(audit, [{ status: 'checked 1, verified 1', results: 1 }])
})

test('#899 crawl: no key, or no daily cap, or the flag off -> no request at all', async () => {
  for (const env of [{ EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '5' }, { EMAIL_GUESS_ENABLED: '1', ZEROBOUNCE_API_KEY: 'k' }, { EMAIL_VERIFY_DAILY_CAP: '5', ZEROBOUNCE_API_KEY: 'k' }] as Record<string, string>[]) {
    let calls = 0
    await crawl(env, (async () => { calls++; return new Response(JSON.stringify({ status: 'valid' })) }) as unknown as typeof fetch)
    assert.equal(calls, 0, JSON.stringify(env))
  }
})
