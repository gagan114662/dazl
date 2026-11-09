// #876 (part of #752, Test B of #204): a request's completed first hire ("made their first sales hire") is a fact in the past - a hire_made
// condition - never an open-role hiring condition. The typed plan keeps the request's wording distinct, and the clause proof needs a source
// showing the completed hire: an open vacancy (a dated posting, "is hiring its first ...") does not prove it. Present / progressive / future
// wording states no completed hire and stays an open role. Pure compiler and proof reader plus the actionable-yield gate on stubbed rows.
// Invented companies, no network, no model.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { compileTargeting, describePlan, evaluatePlan, planConditions, type Condition } from '../lib/scan/targeting.ts'
import { conditionProof, planProofs, type ProofLead, type ProofRow } from '../lib/scan/targeting-proof.ts'
import { salesGateOr } from '../lib/scan/sales-hiring-required.ts'
import { planNeedSupport } from '../lib/scan/need-evidence.ts'
import { classifyLeads } from '../lib/scan/actionable.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateMemory } from '../lib/memory.ts'

const NOW = Date.parse('2026-11-09T12:00:00Z')
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString().slice(0, 10)
const conds = (q: string | null | undefined) => planConditions(compileTargeting(q).root).map(x => ({ neg: x.negated, kind: x.cond.kind, role: x.cond.role, first: x.cond.first, days: x.cond.within_days }))
// Test B, verbatim (#204 fixed brief), and the audit probe from the issue.
const OR_B = 'London B2B SaaS startups that raised seed funding or made their first sales hire in the last 90 days'
const ICP_B = JSON.stringify({ summary: 'London B2B SaaS startups', where: ['London, UK'], who: ['Founder', 'Head of Sales'], signals: ['raised seed funding in the last 90 days', 'made their first sales hire in the last 90 days'], exclude: ['agencies'] })
const PROBE = 'Companies that made their first sales hire within 30 days and raised seed funding within 90 days'

test('the audit probe: "made their first sales hire" compiles to a completed first hire (hire_made, role sales, first), on its own clock', () => {
  assert.deepEqual(conds(PROBE), [
    { neg: false, kind: 'hire_made', role: 'sales', first: true, days: 30 },
    { neg: false, kind: 'funding', role: undefined, first: undefined, days: 90 },
  ])
  const p = compileTargeting(PROBE)
  assert.equal(p.root?.op, 'and'); assert.equal(p.explicit, true); assert.deepEqual(p.ambiguities, [])
  assert.equal(describePlan(p.root), '(C1 made their first sales hire within 30 days AND C2 raised seed funding within 90 days)')
})

test('Test B keeps its OR shape: (seed funding) OR (completed first sales hire), both on the 90-day clock; the gate still reads it as its OR', () => {
  const p = compileTargeting(OR_B, ICP_B)
  assert.equal(p.root?.op, 'or')
  assert.deepEqual(planConditions(p.root).map(x => [x.cond.kind, x.cond.stage ?? x.cond.role, x.cond.first, x.cond.within_days]), [['funding', 'seed', undefined, 90], ['hire_made', 'sales', true, 90]])
  const or = salesGateOr(OR_B, ICP_B)
  assert.ok(or, 'the sales-hiring gate still recognises Test B as funding OR sales hire')
  assert.deepEqual([or!.event.kind, or!.hiring.kind, or!.hiring.role], ['funding', 'hire_made', 'sales'])
  // A completed hire is never an open buying need (need-evidence reads the plan, never the gate).
  assert.deepEqual(planNeedSupport(p), { support: 'none', reason: 'completed_hire_not_open_need' })
  // A non-GTM completed hire is not the sales branch: the gate falls back to AND, as for an open non-GTM role.
  assert.equal(salesGateOr('London B2B SaaS startups that raised seed funding or made their first engineering hire in the last 90 days', ICP_B), null)
})

