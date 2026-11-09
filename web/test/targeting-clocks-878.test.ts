// #878: per-condition date clocks. Every window the request binds to a condition counts (a second, narrower one is never silently
// dropped, in either order), a clock relative to another condition's event is checked for EVERY condition kind, and each clause's stored
// row says which evidence date that condition was checked on, or that it has none. Pure compiler/proof tests plus the real actionability
// writer on in-memory SQLite. Invented companies, no network, no model, no provider.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { compileTargeting, describePlan, evaluatePlan, planConditions, type Condition, type QueryPlan } from '../lib/scan/targeting.ts'
import { conditionProof, planProofs, type ProofLead, type ProofRow } from '../lib/scan/targeting-proof.ts'
import { recordActionability, targetingClauseRow } from '../lib/scan/actionable.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateMemory } from '../lib/memory.ts'
import { planNeedSupport } from '../lib/scan/need-evidence.ts'
import { salesGateOr } from '../lib/scan/sales-hiring-required.ts'

const NOW = Date.parse('2026-10-28T12:00:00Z')
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString().slice(0, 10)
const conds = (p: QueryPlan) => planConditions(p.root).map(x => x.cond)
const ctx = { query: 'x', icp: null, salesGatePassed: false, competitors: null, now: NOW }
const lead = (quote: string, date: string | null, company = 'Brightloop'): ProofLead => ({ company, company_domain: 'brightloop.example', evidence_excerpt: quote, signal: null, source_url: 'https://news.example/b', event_date: date })

// The audit's exact counterexample (#878 comment, audit 9379b162): the later 30-day restriction was silently ignored, ambiguities [].
const AUDIT = 'Companies that raised seed funding within 90 days, specifically within 30 days, and hired a VP within 20 days'
const REVERSED = 'Companies that raised seed funding within 30 days, specifically within 90 days, and hired a VP within 20 days'

