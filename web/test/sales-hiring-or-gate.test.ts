// #380 / #204 Test B: "seed funding OR first sales hire". The sales-hiring gate follows the request's compiled targeting plan (targeting.ts):
// when the plan puts the funding condition and the sales-hiring condition under one OR, proof of either branch, each on its own clock, is enough.
// The AND wording, the ambiguous "and/or" (read as AND) and a request the gate does not cover (Test A) keep today's behaviour exactly.
// Every other check still runs: quote, stage, negation / plans, date, window, place, the lead's own identity, the board cap and board failures.
// Stubbed boards, invented companies, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { applySalesHiringGate } from '../lib/scan/sales-hiring-gate.ts'
import { compileTargeting, planConditions } from '../lib/scan/targeting.ts'
import { conditionProof } from '../lib/scan/targeting-proof.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'

const NOW = Date.parse('2026-11-04T12:00:00Z')
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10)
// Test B, verbatim (#204 fixed brief, the #349 London request).
const OR_B = 'London B2B SaaS startups that raised seed funding or made their first sales hire in the last 90 days'
const ICP_B = JSON.stringify({ summary: 'London B2B SaaS startups', where: ['London, UK'], who: ['Founder', 'Head of Sales'], signals: ['raised seed funding in the last 90 days', 'made their first sales hire in the last 90 days'], exclude: ['agencies'] })
// The 10-26 AND wording and the ambiguous and/or.
const AND_B = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days and are hiring sales staff.'
const ANDOR_B = 'London B2B SaaS startups that raised seed funding and/or made their first sales hire in the last 90 days'
const TEST_A = 'Find independent dental practices in New York, NY that opened a new location or are hiring a front desk receptionist in the last 90 days. We sell dental appointment and reminder software.'

const SEED = (co: string, place = 'London') => `${co}, a ${place} B2B SaaS startup, raised a £2m seed round led by Example Ventures.`
const HIRE = (co: string) => `${co}, a London B2B SaaS company, made its first sales hire, bringing a Sales Representative in alongside the founders.`
// An OPEN vacancy: not a completed hire (#876), so it never proves Test B's hiring branch.
const OPEN = (co: string) => `${co}, a London B2B SaaS company, is hiring its first Sales Representative to join the founders.`

interface Lead { id?: string; company?: string; domain?: string | null; excerpt: string; date?: string | null; signal?: string }
function setup(query: string, leads: Lead[], icp: string | null = ICP_B) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', query = ?, icp = ? WHERE id = ?").run(query, icp, jobId)
  leads.forEach((l, i) => db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, confidence, score, why, event_date, date_status) VALUES (?, ?, '', ?, ?, ?, ?, ?, 80, ?, '', ?, 'verified')")
    .run(l.id ?? `L${i + 1}`, jobId, l.company ?? 'Synthco', l.domain ?? null, l.signal ?? 'signal', `https://news.example/${i + 1}`, l.excerpt, 80 - i, l.date === undefined ? day(20) : l.date))
  db.prepare("UPDATE scan_jobs SET status = 'done', verified = ?, needs_review = 0 WHERE id = ?").run(leads.length, jobId)
  return { db, job: { id: jobId, user_id: 'u1', query, icp } }
}
const reason = (db: Database.Database, id = 'L1') => (db.prepare('SELECT review_reason FROM leads WHERE id = ?').get(id) as { review_reason: string | null }).review_reason
const why = (db: Database.Database, id = 'L1') => (db.prepare('SELECT why FROM leads WHERE id = ?').get(id) as { why: string }).why
const noNet = (async () => { throw new Error('no network') }) as never
const notFound = (seen: string[] = []) => (async (u: RequestInfo | URL) => { seen.push(String(u)); return new Response('nope', { status: 404 }) }) as never
const run = (s: ReturnType<typeof setup>, fetchImpl: typeof fetch = noNet) => applySalesHiringGate(s.db, s.job, fetchImpl, { now: NOW })

