import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { splitName, localFor, inferPattern, personalLocals, candidateAddress, usEvidence, verifyCandidates, candidateLabel, verifierFromEnv, recordEmailGuesses, migrateEmailGuess, type MailboxVerifier, type VerifyAnswer } from '../lib/people/email-pattern.ts'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Email finder part 1 (docs/design/email-finder.md): pattern inference only. Candidates are unverified, kept in their
// own tables, never shown and never sent. TEST-ONLY fixtures, no network.

test('names split to ascii first/last; honorifics and accents handled; single names rejected', () => {
  assert.deepEqual(splitName('Dr. Ana María López-Pérez'), { first: 'ana', last: 'lopezperez' })
  assert.deepEqual(splitName('Dana Lee'), { first: 'dana', last: 'lee' })
  assert.equal(splitName('Madonna'), null)
  assert.equal(localFor('flast', { first: 'dana', last: 'lee' }), 'dlee')
  assert.equal(candidateAddress({ first: 'ben', last: 'ortiz' }, 'acme.com', 'first.last'), 'ben.ortiz@acme.com')
})

test('only personal addresses on the company domain count: role boxes and other domains are ignored', () => {
  const html = 'dana.lee@acme.com sales@acme.com info@acme.com pat.kim@uk.acme.com x.y@gmail.com mailto:ben.ortiz@ACME.com'
  assert.deepEqual(personalLocals(html, 'acme.com').sort(), ['ben.ortiz', 'dana.lee', 'pat.kim'])
})

test('a format needs 2+ supporting people and must be strictly ahead; otherwise no pattern', () => {
  const dana = { first: 'dana', last: 'lee' }, ben = { first: 'ben', last: 'ortiz' }, cara = { first: 'cara', last: 'diaz' }
  assert.deepEqual(inferPattern(['dana.lee', 'ben.ortiz'], [dana, ben, cara]), { format: 'first.last', support: 2 })
  assert.equal(inferPattern(['dana.lee'], [dana, ben]), null) // one example is not a pattern
  assert.equal(inferPattern(['dana.lee', 'bortiz'], [dana, ben]), null) // two formats, one each: ambiguous
  assert.equal(inferPattern(['someone.else', 'other.person'], [dana, ben]), null) // addresses not matching any listed person
})

const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>We have served the community for many years and we care about every family that walks through our doors every single day.</p>'
async function crawlFixture(env: Record<string, string>, address = '120 Main St, Austin, TX 78701') {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'Acme Logistics', null, 'Acme Logistics is hiring', 'https://news.example.test/a', 'Acme Logistics is hiring', 90, 80)
  const pages: Record<string, string> = {
    '/a': html('<a href="https://acmelogistics.com/">site</a>'),
    '/robots.txt': 'User-agent: *\nAllow: /',
    '/': html(`Acme Logistics ${address} <a href="/team">Team</a><a href="/contact">Contact</a>`),
    '/team': html(`${PROSE}<h3>Dana Lee</h3><p>CEO</p><h3>Ben Ortiz</h3><p>CFO</p><h3>Cara Diaz</h3><p>COO</p><p>Press: dana.lee@acmelogistics.com, ben.ortiz@acmelogistics.com</p>`),
    '/contact': html('<a href="mailto:hello@acmelogistics.com">hello</a>'),
  }
  const get: Get = async url => { const p = pages[new URL(url).pathname]; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env, now: Date.parse('2026-10-26T12:00:00Z') })
  return db
}

test('flag on: pattern and unverified candidates go to their own tables; lead_enrichments (shown and used by outreach) gets no guess', async () => {
  const db = await crawlFixture({ EMAIL_GUESS_ENABLED: '1' })
  assert.deepEqual(db.prepare('SELECT site, format, support FROM email_patterns').all(), [{ site: 'acmelogistics.com', format: 'first.last', support: 2 }])
  const cands = db.prepare('SELECT address, status FROM email_candidates ORDER BY address').all() as { address: string; status: string }[]
  assert.deepEqual(cands.map(c => c.address), ['ben.ortiz@acmelogistics.com', 'cara.diaz@acmelogistics.com', 'dana.lee@acmelogistics.com'])
  assert.ok(cands.every(c => c.status === 'unverified'))
  const prov = db.prepare('SELECT DISTINCT verification, country_basis FROM email_candidates').all()
  assert.deepEqual(prov, [{ verification: 'none', country_basis: 'homepage address: Austin, TX 78701' }])
  const enr = db.prepare("SELECT value FROM lead_enrichments WHERE kind NOT IN ('domain', 'domain_check', 'tech_scan')").all() as { value: string }[]
  assert.ok(enr.every(e => !e.value.includes('cara.diaz') && !e.value.includes('dana.lee@') && !e.value.includes('ben.ortiz@')), JSON.stringify(enr))
})

