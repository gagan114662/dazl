// #380: the request compiled into an explicit AND / OR / NOT plan with per-condition clocks and clause-by-clause proof. Pure compiler and evaluator
// tests plus the actionable-yield gate on stubbed rows. Invented companies, no network, no model.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { compileTargeting, describePlan, evaluatePlan, planConditions, type QueryPlan, type Truth } from '../lib/scan/targeting.ts'
import { conditionProof, planProofs, type ProofLead } from '../lib/scan/targeting-proof.ts'
import { classifyLeads, recordActionability } from '../lib/scan/actionable.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateMemory } from '../lib/memory.ts'

const NOW = Date.parse('2026-10-28T12:00:00Z')
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString().slice(0, 10)
const ids = (p: QueryPlan) => planConditions(p.root).map(x => `${x.negated ? '!' : ''}${x.cond.id}:${x.cond.kind}`)
const facts = (p: QueryPlan, t: Record<string, Truth>) => evaluatePlan(p, Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { truth: v, reason: 'stub' }])))

test('funding OR hiring requires either; funding AND hiring requires both; the missing clauses are named', () => {
  const or = compileTargeting('B2B SaaS startups that raised funding or are hiring account executives')
  assert.equal(describePlan(or.root), '(C1 raised funding OR C2 hiring account executives (within 90 days))')
  assert.equal(facts(or, { C1: 'pass', C2: 'unknown' }).truth, 'pass')
  assert.equal(facts(or, { C1: 'unknown', C2: 'pass' }).truth, 'pass')
  const none = facts(or, { C1: 'unknown', C2: 'unknown' })
  assert.deepEqual([none.truth, none.missing.map(c => c.id)], ['unknown', ['C1', 'C2']])

  const and = compileTargeting('B2B SaaS startups that raised funding and are hiring account executives')
  assert.equal(and.root?.op, 'and'); assert.deepEqual(ids(and), ['C1:funding', 'C2:hiring'])
  const one = facts(and, { C1: 'pass', C2: 'unknown' })
  assert.deepEqual([one.truth, one.missing.map(c => c.id)], ['unknown', ['C2']], 'a proven half never stands in for the missing one')
  assert.equal(facts(and, { C1: 'pass', C2: 'pass' }).truth, 'pass')
  assert.equal(facts(and, { C1: 'pass', C2: 'fail' }).truth, 'fail')
})