test('equivalent completed-hire wording compiles to hire_made; the role and the first flag come only from the request', () => {
  const one = (q: string) => { const c = conds(q); assert.equal(c.length, 1, q); return c[0] }
  assert.deepEqual(one('startups that have made their first sales hire'), { neg: false, kind: 'hire_made', role: 'sales', first: true, days: 90 })
  assert.deepEqual(one('startups that has made its first sales hire'), { neg: false, kind: 'hire_made', role: 'sales', first: true, days: 90 })
  assert.deepEqual(one('startups that just made a founding engineering hire'), { neg: false, kind: 'hire_made', role: 'engineering', first: true, days: 90 })
  assert.deepEqual(one('startups that made their first hire'), { neg: false, kind: 'hire_made', role: '', first: true, days: 90 })
  assert.deepEqual(one('startups that made a new sales hire'), { neg: false, kind: 'hire_made', role: 'sales', first: false, days: 90 })
  assert.deepEqual(one('startups that made a new hire'), { neg: false, kind: 'hire_made', role: '', first: false, days: 90 })
  assert.deepEqual(one('startups that made their first sales hires'), { neg: false, kind: 'hire_made', role: 'sales', first: true, days: 90 })
  assert.deepEqual(one('STARTUPS THAT MADE THEIR FIRST SALES HIRE'), { neg: false, kind: 'hire_made', role: 'SALES', first: true, days: 90 })
  assert.deepEqual(one('startups that hired their first salesperson'), { neg: false, kind: 'hire_made', role: 'salesperson', first: true, days: 90 })
  // the existing literal forms are unchanged
  assert.deepEqual(one('startups that hired their first VP of Sales'), { neg: false, kind: 'hire_made', role: 'VP of Sales', first: true, days: 90 })
  assert.deepEqual(one('startups whose first sales rep was hired'), { neg: false, kind: 'hire_made', role: 'sales rep', first: true, days: 90 })
})

test('negative open-role controls: present, progressive and future wording, or an open posting, stays an open-role hiring condition', () => {
  for (const q of ['startups making their first sales hire', 'startups that make their first sales hire', 'startups that makes its first sales hire', 'startups that are hiring their first sales rep', 'startups that posted a job for their first sales rep'])
    assert.deepEqual(conds(q).map(c => c.kind), ['hiring'], q)
  assert.deepEqual(conds('startups making their first sales hire')[0].role, 'sales')
  assert.deepEqual(conds('startups making a new hire')[0].role, '', 'a qualifier alone is no role')
})

test('negation and the narrow reading survive: a negated completed hire is NOT hire_made; mixed and/or stays AND', () => {
  assert.deepEqual(conds('startups that have not made their first sales hire').map(c => [c.neg, c.kind]), [[true, 'hire_made']])
  assert.deepEqual(conds("startups that haven't made their first sales hire yet").map(c => [c.neg, c.kind]), [[true, 'hire_made']])
  const mixed = compileTargeting('startups that raised seed funding or made their first sales hire and are hiring account executives')
  assert.equal(mixed.root?.op, 'and'); assert.equal(mixed.ambiguities.length, 1)
})

test('malformed and hostile requests: nothing throws, nothing is invented, compiling twice gives the same plan', () => {
  for (const q of [null, undefined, '', '   ', 'made', 'made hire', 'made made made hire hire', 'made their first', 'first sales hire', '\uD800 made their first sales hire \uDFFF', 'made\u00a0their\u00a0first\u00a0sales\u00a0hire']) {
    const a = compileTargeting(q), b = compileTargeting(q)
    assert.deepEqual(a, b, String(q))
    for (const c of planConditions(a.root)) assert.ok(c.cond.kind === 'hire_made' && typeof c.cond.role === 'string', String(q))
  }
  assert.deepEqual(conds('first sales hire'), [], 'no verb: no condition is invented')
  assert.deepEqual(conds('made\u00a0their\u00a0first\u00a0sales\u00a0hire').map(c => c.kind), ['hire_made'], 'non-breaking spaces read like spaces')
  const huge = `startups that made their first sales hire ${'and more words '.repeat(20_000)}`
  const t0 = Date.now(); const h = conds(huge); assert.ok(Date.now() - t0 < 5_000, 'bounded on a huge request')
  assert.deepEqual(h.map(c => c.kind), ['hire_made'])
})