test('two windows on one condition: the narrowest holds in either order, the ambiguity is recorded and the description says the clock', () => {
  for (const q of [AUDIT, REVERSED]) {
    const p = compileTargeting(q)
    const [seed, vp] = conds(p)
    assert.deepEqual([seed.kind, seed.within_days, seed.window_source], ['funding', 30, 'narrowest'], q)
    assert.deepEqual([vp.kind, vp.within_days, vp.window_source], ['hire_made', 20, 'clause'], 'the VP clause keeps its own clock')
    assert.equal(p.ambiguities.length, 1)
    assert.deepEqual(p.ambiguities[0].readings.sort(), ['within 30 days', 'within 90 days'])
    assert.match(p.ambiguities[0].chosen, /^within 30 days \(the narrowest/)
    assert.match(describePlan(p.root), /^\(C1 raised seed funding within \d+ days, specifically within \d+ days \(within 30 days\) AND C2 hired a VP within 20 days\)$/)
    assert.equal(p.explicit, true)
    assert.deepEqual(planNeedSupport(p), { support: 'none', reason: 'plan_ambiguous' }, 'an ambiguous plan is never hiring-need support')
  }
})

test('proof: a raise 45 days old does not pass the narrowed 30-day clock; 25 days old does; the VP clause is checked on its own 20-day clock', () => {
  const quote = 'Brightloop raised a 3m seed round and hired a VP of Sales, Jane Doe.'
  for (const q of [AUDIT, REVERSED]) {
    const p = compileTargeting(q)
    const at45 = planProofs(p, lead(quote, ago(45)), [], ctx)
    assert.equal(at45.C1.truth, 'unknown', `45 days is outside the 30-day clock (${q})`)
    assert.match(at45.C1.reason, /outside this condition's 30-day window/)
    const at25 = planProofs(p, lead(quote, ago(25)), [], ctx)
    assert.deepEqual([at25.C1.truth, at25.C1.date, at25.C2.truth], ['pass', ago(25), 'unknown'], '25 days: inside the seed clock, outside the VP clock')
    const at5 = planProofs(p, lead(quote, ago(5)), [], ctx)
    assert.deepEqual([at5.C1.truth, at5.C2.truth, evaluatePlan(p, at5).truth], ['pass', 'pass', 'pass'])
  }
})

test('a single condition with two windows becomes an explicit plan gate (other gates read only the first window)', () => {
  const p = compileTargeting('startups hiring SDRs within 90 days, specifically within 30 days')
  const [c] = conds(p)
  assert.deepEqual([c.kind, c.within_days, c.window_source, p.explicit], ['hiring', 30, 'narrowest', true])
  const rows = (date: string): ProofRow[] => [{ connector: 'signals:greenhouse-gtm', kind: 'hiring', value: 'SDR - posted', source_url: 'https://boards.example/brightloop/sdr', source_date: date }]
  assert.equal(conditionProof(c, lead('', null), rows(ago(45)), ctx).truth, 'unknown', 'a posting 45 days old is outside the 30-day clock')
  assert.deepEqual([conditionProof(c, lead('', null), rows(ago(10)), ctx).truth, conditionProof(c, lead('', null), rows(ago(10)), ctx).date], ['pass', ago(10)])
  // the same window stated twice is one clock, not an ambiguity
  const same = compileTargeting('startups hiring SDRs in the last 30 days (posted within the last 30 days)')
  assert.deepEqual([conds(same)[0].within_days, conds(same)[0].window_source, same.ambiguities.length], [30, 'clause', 0])
})

test('a request-level window narrower than a condition\'s own window bounds it too', () => {
  const p = compileTargeting('In the last 30 days, startups that raised seed funding within 90 days and are hiring SDRs')
  const [seed, hiring] = conds(p)
  assert.deepEqual([seed.within_days, seed.window_source, hiring.within_days], [30, 'narrowest', 30])
  assert.equal(p.ambiguities.length, 1)
  // a wider request-level window never widens a condition's own clock
  const w = conds(compileTargeting('In the last 90 days, startups that raised seed funding within 30 days and are hiring SDRs'))
  assert.equal(w[0].within_days, 30)
})

test('relative clock plus a now-window: both hold, in either order (the relation is never dropped)', () => {
  for (const q of ['startups that hired a first VP of Sales within 30 days of the raise, in the last 14 days, and raised a seed round',
    'startups that hired a first VP of Sales in the last 14 days, within 30 days of the raise, and raised a seed round']) {
    const p = compileTargeting(q)
    const [vp, seed] = conds(p)
    assert.deepEqual([vp.kind, vp.relative_to, vp.within_days, vp.since_days, seed.kind], ['hire_made', 'C2', 30, 14, 'funding'], q)
    assert.equal(p.ambiguities.length, 0, 'a gap clock and a now clock are two clocks, not an ambiguity')
    const quote = 'Brightloop hired its first VP of Sales, Jane Doe.'
    // hire 10 days ago, raise 30 days ago: gap 20 <= 30 and inside the last 14 days
    assert.equal(conditionProof(vp, lead(quote, ago(10)), [], ctx, { C2: ago(30) }).truth, 'pass', q)
    // hire 20 days ago: gap fine, but outside the stated 14-day now-clock
    const late = conditionProof(vp, lead(quote, ago(20)), [], ctx, { C2: ago(40) })
    assert.equal(late.truth, 'unknown'); assert.match(late.reason, /outside this condition's 14-day window/)
    // hire 10 days ago, raise 50 days ago: gap 40 > 30
    const far = conditionProof(vp, lead(quote, ago(10)), [], ctx, { C2: ago(50) })
    assert.equal(far.truth, 'unknown'); assert.match(far.reason, /not within 30 days after C2/)
    // anchor undated, or the same date as the hire (one source cannot date both)
    assert.equal(conditionProof(vp, lead(quote, ago(10)), [], ctx, {}).truth, 'unknown')
    assert.equal(conditionProof(vp, lead(quote, ago(10)), [], ctx, { C2: ago(10) }).truth, 'unknown')
    assert.match(describePlan(p.root), /C1 hired a first VP of Sales/)
  }
  // a request-level window bounds a relative condition's now-clock too, and the description says both clocks
  const lead14 = compileTargeting('In the last 14 days, startups that hired a first VP of Sales within 30 days of the raise and raised a seed round')
  assert.deepEqual([conds(lead14)[0].relative_to, conds(lead14)[0].within_days, conds(lead14)[0].since_days], ['C2', 30, 14])
  assert.match(describePlan(lead14.root), /^\(C1 hired a first VP of Sales within 30 days of the raise \(within 30 days of C2, and within the last 14 days\) AND C2 raised a seed round \(within 14 days\)\)$/)
  // a stated now-window WIDER than the relative clock does not widen the now-clock (it stays the condition's own window, as before)
  const wide = conds(compileTargeting('startups that hired a first VP of Sales within 30 days of the raise, in the last 90 days, and raised a seed round'))[0]
  assert.deepEqual([wide.within_days, wide.since_days], [30, undefined])
})

test('a clock relative to another event is checked for every condition kind, not only a completed hire', () => {
  const p = compileTargeting('startups hiring SDRs within 30 days of the raise that raised a seed round')
  const [hiring, seed] = conds(p)
  assert.deepEqual([hiring.kind, hiring.relative_to, hiring.within_days, seed.kind], ['hiring', 'C2', 30, 'funding'])
  const rows: ProofRow[] = [{ connector: 'signals:greenhouse-gtm', kind: 'hiring', value: 'SDR - posted', source_url: 'https://boards.example/brightloop/sdr', source_date: ago(5) }]
  // Before #878 this passed on the posting's own now-clock alone, whatever the raise date.
  const old = conditionProof(hiring, lead('', null), rows, ctx, { C2: ago(200) })
  assert.equal(old.truth, 'unknown'); assert.match(old.reason, /not within 30 days after C2/)
  assert.equal(conditionProof(hiring, lead('', null), rows, ctx, { C2: ago(20) }).truth, 'pass', 'posting 15 days after the raise')
  assert.equal(conditionProof(hiring, lead('', null), rows, ctx, {}).truth, 'unknown', 'no dated raise: the relation cannot be checked')
  assert.equal(conditionProof(hiring, lead('', null), rows, ctx, { C2: ago(2) }).truth, 'unknown', 'a posting before the raise is not "within 30 days of" it')
})

test('two anchor events for one condition: the clock is unresolved, recorded, and the condition is never proven', () => {
  const p = compileTargeting('startups that are hiring SDRs within 30 days of the raise and within 10 days of the launch, raised a seed round and launched a new product')
  const c = conds(p)[0]
  assert.equal(c.kind, 'hiring'); assert.ok(c.clock_conflict); assert.equal(c.relative_to, undefined)
  assert.equal(p.explicit, true)
  assert.match(p.ambiguities[0].chosen, /^neither/)
  assert.match(describePlan(p.root), /clock unresolved/)
  const rows: ProofRow[] = [{ connector: 'signals:greenhouse-gtm', kind: 'hiring', value: 'SDR - posted', source_url: 'https://boards.example/b/sdr', source_date: ago(5) }]
  const r = conditionProof(c, lead('', null), rows, ctx, { C2: ago(10), C3: ago(8) })
  assert.deepEqual([r.truth, r.reason], ['unknown', c.clock_conflict])
})

test('the sales-hiring OR reader takes the narrowed hiring clock and never treats an unresolved clock as a plain branch', () => {
  const or = salesGateOr('startups that raised seed funding or are hiring SDRs within 90 days, specifically within 30 days', null)
  assert.deepEqual([or?.event.kind, or?.hiring.kind, or?.hiring.within_days], ['funding', 'hiring', 30], 'the gate reads the 30-day hiring clock, not the first 90')
  const q = 'startups that either raised seed funding or are hiring SDRs within 30 days of the raise and within 10 days of the launch, and launched a new product'
  assert.ok(conds(compileTargeting(q))[1].clock_conflict)
  assert.equal(salesGateOr(q, null), null, 'an unresolved clock keeps both halves required (as a relative clock already did)')
})

test('adversarial requests: no clause, empty, huge and many-window inputs compile without throwing and keep the narrowest clock', () => {
  for (const q of [null, undefined, '', '   ', 'within 30 days', 'In the last 90 days.']) assert.doesNotThrow(() => compileTargeting(q))
  const many = `startups that raised seed funding ${Array.from({ length: 300 }, (_, i) => `within ${(i % 90) + 10} days`).join(', ')}`
  const c = conds(compileTargeting(many))[0]
  assert.deepEqual([c.within_days, c.window_source], [10, 'narrowest'])
  const huge = `startups that raised seed funding within 90 days, ${'x'.repeat(200_000)} specifically within 30 days`
  assert.equal(conds(compileTargeting(huge))[0].within_days, 30)
  // units: weeks and months are converted before the narrowest is taken
  assert.equal(conds(compileTargeting('startups that raised seed funding within 2 months, specifically within 3 weeks'))[0].within_days, 21)
})

test('each stored clause says its own evidence date, or that it has none; malformed dates never become evidence and never throw', () => {
  const today = new Date('2026-11-09T15:00:00Z')
  const base = { id: 'C1', text: 'raised seed funding within 30 days', negated: false }
  assert.deepEqual(targetingClauseRow({ ...base, truth: 'pass', date: '2026-10-20' }, today), { value: 'C1 raised seed funding within 30 days: pass, evidence dated 2026-10-20', source_date: '2026-10-20' })
  assert.deepEqual(targetingClauseRow({ ...base, truth: 'unknown' }, today), { value: 'C1 raised seed funding within 30 days: unknown, no evidence date', source_date: '2026-11-09' })
  assert.equal(targetingClauseRow({ ...base, negated: true, truth: 'fail' }, today).value, 'C1 NOT raised seed funding within 30 days: fail, no evidence date')
  for (const bad of ['2026-13-45', '2026-02-30', '', 'garbage', '20261020', '2026-10-20T00:00:00Z', ' 2026-10-20', 20261020, null, {}, ['2026-10-20'], true]) {
    let row: { value: string; source_date: string } | undefined
    assert.doesNotThrow(() => { row = targetingClauseRow({ ...base, truth: 'pass', date: bad as unknown as string }, today) }, String(bad))
    assert.deepEqual(row, { value: 'C1 raised seed funding within 30 days: pass, no evidence date', source_date: '2026-11-09' }, `malformed date ${JSON.stringify(bad)}`)
  }
  // the length cap never cuts the truth or the date: the clause text is shortened instead
  const long = targetingClauseRow({ ...base, text: 'é'.repeat(5000), truth: 'pass', date: '2026-10-20' }, today)
  assert.ok(long.value.length <= 254); assert.ok(long.value.endsWith(': pass, evidence dated 2026-10-20'))
})

test('the real actionability writer stores each clause with its own evidence date (two clocks, two dates on two leads)', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateMemory(db)
  const query = 'Find B2B SaaS startups that raised seed funding within 90 days, specifically within 30 days, and hired their first VP of Sales within 20 days.'
  const icp = JSON.stringify({ summary: 's', who: ['Founder'], signals: [], exclude: [] })
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ?, query = ? WHERE id = ?").run(icp, query, jobId)
  const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10)
  const add = (id: string, company: string, quote: string, date: string) => {
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, event_date, confidence, score, fit) VALUES (?, ?, '', ?, ?, 'raised a seed round', ?, ?, ?, 80, 80, 5)").run(id, jobId, company, `${id}.example`, `https://news.example/${id}`, quote, date)
    // the sales-hiring gate's durable pass (it runs before this; without it the lead is held before the plan is read, as targeting.test.ts seeds)
    for (const v of ['sales_hiring', 'requested_role_v1']) db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'u1', 'scan:gate', 'gate_passed', ?, 'x', NULL, 'https://invalid.example/', '2026-10-28', 1)").run(`${id}g${v}`, id, v)
  }
  add('recent', 'Brightloop', 'Brightloop raised a 3m seed round and hired its first VP of Sales.', day(10))
  add('older', 'Quietco', 'Quietco raised a 2m seed round and hired its first VP of Sales.', day(45))
  recordActionability(db, { id: jobId, user_id: 'u1', query, icp })
  const rows = (id: string) => db.prepare("SELECT value, source_date FROM lead_enrichments WHERE lead_id = ? AND tenant_id = 'u1' AND connector = 'scan:targeting' ORDER BY value").all(id) as { value: string; source_date: string }[]
  const recent = rows('recent'), older = rows('older')
  assert.equal(recent.length, 2); assert.equal(older.length, 2)
  assert.match(recent[0].value, /^C1 raised seed funding within 90 days, specifically within 30 days: pass, evidence dated \d{4}-\d{2}-\d{2}$/)
  assert.equal(recent[0].source_date, day(10))
  assert.match(recent[1].value, /^C2 hired their first VP of Sales within 20 days: pass, evidence dated /)
  // 45 days old: outside the narrowed 30-day seed clock (it passed before #878) and outside the VP's 20-day clock
  assert.match(older[0].value, /^C1 .*: unknown, evidence dated \d{4}-\d{2}-\d{2}$/)
  assert.equal(older[0].source_date, day(45), 'the out-of-window evidence keeps ITS date, never the check day')
  assert.match(older[1].value, /^C2 .*: unknown, evidence dated /)
  // another tenant's id reads nothing
  assert.equal((db.prepare("SELECT count(*) AS n FROM lead_enrichments WHERE tenant_id = 'u2'").get() as { n: number }).n, 0)
})

// Guard: the Condition type carries the new clock fields only as optional, so existing readers that ignore them stay valid.
const _shape: Condition = { id: 'C1', kind: 'funding', text: 't', within_days: null, window_source: null }
void _shape