test('Test B text compiles to (seed funding, 90 days) OR (first sales hire, 90 days)', () => {
  const p = compileTargeting(OR_B, ICP_B)
  assert.equal(p.root?.op, 'or')
  const c = planConditions(p.root).map(x => [x.cond.kind, x.cond.stage ?? x.cond.role, x.cond.within_days, x.negated])
  // #876: "made their first sales hire" is a completed hire (hire_made), not an open role; the OR shape is unchanged.
  assert.deepEqual(c, [['funding', 'seed', 90, false], ['hire_made', 'sales', 90, false]])
  assert.equal(compileTargeting(AND_B, ICP_B).root?.op, 'and')
  assert.equal(compileTargeting(ANDOR_B, ICP_B).root?.op, 'and', 'and/or takes the narrow reading')
})

test('OR: a seed-only lead (in-window, London, its own quote) is NOT demoted no_sales_hiring_evidence', async () => {
  const s = setup(OR_B, [{ excerpt: SEED('Synthco') }])
  const r = await run(s)
  assert.deepEqual([r.required, r.passed, r.demoted], [true, 1, 0])
  assert.equal(reason(s.db), null)
})

test('OR: a hire-only lead (dated first sales hire, no funding quote) is NOT demoted no_event_evidence', async () => {
  const s = setup(OR_B, [{ company: 'Hireco', excerpt: HIRE('Hireco') }])
  const r = await run(s)
  assert.deepEqual([r.required, r.passed, r.demoted], [true, 1, 0])
  assert.equal(reason(s.db), null)
})

test('OR: a dated posting on the lead\u2019s own job board does NOT prove a completed hire (#876): demoted, no board lookup', async () => {
  const seen: string[] = []
  const s = setup(OR_B, [{ company: 'Brightloop', domain: 'brightloop.io', excerpt: 'Brightloop is a London B2B SaaS platform for finance teams.' }])
  const r = await run(s, notFound(seen))
  assert.deepEqual([r.passed, r.demoted], [0, 1]); assert.equal(reason(s.db), 'no_sales_hiring_evidence'); assert.match(why(s.db), /completed-hire/)
  assert.equal(seen.length, 0, 'an open board cannot prove a completed hire, so it is never fetched')
})

test('OR: an OPEN vacancy quote ("is hiring its first Sales Representative") is not a completed hire: demoted', async () => {
  const s = setup(OR_B, [{ company: 'Hireco', excerpt: OPEN('Hireco') }])
  const r = await run(s)
  assert.deepEqual([r.passed, r.demoted], [0, 1]); assert.equal(reason(s.db), 'no_sales_hiring_evidence')
})

test('OR: hypothetical, other-company and planned hire quotes are demoted; the own-company affirmative control passes (reviewer probes)', async () => {
  const cases: [string, string, boolean][] = [
    ['If Pastco makes its first sales hire, revenue grows.', 'Pastco', false],
    ['Otherco made its first sales hire; Pastco sells payroll software.', 'Pastco', false],
    ['Pastco plans to make its first sales hire.', 'Pastco', false],
    ['Pastco has not made its first sales hire.', 'Pastco', false],
    ['Pastco made its first sales hire.', 'Pastco', true],
    ['Jane Doe joined Pastco as its first sales hire.', 'Pastco', true],
  ]
  for (const [q, co, ok] of cases) {
    const s = setup(OR_B, [{ company: co, excerpt: q }]); const r = await run(s)
    assert.deepEqual([r.passed, r.demoted], ok ? [1, 0] : [0, 1], q)
    const p = conditionProof(planConditions(compileTargeting(OR_B, ICP_B).root).find(x => x.cond.kind === 'hire_made')!.cond, { company: co, company_domain: null, evidence_excerpt: q, event_date: day(20), source_url: 'https://news.example/1', signal: 's' } as never, [], { now: NOW } as never)
    assert.equal(p.truth === 'pass', ok, `conditionProof: ${q}`)
  }
})

