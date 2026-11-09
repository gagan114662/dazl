// #876 review findings on PR #1018 ("made their first sales hire"): the reviewer probes, committed as tests through the REAL functions
// (conditionProof with no gate fallback, applySalesHiringGate on an in-memory SQLite db, compileTargeting, corroborationTargets, halves, the fetch rank).
// 1. a hypothetical, another company's or a contracted-negation quote never proves a completed hire (targeting-proof.ts via quoteShowsCompletedHire);
// 2. the OR gate's completed-hire branch: an open vacancy never proves it, a dated completed-hire quote does (sales-hiring-gate.ts);
// 3. "may / will / might have made" compiles to no completed-hire condition (targeting.ts);
// 5. retrieval for a completed-hire branch asks for the hire, not for vacancies (halves.ts, corroborate.ts, runner.ts).
// Synthetic companies, network fenced, no model / provider / spend.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { compileTargeting, planConditions, type Condition } from '../lib/scan/targeting.ts'
import { conditionProof, type ProofLead } from '../lib/scan/targeting-proof.ts'
import { applySalesHiringGate, quoteShowsCompletedHire } from '../lib/scan/sales-hiring-gate.ts'
import { salesGateOr } from '../lib/scan/sales-hiring-required.ts'
import { corroborationTargets } from '../lib/scan/corroborate.ts'
import { compoundHalves, halvesBlock } from '../lib/scan/halves.ts'
import { jobPagesBehindEvents } from '../lib/scan/runner.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'

const NOW = Date.parse('2026-11-09T12:00:00Z')
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString().slice(0, 10)
const OR_B = 'London B2B SaaS startups that raised seed funding or made their first sales hire in the last 90 days'
const OPEN_OR = 'London B2B SaaS startups that raised seed funding or are hiring sales staff in the last 90 days'
const AND_B = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days and are hiring sales staff.'
const ICP_B = JSON.stringify({ summary: 'London B2B SaaS startups', where: ['London, UK'], who: ['Founder', 'Head of Sales'], signals: ['raised seed funding in the last 90 days', 'made their first sales hire in the last 90 days'], exclude: ['agencies'] })
const hire = (): Condition => planConditions(compileTargeting(OR_B, ICP_B).root).find(x => x.cond.kind === 'hire_made')!.cond
const lead = (q: string, company = 'Pastco'): ProofLead => ({ company, company_domain: `${company.toLowerCase()}.example`, evidence_excerpt: q, signal: 'made its first sales hire', source_url: 'https://news.example/pastco', event_date: ago(11) })
const ctx = { query: OR_B, icp: ICP_B, salesGatePassed: false, competitors: null, graded: true, now: NOW }
const truth = (q: string, company = 'Pastco') => conditionProof(hire(), lead(q, company), [], ctx).truth

// ---- finding 1: the clause proof ----
test('P0 control: an affirmative, own-company completed first sales hire passes conditionProof', () => {
  assert.equal(truth('Pastco made its first sales hire.'), 'pass')
  assert.equal(truth('Pastco, a London B2B SaaS company, hired its first sales rep, Jane Doe, in October.'), 'pass')
  assert.equal(truth('Jane Doe joined Pastco as its first sales hire.'), 'pass')
})
test('P1 a hypothetical ("If Pastco makes its first sales hire") is not proof', () => {
  for (const q of ['If Pastco makes its first sales hire, revenue grows.', 'Once Pastco makes its first sales hire, it will expand.', 'Pastco should make its first sales hire soon.', 'Unless Pastco made its first sales hire, nothing changes.', 'Whether Pastco made its first sales hire is unclear.'])
    assert.equal(truth(q), 'unknown', q)
})
test('P2 another company\'s hire is not proof for this lead (subject binding, including the object-only mention)', () => {
  for (const q of ['Otherco made its first sales hire; Pastco sells payroll software.', 'Otherco hired Pastco\u2019s first sales rep.', 'Otherco hired a former Pastco sales rep as its first sales hire.', 'Otherco made its first sales hire, poaching a rep from Pastco.'])
    assert.equal(truth(q), 'unknown', q)
})
test('P3 contracted negations ("hasn\'t made", curly apostrophe, "didn\'t") are not proof', () => {
  for (const q of ["Pastco hasn't made its first sales hire.", 'Pastco hasn\u2019t made its first sales hire.', "Pastco didn't hire its first sales rep.", 'Pastco has not made its first sales hire.', 'Pastco cannot make its first sales hire yet.', "Pastco hasn't yet made its first sales hire"])
    assert.equal(truth(q), 'unknown', q)
})
test('finding 1 malformed quotes fail closed and never throw', () => {
  for (const q of ['', ' ', '\u0000\ud800', 'made hire', 'x'.repeat(200_000), 'If '.repeat(50_000) + 'Pastco made its first sales hire']) assert.equal(truth(q), 'unknown', q.slice(0, 40))
  const t0 = Date.now(); assert.equal(truth('x '.repeat(100_000) + '. Pastco made its first sales hire.'), 'pass', 'a huge quote is read and its last clause still counts'); assert.ok(Date.now() - t0 < 5000)
  for (const v of [null, undefined, 42, {}, []] as unknown[]) assert.equal(quoteShowsCompletedHire(v as string, 'Pastco', ['sales'], true), false)
  assert.equal(quoteShowsCompletedHire('Pastco made its first sales hire.', null, ['sales'], true), true, 'no company name: no other-company subject can be found (as subjectIsOther)')
  assert.equal(truth('Pastco made its first sales hire.', 'Otherco'), 'unknown', 'another lead\'s own name in front of the verb')
})