// ---- the clause proof: a completed hire needs a source showing the completed hire ----
const ctx = { query: OR_B, icp: ICP_B, salesGatePassed: true, competitors: null, graded: true, now: NOW }
const hireCond = (): Condition => planConditions(compileTargeting(OR_B, ICP_B).root).find(x => x.cond.kind === 'hire_made')!.cond
const lead = (quote: string | null, date: string | null = ago(11)): ProofLead => ({ company: 'Pastco', company_domain: 'pastco.example', evidence_excerpt: quote, signal: 'made its first sales hire', source_url: 'https://news.example/pastco', event_date: date })
const POSTING: ProofRow = { connector: 'signals:greenhouse-gtm', kind: 'hiring', value: '1 sales/GTM role posted, newest ' + ago(12), label: 'Account Executive', source_url: 'https://boards.greenhouse.io/pastco/jobs/1', source_date: ago(12) }
const ROLE_POSTING: ProofRow = { connector: 'signals:careers-gtm', kind: 'hiring-role', value: 'Open role on its careers page: Sales Representative - posted ' + ago(5), label: 'Requested role: sales', source_url: 'https://pastco.example/careers/1', source_date: ago(5) }

test('proof: a dated source reporting the completed first sales hire passes; a headline "makes first sales hire" does too', () => {
  const p = conditionProof(hireCond(), lead('Pastco, a London B2B SaaS startup, made its first sales hire, appointing a Head of Sales'), [], ctx)
  assert.equal(p.truth, 'pass'); assert.equal(p.date, ago(11)); assert.equal(p.source_url, 'https://news.example/pastco')
  assert.equal(conditionProof(hireCond(), lead('Pastco makes first sales hire'), [], ctx).truth, 'pass')
  assert.equal(conditionProof(hireCond(), lead('Pastco hired its first sales rep, Jane Doe.'), [], ctx).truth, 'pass')
})

test('proof: an open vacancy never proves a completed first hire - a dated in-window posting row, a requested-role posting, an "is hiring" quote', () => {
  const open = lead('Pastco, a London B2B SaaS company, is hiring its first Sales Representative to join the founders.')
  // The bug: before #876 this condition was compiled as an open role, and the dated posting below proved it.
  const before: Condition = { ...hireCond(), kind: 'hiring', first: undefined }
  assert.equal(conditionProof(before, lead('Pastco is a London B2B SaaS platform.'), [POSTING], { ...ctx, salesGatePassed: false }).truth, 'pass', 'control: a posting does prove an OPEN role')
  for (const [l, rows] of [[lead('Pastco is a London B2B SaaS platform.'), [POSTING]], [lead('Pastco is a London B2B SaaS platform.'), [ROLE_POSTING]], [open, []], [open, [POSTING, ROLE_POSTING]]] as [ProofLead, ProofRow[]][]) {
    const p = conditionProof(hireCond(), l, rows, ctx)
    assert.equal(p.truth, 'unknown', `${l.evidence_excerpt} ${rows.length}`)
    assert.match(p.reason, /no verified source shows this company made its first sales hire/)
  }
})