// That request names a role ("sales representative"), so its hiring branch needs a source-matched posting (the existing requested-role rule): a quote alone
// does not prove it. hireonly is therefore still held, but for the missing role match - never for the funding it no longer needs.
test('the audit probe (204-or-gate-probe.mts): seedonly is not demoted; hireonly is not demoted no_event_evidence', async () => {
  const PROBE = 'Find B2B SaaS startups in London, UK that raised seed funding or are hiring their first sales representative in the last 90 days. We sell CRM setup and outbound sales consulting. Exclude agencies, directories and companies outside the UK. Show dated source evidence and founder or head of sales contacts.'
  const icp = JSON.stringify({ where: ['London, UK'], signals: ['raised seed funding in the last 90 days', 'hiring first sales representative'] })
  const s = setup(PROBE, [{ id: 'seedonly', excerpt: `London-based Synthco, a B2B SaaS startup, raised a £2m seed round on ${day(20)}.` }, { id: 'hireonly', company: 'Hireco', excerpt: HIRE('Hireco') }], icp)
  const r = await run(s)
  assert.deepEqual([r.required, r.passed, r.demoted], [true, 1, 1])
  assert.deepEqual([reason(s.db, 'seedonly'), reason(s.db, 'hireonly')], [null, 'no_sales_hiring_evidence'])
  assert.match(why(s.db, 'hireonly'), /requested role \(sales representative\)/)
})

test('AND (10-26 wording) unchanged: seed-only -> no_sales_hiring_evidence, hire-only -> no_event_evidence', async () => {
  const a = setup(AND_B, [{ excerpt: SEED('Synthco') }]); await run(a)
  assert.equal(reason(a.db), 'no_sales_hiring_evidence')
  const b = setup(AND_B, [{ company: 'Hireco', excerpt: HIRE('Hireco') }]); await run(b)
  assert.equal(reason(b.db), 'no_event_evidence')
})

test('ambiguous and/or takes the AND reading: seed-only and hire-only are both demoted as today', async () => {
  const a = setup(ANDOR_B, [{ excerpt: SEED('Synthco') }]); await run(a)
  assert.equal(reason(a.db), 'no_sales_hiring_evidence')
  const b = setup(ANDOR_B, [{ company: 'Hireco', excerpt: HIRE('Hireco') }]); await run(b)
  assert.equal(reason(b.db), 'no_event_evidence')
})

test('Test A control: the gate is not required and writes nothing', async () => {
  const s = setup(TEST_A, [{ company: 'Bright Smiles Dental', excerpt: 'Bright Smiles Dental opened a new location in Brooklyn, New York.' }], JSON.stringify({ where: ['New York, NY'], signals: ['opened a new location', 'hiring a front desk receptionist'] }))
  const r = await run(s)
  assert.deepEqual(r, { required: false, checked: 0, passed: 0, demoted: 0, demotions: [] })
  assert.equal(reason(s.db), null)
})

test('OR, neither branch proven: demoted, and the reason names both missing branches', async () => {
  const s = setup(OR_B, [{ company: 'Nilco', excerpt: 'Nilco, a London B2B SaaS startup, launched a new analytics dashboard for finance teams.' }])
  const r = await run(s)
  assert.deepEqual([r.passed, r.demoted], [0, 1])
  assert.equal(reason(s.db), 'no_sales_hiring_evidence')
  assert.match(why(s.db), /seed round/); assert.match(why(s.db), /sales-hiring evidence/); assert.match(why(s.db), /either/)
})

test('OR, wrong funding stage / negated raise / planned raise: demoted', async () => {
  for (const excerpt of ['Synthco, a London B2B SaaS startup, raised a £10m Series A round.', 'Synthco, a London B2B SaaS startup, has not raised a seed round.', 'Synthco, a London B2B SaaS startup, plans to raise a seed round next year.']) {
    const s = setup(OR_B, [{ excerpt }]); const r = await run(s)
    assert.deepEqual([excerpt, r.passed, reason(s.db)], [excerpt, 0, 'no_sales_hiring_evidence'])
  }
})