// ---- finding 3: the compiler ----
test('P4 "may / will / might / must have made" and "may have hired" compile to NO positive completed-hire condition, and the ambiguity is recorded', () => {
  for (const q of ['startups that may have made their first sales hire', 'startups that will have made their first sales hire', 'startups that might have just made their first sales hire', 'startups that must have made a sales hire', 'startups that could have hired their first VP of Sales', 'startups that may not have made their first sales hire', 'startups whose first account executive may have been hired']) {
    const p = compileTargeting(q)
    const c = planConditions(p.root)
    assert.ok(!c.some(x => x.cond.kind === 'hire_made' && !x.negated), `${q}: ${JSON.stringify(c.map(x => [x.negated, x.cond.kind]))}`)
    assert.ok(!c.some(x => x.cond.kind === 'hiring'), `${q}: no open-role reading invented`)
    if (!/been hired/.test(q)) assert.ok(p.ambiguities.some(a => /may not have happened/.test(a.readings.join(' '))), q)
  }
  // Test B with a modal hire is not an OR with a completed-hire branch; the plain wording still is.
  assert.equal(salesGateOr('London B2B SaaS startups that raised seed funding or may have made their first sales hire in the last 90 days', ICP_B), null)
  assert.equal(salesGateOr(OR_B, ICP_B)?.hiring.kind, 'hire_made')
  // Controls: the completed wordings are unchanged.
  for (const q of ['startups that made their first sales hire', 'startups that have made their first sales hire', 'startups that hired their first VP of Sales', 'startups that have hired their first VP of Sales'])
    assert.ok(planConditions(compileTargeting(q).root).some(x => x.cond.kind === 'hire_made' && !x.negated), q)
})

// ---- finding 2: the OR gate ----
function setup(excerpt: string, company = 'Hireco', query = OR_B) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', query = ?, icp = ? WHERE id = ?").run(query, ICP_B, jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, confidence, score, why, event_date, date_status) VALUES ('L1', ?, '', ?, NULL, 'signal', 'https://news.example/1', ?, 80, 80, '', ?, 'verified')").run(jobId, company, excerpt, ago(20))
  db.prepare("UPDATE scan_jobs SET status = 'done', verified = 1, needs_review = 0 WHERE id = ?").run(jobId)
  return { db, job: { id: jobId, user_id: 'u1', query, icp: ICP_B } }
}
const noNet = (async () => { throw new Error('no network') }) as never
const reason = (db: Database.Database) => (db.prepare("SELECT review_reason FROM leads WHERE id = 'L1'").get() as { review_reason: string | null }).review_reason
test('G1 the OR gate: an OPEN first-sales vacancy does not prove the completed-hire branch (demoted)', async () => {
  const s = setup('Hireco, a London B2B SaaS company, is hiring its first Sales Representative to join the founders.')
  const r = await applySalesHiringGate(s.db, s.job, noNet, { now: NOW })
  assert.deepEqual([r.passed, r.demoted], [0, 1]); assert.equal(reason(s.db), 'no_sales_hiring_evidence')
})
test('G2 the OR gate: a dated completed first sales hire quote passes the hire branch', async () => {
  const s = setup('Pastco, a London B2B SaaS company, hired its first sales rep, Jane Doe, in October.', 'Pastco')
  const r = await applySalesHiringGate(s.db, s.job, noNet, { now: NOW })
  assert.deepEqual([r.passed, r.demoted], [1, 0]); assert.equal(reason(s.db), null)
})
test('G3 the OR gate: hypothetical, other-company and contracted-negation hire quotes are demoted', async () => {
  for (const [q, co] of [['If Pastco makes its first sales hire, revenue grows.', 'Pastco'], ['Otherco made its first sales hire; Pastco sells payroll software.', 'Pastco'], ["Pastco hasn't made its first sales hire.", 'Pastco']]) {
    const s = setup(q, co); const r = await applySalesHiringGate(s.db, s.job, noNet, { now: NOW })
    assert.deepEqual([r.passed, r.demoted], [0, 1], q)
  }
})
test('G4 control: an open-role OR ("or are hiring sales staff") still accepts the open vacancy quote', async () => {
  assert.equal(salesGateOr(OPEN_OR, ICP_B)?.hiring.kind, 'hiring')
  const s = setup('Hireco, a London B2B SaaS company, is hiring its first Sales Representative to join the founders.', 'Hireco', OPEN_OR)
  const r = await applySalesHiringGate(s.db, s.job, noNet, { now: NOW })
  assert.deepEqual([r.passed, r.demoted], [1, 0])
})