test('proof: planned, ongoing, negated, wrong-role, not-first, out-of-window, undated and malformed quotes stay unknown', () => {
  const cases: [string | null, string | null][] = [
    ['Pastco plans to make its first sales hire this quarter.', ago(11)],
    ['Pastco will make its first sales hire next month.', ago(11)],
    ['Pastco is making its first sales hire.', ago(11)],
    ['Pastco has not made its first sales hire.', ago(11)],
    ['Pastco has yet to make its first sales hire.', ago(11)],
    ['Pastco made its first engineering hire.', ago(11)],
    ['Pastco made a new sales hire.', ago(11)],
    ['Pastco made its first sales hire.', ago(120)],
    ['Pastco made its first sales hire.', null],
    ['Pastco made its first sales hire.', 'not-a-date'],
    ['Pastco made its first sales hire.', ago(-3)],
    [null, ago(11)],
    ['', ago(11)],
    ['\uD800\uDFFF\u0000', ago(11)],
  ]
  for (const [q, d] of cases) assert.equal(conditionProof(hireCond(), lead(q, d), [POSTING], ctx).truth, 'unknown', `${q} @ ${d}`)
  const huge = conditionProof(hireCond(), lead(`${'filler words, '.repeat(50_000)}Pastco made its first sales hire.`), [], ctx)
  assert.equal(huge.truth, 'pass', 'a huge quote is read, bounded, and its last clause still counts')
})

test('plan level: Test B passes on a completed-hire lead; an open-posting-only lead is held at the plan (actionable yield), the gate untouched', async () => {
  const p = compileTargeting(OR_B, ICP_B)
  assert.equal(evaluatePlan(p, planProofs(p, lead('Pastco made its first sales hire, appointing a Head of Sales'), [], ctx)).truth, 'pass')
  const held = evaluatePlan(p, planProofs(p, lead('Pastco is a London B2B SaaS platform.'), [POSTING], ctx))
  assert.deepEqual([held.truth, held.missing.map(c => c.id)], ['unknown', ['C1', 'C2']])

  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateMemory(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ?, query = ? WHERE id = ?").run(ICP_B, OR_B, jobId)
  const add = (id: string, company: string, quote: string, extra: ProofRow[] = []) => {
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, event_date, confidence, score, fit) VALUES (?, ?, '', ?, ?, 'first sales hire', ?, ?, ?, 80, 80, 5)").run(id, jobId, company, `${id}.example`, `https://news.example/${id}`, quote, new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10))
    const ins = db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'u1', ?, ?, ?, ?, NULL, ?, ?, 1)")
    ins.run(`${id}d`, id, 'sitecrawl', 'domain', `${id}.example|evidence_own_domain`, 'x', `https://${id}.example/news`, ago(1))
    // the sales-hiring gate's durable pass (it runs before this, unchanged by #876)
    for (const v of ['sales_hiring', 'requested_role_v1']) ins.run(`${id}g${v}`, id, 'scan:gate', 'gate_passed', v, 'x', 'https://invalid.example/', ago(1))
    extra.forEach((r, i) => ins.run(`${id}x${i}`, id, r.connector, r.kind, r.value, r.label ?? null, r.source_url, new Date(Date.now() - 12 * 86_400_000).toISOString().slice(0, 10)))
  }
  add('pastco', 'Pastco', 'Pastco, a London B2B SaaS startup, made its first sales hire, appointing a Head of Sales')
  add('boardco', 'Boardco', 'Boardco is a London B2B SaaS platform for finance teams.', [POSTING])
  add('hireco', 'Hireco', 'Hireco, a London B2B SaaS company, is hiring its first Sales Representative to join the founders.')
  const by = Object.fromEntries(classifyLeads(db, { id: jobId, user_id: 'u1', query: OR_B, icp: ICP_B }).map(r => [r.lead_id, r]))
  assert.deepEqual(by.pastco.targeting!.map(c => [c.id, c.truth]), [['C1', 'unknown'], ['C2', 'pass']])
  assert.ok(!by.pastco.missing.includes('targeting_not_proven'))
  for (const id of ['boardco', 'hireco']) {
    assert.deepEqual([by[id].actionable, by[id].missing], [false, ['targeting_not_proven']], id)
    assert.deepEqual(by[id].targeting!.map(c => [c.id, c.truth]), [['C1', 'unknown'], ['C2', 'unknown']], id)
  }
  // reading never writes: classification alone leaves the enrichment rows as they were
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM lead_enrichments WHERE connector IN ('scan:targeting', 'scan:actionable')").get() as { n: number }).n, 0)
})