test('OR, undated or out-of-window event: demoted (each branch keeps its own 90-day clock)', async () => {
  for (const date of [null, day(120)]) {
    const seed = setup(OR_B, [{ excerpt: SEED('Synthco'), date }]); await run(seed)
    assert.equal(reason(seed.db), 'no_sales_hiring_evidence', `seed ${date}`)
    const hire = setup(OR_B, [{ company: 'Hireco', excerpt: HIRE('Hireco'), date }]); await run(hire)
    assert.equal(reason(hire.db), 'no_sales_hiring_evidence', `hire ${date}`)
  }
})

test('OR, a non-sales role is not the hiring branch: demoted', async () => {
  const s = setup(OR_B, [{ company: 'Hireco', excerpt: 'Hireco, a London B2B SaaS company, is hiring its first software engineer.' }])
  const r = await run(s); assert.deepEqual([r.passed, reason(s.db)], [0, 'no_sales_hiring_evidence'])
})

test('OR, another company\u2019s quote proves nothing for this lead: demoted', async () => {
  const a = setup(OR_B, [{ excerpt: SEED('Othercorp') }]); await run(a)
  assert.equal(reason(a.db), 'no_sales_hiring_evidence')
  const b = setup(OR_B, [{ company: 'Hireco', excerpt: HIRE('Othercorp') }]); await run(b)
  assert.equal(reason(b.db), 'no_sales_hiring_evidence')
})

test('OR, a seed quote from another place fails the event-place check: demoted', async () => {
  const s = setup(OR_B, [{ excerpt: SEED('Synthco', 'Paris') }]); await run(s)
  assert.equal(reason(s.db), 'no_sales_hiring_evidence')
})

test('OR, with a completed-hire branch no job board is ever looked up (many leads, none fetched)', async () => {
  const leads = Array.from({ length: 21 }, (_, i) => ({ id: `L${i + 1}`, company: `Boardco${i + 1}`, domain: `boardco${i + 1}.io`, excerpt: `Boardco${i + 1} is a London B2B SaaS platform.` }))
  const seen: string[] = []
  const s = setup(OR_B, leads); const r = await run(s, notFound(seen))
  assert.deepEqual([r.passed, r.demoted], [0, 21])
  assert.equal(seen.length, 0)
})

test('a malformed profile falls back to AND: the seed-only lead is demoted as today', async () => {
  for (const icp of ['{not json', '[1,2]']) {
    const s = setup(OR_B, [{ excerpt: SEED('Synthco') }], icp); await run(s)
    assert.equal(reason(s.db), 'no_sales_hiring_evidence', icp)
  }
})

test('a plan the gate cannot read as one funding-OR-sales-hiring choice falls back to AND', async () => {
  // a third, unrelated OR branch (a technology) is not something the gate checks: both halves stay required
  const q = 'London B2B SaaS startups that raised seed funding or made their first sales hire or use HubSpot in the last 90 days'
  const s = setup(q, [{ excerpt: SEED('Synthco') }]); await run(s)
  assert.equal(reason(s.db), 'no_sales_hiring_evidence')
})

test('OR: the gate pass record no longer stands in for the branch it did not check (targeting proof)', () => {
  const plan = compileTargeting(OR_B, ICP_B)
  const hiring = planConditions(plan.root).find(x => x.cond.kind === 'hire_made')!.cond   // #876: Test B's hiring branch is a completed hire
  const lead = { company: 'Synthco', company_domain: null, evidence_excerpt: SEED('Synthco'), signal: 'raised seed', source_url: 'https://news.example/1', event_date: day(20) }
  const p = conditionProof(hiring, lead, [], { query: OR_B, icp: ICP_B, salesGatePassed: true, competitors: null, graded: true, now: NOW })
  assert.equal(p.truth, 'unknown')
})