// ---- finding 5: retrieval ----
test('R1 halves: a completed-hire OR asks the extraction for a hire that was MADE, an open-role OR keeps the vacancy wording', () => {
  const h = compoundHalves(OR_B, ICP_B, {})!
  assert.equal(h.done, true); assert.match(halvesBlock(h), /MADE a sales \/ go-to-market hire \(a completed hire, not an open vacancy or job ad\)/); assert.doesNotMatch(halvesBlock(h), /is hiring sales/)
  const o = compoundHalves(OPEN_OR, ICP_B, {})!
  assert.equal(o.or, true); assert.equal(o.done, undefined); assert.match(halvesBlock(o), /the company is hiring sales \/ go-to-market staff/)
})
test('R2 corroborate: under a completed-hire OR an open-vacancy candidate is searched for the completed hire, not skipped as proven, and never as "hiring sales"', () => {
  const board = { company: 'Boardco', excerpt: 'Boardco is hiring an Account Executive in London. Join the sales team', signal: 'is hiring an account executive' }
  const vac = { company: 'Hireco', excerpt: 'Hireco, a London B2B SaaS startup, is hiring its first Sales Account Executive', signal: 'is hiring its first sales rep' }
  const done = { company: 'Pastco', excerpt: 'Pastco, a London B2B SaaS startup, made its first sales hire, appointing a Head of Sales', signal: 'made its first sales hire' }
  const t = corroborationTargets({ query: OR_B, icp: ICP_B }, [board, { ...board, company: 'Boardco2' }], [vac, done])
  assert.deepEqual(t, [{ company: 'Boardco', branch: 'hiring', query: '"Boardco" first sales hire hired' }, { company: 'Boardco2', branch: 'hiring', query: '"Boardco2" first sales hire hired' }])
  const t1 = corroborationTargets({ query: OR_B, icp: ICP_B }, [{ ...board, excerpt: 'Boardco sells software', signal: 'software' }, { ...board, company: 'X2', excerpt: 'X2', signal: 'x' }], [vac, done])
  assert.deepEqual(t1.map(x => x.company), ['Hireco'], 'the open-vacancy candidate is searched; the completed-hire candidate is already proven')
  assert.ok(t1.every(x => !/hiring sales/.test(x.query)))
  // Open-role OR: unchanged (the vacancy already proves its branch; searches say "hiring sales").
  const o = corroborationTargets({ query: OPEN_OR, icp: ICP_B }, [{ ...board, excerpt: 'Boardco sells software', signal: 'software' }, { ...board, company: 'X2', excerpt: 'X2', signal: 'x' }], [vac, { ...vac, company: 'Claimco', excerpt: 'Claimco recruits', signal: 'recruiting sales' }])
  assert.ok(o.length > 0 && o.every(x => x.branch === 'hiring' && /" hiring sales$/.test(x.query)), JSON.stringify(o))
})
test('R3 fetch rank: a completed-hire OR keeps job pages behind the event pages (a vacancy cannot prove it); an open-role OR does not; AND does', () => {
  const sig = JSON.parse(ICP_B).signals as string[]
  assert.equal(jobPagesBehindEvents(sig, OR_B, ICP_B), true)
  assert.equal(jobPagesBehindEvents(['raised seed funding in the last 90 days', 'hiring sales staff'], OPEN_OR, ICP_B), false)
  assert.equal(jobPagesBehindEvents(['raised seed funding in the last 90 days', 'hiring sales staff'], AND_B, ICP_B), true)
  for (const icp of ['not json', '[1]', 'null']) assert.equal(jobPagesBehindEvents(sig, OR_B, icp), true, 'an unreadable profile is the AND rule')
  assert.equal(jobPagesBehindEvents(undefined, null, '{}'), false)
})