test('seed within 90 days AND first VP hired within 30 days: two separate clocks, each checked on its own', () => {
  const p = compileTargeting('startups that raised a seed round within 90 days and hired their first VP of Sales within 30 days')
  const [seed, vp] = planConditions(p.root).map(x => x.cond)
  assert.deepEqual([seed.kind, seed.stage, seed.within_days, seed.window_source], ['funding', 'seed', 90, 'clause'])
  assert.deepEqual([vp.kind, vp.role, vp.first, vp.within_days, vp.window_source], ['hire_made', 'VP of Sales', true, 30, 'clause'])
  const lead = (date: string): ProofLead => ({ company: 'Brightloop', company_domain: 'brightloop.io', evidence_excerpt: 'Brightloop raised a 3m seed round and hired its first VP of Sales, Jane Doe.', signal: 'raised a seed round', source_url: 'https://news.example/b', event_date: date })
  const ctx = { query: 'x', icp: null, salesGatePassed: false, competitors: null, now: NOW }
  const at45 = planProofs(p, lead(ago(45)), [], ctx)
  assert.deepEqual([at45.C1.truth, at45.C2.truth], ['pass', 'unknown'], '45 days old: inside the seed clock, outside the VP clock')
  assert.match(at45.C2.reason, /outside this condition's 30-day window/)
  const at10 = planProofs(p, lead(ago(10)), [], ctx)
  assert.deepEqual([at10.C1.truth, at10.C2.truth], ['pass', 'pass'])
  assert.equal(evaluatePlan(p, at10).truth, 'pass'); assert.equal(evaluatePlan(p, at45).truth, 'unknown')
  // A clock counted from another event needs both events dated on separate sources: one quote's date cannot be both.
  const rel = compileTargeting('startups that hired a first VP of Sales within 30 days of the raise and raised a seed round')
  assert.equal(planConditions(rel.root)[0].cond.relative_to, 'C2')
  assert.equal(planProofs(rel, lead(ago(10)), [], ctx).C1.truth, 'unknown')
})

test('excludes competitors stays hard: on the saved list -> fails; no list -> unknown, so the lead is never qualified; off the list -> passes', () => {
  const p = compileTargeting('dental clinics that opened a new location in the last 60 days, excluding competitors')
  assert.deepEqual(ids(p), ['C1:event', '!X1:competitor'])
  const lead: ProofLead = { company: 'Harbor Dental', company_domain: 'harbordental.example', evidence_excerpt: 'Harbor Dental opened a new location on Elm Street.', signal: 'opened a new location', source_url: 'https://news.example/h', event_date: ago(20) }
  const run = (competitors: string[] | null) => evaluatePlan(p, planProofs(p, lead, [], { query: 'x', icp: null, salesGatePassed: false, competitors, now: NOW }))
  assert.equal(run(['Harbor Dental Group']).truth, 'fail')
  const noList = run(null)
  assert.deepEqual([noList.truth, noList.missing.map(c => c.id)], ['unknown', ['X1']])
  assert.match(noList.missing[0].reason, /no saved competitor list/)
  assert.equal(run(['Canal Orthodontics']).truth, 'pass')
})

test('named and category exclusions: a named company or a stated category in the name/quote fails; the ICP grade rules a category out only when its profile carries it', () => {
  const p = compileTargeting('fintech companies hiring SDRs, except Stripe and franchises')
  assert.deepEqual(ids(p), ['C1:hiring', '!X1:company_named', '!X2:category'])
  const [, named, cat] = planConditions(p.root).map(x => x.cond)
  const lead = (company: string, quote = `${company} is hiring SDRs`): ProofLead => ({ company, company_domain: null, evidence_excerpt: quote, signal: null, source_url: 'https://news.example/x', event_date: ago(5) })
  const ctx = (exclude: string[]) => ({ query: 'x', icp: JSON.stringify({ exclude }), salesGatePassed: false, competitors: null, graded: true, now: NOW })
  assert.equal(conditionProof(named, lead('Stripe Inc'), [], ctx([])).truth, 'pass')
  assert.equal(conditionProof(named, lead('Ledgerly'), [], ctx([])).truth, 'fail')
  assert.equal(conditionProof(cat, lead('Burger Franchise Co'), [], ctx(['franchises'])).truth, 'pass', 'the name says it: excluded whatever the grade said')
  assert.equal(conditionProof(cat, lead('Ledgerly'), [], ctx(['franchises'])).truth, 'fail')
  assert.equal(conditionProof(cat, lead('Ledgerly'), [], ctx([])).truth, 'unknown', 'nothing checked it: unknown, never assumed false')
  assert.equal(conditionProof(cat, lead('Ledgerly'), [], { ...ctx(['franchises']), graded: false }).truth, 'unknown')
})

test('non-hiring requests: event families with their objects, OR between events, and a single flat signal is not a plan gate', () => {
  const p = compileTargeting('restaurants that opened a new location or won a catering contract in the last 60 days')
  assert.equal(p.root?.op, 'or'); assert.deepEqual(planConditions(p.root).map(x => [x.cond.event, x.cond.object]), [['open', 'location'], ['contract', 'contract']])
  const lead = (quote: string): ProofLead => ({ company: 'Canal Diner', company_domain: null, evidence_excerpt: quote, signal: null, source_url: 'https://news.example/c', event_date: ago(12) })
  const ctx = { query: 'x', icp: null, salesGatePassed: false, competitors: null, now: NOW }
  assert.equal(evaluatePlan(p, planProofs(p, lead('Canal Diner opened a new location on Main Street.'), [], ctx)).truth, 'pass')
  assert.equal(evaluatePlan(p, planProofs(p, lead('Canal Diner opened a new kitchen.'), [], ctx)).truth, 'unknown', 'a kitchen is not a location')
  assert.equal(compileTargeting('restaurants that opened a second location in Austin').explicit, false)
})

test('adversarial and ambiguous requests take the narrowest reading and record it; nothing is broadened or invented', () => {
  const andOr = compileTargeting('companies that raised a Series A and/or are hiring SDRs')
  assert.equal(andOr.root?.op, 'and'); assert.match(andOr.ambiguities[0].chosen, /both conditions/)
  const notOr = compileTargeting('companies that are not funded or hiring')
  assert.deepEqual(ids(notOr), ['!C1:funding', '!C2:hiring']); assert.match(notOr.ambiguities[0].chosen, /^neither/)
  const mixed = compileTargeting('companies that raised seed funding or hiring SDRs and opened a new office')
  assert.equal(mixed.root?.op, 'and'); assert.match(mixed.ambiguities[0].chosen, /every condition required/)
  const grouped = compileTargeting('startups that either raised seed funding or are hiring SDRs, and opened a new office')
  assert.equal(describePlan(grouped.root).replace(/ \(within \d+ days\)/g, ''), '((C1 raised seed funding OR C2 hiring SDRs) AND C3 opened a new office)', '"either A or B, and C" groups as the request says')
  assert.equal(grouped.ambiguities.length, 0)
  assert.equal(compileTargeting('seed oil producers in Ohio').root, null, 'a bare "seed" outside a funding context is not a funding condition')
  // Unknown is never read as false: NOT unknown is unknown.
  const notFunded = compileTargeting('startups that have not raised a Series B')
  assert.equal(facts(notFunded, {}).truth, 'unknown'); assert.equal(facts(notFunded, { C1: 'fail' }).truth, 'pass')
})

test('actionable yield: an explicit plan is a required gate - an unproven clause holds the lead and every clause is recorded with its proof', () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateMemory(db)
  const query = 'Find B2B SaaS startups that raised a seed round within 90 days and hired their first VP of Sales within 30 days.'
  const icp = JSON.stringify({ summary: 's', who: ['Founder'], signals: [], exclude: [] })
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ?, query = ? WHERE id = ?").run(icp, query, jobId)
  const lead = (id: string, company: string, quote: string) => {
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, event_date, confidence, score, fit) VALUES (?, ?, '', ?, ?, 'raised a seed round', ?, ?, ?, 80, 80, 5)").run(id, jobId, company, `${id}.example`, `https://news.example/${id}`, quote, new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10))
    const ins = db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'u1', 'sitecrawl', ?, ?, 'x', NULL, ?, '2026-10-28', 1)")
    ins.run(`${id}p`, id, 'person', 'Jane Doe, Chief Executive Officer', `https://${id}.example/team`)
    ins.run(`${id}e`, id, 'email', `hello@${id}.example`, `https://${id}.example/contact`)
    // the sales-hiring gate's durable pass (it runs before this and still applies its own reading of the request: see the PR's gap list)
    for (const v of ['sales_hiring', 'requested_role_v1']) db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'u1', 'scan:gate', 'gate_passed', ?, 'x', NULL, 'https://invalid.example/', '2026-10-28', 1)").run(`${id}g${v}`, id, v)
  }
  lead('both', 'Brightloop', 'Brightloop raised a 3m seed round and hired its first VP of Sales.')
  lead('seedonly', 'Quietco', 'Quietco raised a 2m seed round to grow its team.')
  const job = { id: jobId, user_id: 'u1', query, icp }
  const by = Object.fromEntries(classifyLeads(db, job).map(r => [r.lead_id, r]))
  assert.deepEqual([by.both.actionable, by.both.missing], [true, []])
  assert.deepEqual(by.both.targeting!.map(c => [c.id, c.truth]), [['C1', 'pass'], ['C2', 'pass']])
  assert.deepEqual([by.seedonly.actionable, by.seedonly.missing], [false, ['targeting_not_proven']])
  assert.deepEqual(by.seedonly.targeting!.map(c => [c.id, c.truth]), [['C1', 'pass'], ['C2', 'unknown']])
  recordActionability(db, job)
  const rows = db.prepare("SELECT value, label FROM lead_enrichments WHERE lead_id = 'seedonly' AND connector = 'scan:targeting' ORDER BY value").all() as { value: string; label: string }[]
  assert.equal(rows.length, 2)
  assert.match(rows[1].value, /^C2 hired their first VP of Sales within 30 days: unknown$/); assert.match(rows[1].label, /no verified source shows this company made its first VP of Sales hire/)
})