test('flag off (default): no tables, no candidates, crawl output unchanged', async () => {
  const db = await crawlFixture({})
  assert.equal((db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('email_patterns','email_candidates')").get() as { n: number }).n, 0)
  const enr = db.prepare("SELECT kind, value FROM lead_enrichments WHERE kind NOT IN ('domain', 'domain_check', 'tech_scan') ORDER BY kind, value").all()
  assert.deepEqual(enr, [{ kind: 'email', value: 'hello@acmelogistics.com' }, { kind: 'person', value: 'Ben Ortiz, CFO' }, { kind: 'person', value: 'Cara Diaz, COO' }, { kind: 'person', value: 'Dana Lee, CEO' }])
})

// ---- part 2: US only (docs/DECISIONS.md 2026-10-26). Unknown country = not US. ----
test('US-only: a US homepage address qualifies; Canada, a foreign scan geography or no address writes nothing', async () => {
  assert.deepEqual(usEvidence('Visit us at 9 Elm St, Brooklyn, NY 11201'), { us: true, basis: 'homepage address: Brooklyn, NY 11201' })
  assert.equal(usEvidence('100 King St W, Toronto, ON M5X 1A9').us, false)
  assert.equal(usEvidence('Toronto, ON M5X 1A9 and Buffalo, NY 14202').us, false) // a Canadian address present: refuse, do not guess
  assert.equal(usEvidence('Austin, TX 78701', ['Canada']).us, false)
  assert.equal(usEvidence('We ship worldwide').us, false)
  assert.equal(usEvidence(undefined).us, false)
  assert.equal(usEvidence('Springfield, ZZ 12345').us, false) // not a US state code
  for (const addr of ['100 King St W, Toronto, ON M5X 1A9', 'serving customers everywhere']) {
    const db = await crawlFixture({ EMAIL_GUESS_ENABLED: '1' }, addr)
    assert.equal((db.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'email_candidates'").get() as { n: number }).n, 0, addr)
  }
})

test('recordEmailGuesses writes nothing with the flag off, even when called directly', () => {
  const db = new Database(':memory:')
  const r = recordEmailGuesses(db, 'A', 'L1', 'acme.com', ['dana.lee', 'ben.ortiz'], ['Dana Lee, CEO', 'Ben Ortiz, CFO'], { env: {}, homeText: 'Austin, TX 78701' })
  assert.equal(r, null)
  assert.equal((db.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'email_candidates'").get() as { n: number }).n, 0)
})

// ---- part 3: mailbox verification, fail closed, capped. Fake verifiers only: no network, no paid call. ----
function seeded() {
  const db = new Database(':memory:')
  const on = { EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '10' }
  recordEmailGuesses(db, 'A', 'L1', 'acme.com', ['dana.lee', 'ben.ortiz'], ['Dana Lee, CEO', 'Ben Ortiz, CFO', 'Cara Diaz, COO', 'Eve Ng, CTO', 'Finn Roe, VP'], { env: on, homeText: '120 Main St, Austin, TX 78701' })
  return { db, on }
}
const fake = (answers: Record<string, VerifyAnswer | Error>, calls: string[] = []): MailboxVerifier => ({
  name: 'fake', async verify(a) { calls.push(a); const x = answers[a]; if (x instanceof Error) throw x; return x ?? { outcome: 'unknown' } },
})
const rows = (db: Database.Database) => db.prepare('SELECT address, verification, verifier, checked_at, country_basis FROM email_candidates ORDER BY address').all() as { address: string; verification: string; verifier: string | null; checked_at: number | null; country_basis: string | null }[]

test('only an explicit deliverable answer verifies; catch-all, undeliverable, unknown, refused and errors stay non-verified and are surfaced', async () => {
  const { db, on } = seeded()
  const v = fake({
    'dana.lee@acme.com': { outcome: 'deliverable' }, 'ben.ortiz@acme.com': { outcome: 'catch_all' }, 'cara.diaz@acme.com': { outcome: 'undeliverable' },
    'eve.ng@acme.com': new Error('timeout'), 'finn.roe@acme.com': { outcome: 'refused' },
  })
  const run = await verifyCandidates(db, 'A', 'L1', v, { env: on, now: Date.parse('2026-11-06T12:00:00Z') })
  assert.deepEqual(run, { checked: 5, verified: 1, capped: 0, skipped: null })
  const got = Object.fromEntries(rows(db).map(r => [r.address, r.verification]))
  assert.deepEqual(got, { 'ben.ortiz@acme.com': 'catch_all', 'cara.diaz@acme.com': 'undeliverable', 'dana.lee@acme.com': 'verified', 'eve.ng@acme.com': 'uncertain', 'finn.roe@acme.com': 'refused' })
  const labels = Object.fromEntries(rows(db).map(r => [r.address, candidateLabel(r)]))
  assert.equal(labels['dana.lee@acme.com'], 'guessed, verified')
  assert.equal(labels['ben.ortiz@acme.com'], 'guessed, catch-all')
  assert.equal(labels['eve.ng@acme.com'], 'guessed, uncertain')
  for (const r of rows(db)) assert.ok(r.verifier === 'fake' && r.checked_at && r.country_basis, 'provenance kept on every checked row')
  assert.ok(Object.values(labels).every(l => !/published/.test(l)))
  // A garbage answer is not a pass.
  const g = seeded()
  await verifyCandidates(g.db, 'A', 'L1', { name: 'odd', verify: async () => ({ outcome: 'yes' } as unknown as VerifyAnswer) }, { env: g.on })
  assert.ok(rows(g.db).every(r => r.verification === 'uncertain'))
})

test('a verified label needs its provenance; an unfinished (pending) check is never verified', () => {
  assert.equal(candidateLabel({ verification: 'verified', checked_at: null, verifier: 'x', country_basis: 'b' }), 'guessed, uncertain')
  assert.equal(candidateLabel({ verification: 'verified', checked_at: 1, verifier: 'x', country_basis: null }), 'guessed, uncertain')
  assert.equal(candidateLabel({ verification: 'pending', checked_at: 1, verifier: 'x', country_basis: 'b' }), 'guessed, uncertain')
  assert.equal(candidateLabel({ verification: 'none', checked_at: null, verifier: null, country_basis: 'b' }), 'guessed')
})

test('the daily cap is enforced in code before any call, per tenant, and persists across runs', async () => {
  const { db } = seeded()
  const calls: string[] = []
  const env = { EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '2' }, now = Date.parse('2026-11-06T12:00:00Z')
  const a = await verifyCandidates(db, 'A', 'L1', fake({}, calls), { env, now })
  assert.deepEqual(a, { checked: 2, verified: 0, capped: 3, skipped: null })
  const b = await verifyCandidates(db, 'A', 'L1', fake({}, calls), { env, now: now + 3600_000 })
  assert.equal(b.checked, 0); assert.equal(calls.length, 2)
  const c = await verifyCandidates(db, 'A', 'L1', fake({}, calls), { env, now: now + 86_400_000 }) // next UTC day
  assert.equal(c.checked, 2); assert.equal(calls.length, 4)
  // A provider call that never returns still holds its slot (reserved before the call).
  const d = seeded(); const hung: string[] = []
  const ac = new AbortController()
  const p = verifyCandidates(d.db, 'A', 'L1', { name: 'hang', verify: async (x) => { hung.push(x); ac.abort(); throw new Error('aborted') } }, { env: { ...env, EMAIL_VERIFY_DAILY_CAP: '1' }, now, signal: ac.signal })
  await p
  assert.equal(hung.length, 1)
  assert.equal((d.db.prepare("SELECT count(*) n FROM email_candidates WHERE checked_at IS NOT NULL").get() as { n: number }).n, 1)
})

test('nothing runs when off: flag off, no verifier, cap 0 (default); no provider is wired in production', async () => {
  const { db } = seeded()
  const calls: string[] = []
  assert.equal((await verifyCandidates(db, 'A', 'L1', fake({}, calls), { env: { EMAIL_VERIFY_DAILY_CAP: '5' } })).skipped, 'EMAIL_GUESS_ENABLED is off')
  assert.equal((await verifyCandidates(db, 'A', 'L1', fake({}, calls), { env: { EMAIL_GUESS_ENABLED: '1' } })).skipped, 'EMAIL_VERIFY_DAILY_CAP is 0')
  assert.equal((await verifyCandidates(db, 'A', 'L1', null, { env: { EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '5' } })).skipped, 'no verifier configured')
  assert.equal(calls.length, 0)
  assert.equal(verifierFromEnv({ EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '5', EMAIL_VERIFY_PROVIDER: 'anything' }), null)
  assert.ok(rows(db).every(r => r.verification === 'none' && r.checked_at === null))
})

test('a candidate without US provenance is never checked; other tenants are untouched', async () => {
  const { db, on } = seeded()
  migrateEmailGuess(db)
  db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format) VALUES ('A','L1','Zed Old, CEO','zed.old@acme.com','first.last')").run()
  db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis) VALUES ('B','L1','Bo B, CEO','bo.b@acme.com','first.last','homepage address: Austin, TX 78701')").run()
  const calls: string[] = []
  await verifyCandidates(db, 'A', 'L1', fake({}, calls), { env: on })
  assert.ok(!calls.includes('zed.old@acme.com') && !calls.includes('bo.b@acme.com'))
})

test('boundary: only the email finder module reads or writes the candidate tables', () => {
  const root = new URL('..', import.meta.url).pathname
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const f of readdirSync(join(root, dir))) {
      const rel = `${dir}/${f}`
      if (f === 'node_modules' || f.startsWith('.')) continue
      if (statSync(join(root, rel)).isDirectory()) walk(rel)
      else if (/\.(ts|tsx|mts)$/.test(f) && /email_candidates|email_patterns/.test(readFileSync(join(root, rel), 'utf8'))) hits.push(rel)
    }
  }
  walk('lib'); walk('app')
  assert.deepEqual(hits.filter(h => !h.startsWith('lib/db/')), ['lib/people/email-pattern.ts'])
})
