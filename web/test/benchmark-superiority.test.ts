// Repeated-run superiority tests (lib/benchmark/superiority.ts, #398) over SYNTHETIC batches produced by the real runner
// (#397) with local stub adapters: no network, no model, no account. Companies and domains are invented.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runBatch, type Adapter, type AdapterResult, type BatchResult, type BlindEvaluator, type Brief } from '../lib/benchmark/runner.ts'
import { analyze, checkPrereg, monitoring, preregHash, PreregError, type LookLedger, type Prereg, type Snapshot } from '../lib/benchmark/superiority.ts'
import type { TaskSet } from '../lib/benchmark/scorecard.ts'

const REGIONS = [['London', 'GB', 'software'], ['Toronto', 'CA', 'marketing'], ['Munich', 'DE', 'manufacturing']] as const
const SET = (n = 12): TaskSet => ({ version: 'synthetic-sup-1', frozen_at: '2026-10-20', tasks: Array.from({ length: n }, (_, i) => { const [region, country, sector] = REGIONS[i % 3]; return { id: `t${String(i + 1).padStart(2, '0')}`, region, country, sector, kind: 'standard' as const, language: 'en', query: `synthetic task ${i + 1} in ${region}`, constraints: { all_of: [{ geo: region }, { event: 'office_opening', within_days: 90 }] } } }) } as TaskSet)
// Grades by the invented domain's prefix: good-* passes, bad-* has an unknown date, contra-* a contradicted date.
const evaluator: BlindEvaluator = { name: 'synthetic-prefix-labels', version: '1', independent: true, judge: async items => Object.fromEntries(items.map(i => [i.blind_id, { identity: 'pass', constraints: 'pass', contact: 'pass', event_date: i.domain!.startsWith('good-') ? 'pass' : i.domain!.startsWith('contra-') ? 'contradicted' : 'unknown' }])) }
// A stub system: per task (and repetition), `good` validated companies and `bad` unvalidated ones; `fail` tasks throw.
const system = (name: string, shape: (b: Brief, rep: number) => { good: number; bad: number; contra?: number; fail?: boolean; interventions?: number }, rep: number): Adapter => ({
  system: name, origin: 'synthetic', available: { ok: true }, config: { product: name, product_version: 'stub', model: null, sources: [], paid: false },
  run: async b => {
    const s = shape(b, rep); if (s.fail) throw new Error('synthetic outage')
    const mk = (p: string, k: number) => Array.from({ length: k }, (_, j) => ({ company: `${p} ${name} ${b.task_id} ${j}`, domain: `${p}-${name}-${b.task_id}-${j}.example` }))
    return { items: [...mk('good', s.good), ...mk('contra', s.contra ?? 0), ...mk('bad', s.bad)], cost_usd: 0.2, seconds: 10, interventions: s.interventions ?? 0 } satisfies AdapterResult
  },
})
const batches = async (cand: Parameters<typeof system>[1], base: Parameters<typeof system>[1], reps = 3, set = SET()): Promise<BatchResult[]> => {
  const out: BatchResult[] = []
  for (let rep = 0; rep < reps; rep++) out.push(await runBatch({ set, asOf: '2026-10-20', seed: rep + 1, evaluator, budget: { usd_per_task: 1, seconds_per_task: 5, batch_usd: 1000 }, adapters: [system('cand', cand, rep), system('base', base, rep)] }))
  return out
}
const PLAN: Prereg = {
  id: 'synthetic-sup-plan-1', registered_at: '2026-10-19T00:00:00Z', systems: { candidate: 'cand', baseline: 'base' },
  metrics: [
    { metric: 'precision_at_10', direction: 'higher', min_effect: 0.05, primary: true },
    { metric: 'validated', direction: 'higher', min_effect: 0.5, primary: true },
    { metric: 'failure_rate', direction: 'lower', min_effect: 0.05, primary: false },
    { metric: 'interventions', direction: 'lower', min_effect: 0.5, primary: false },
  ],
  precision_floor: 0.9, yield_advantage: 1.25, cost_ceiling_usd_per_validated: 1, critical: { max_contradicted: 0, max_false_alerts: 0 },
  min_pairs: 10, min_clusters: 6, cluster_by: 'task', segments: ['region'], bootstrap: { resamples: 1000, level: 0.95, seed: 42 }, stop_rule: { max_looks: 1 },
  power_rationale: 'SYNTHETIC: 12 tasks x 3 repetitions; a 0.05 precision difference with per-task SD ~0.1 needs ~10 task clusters at 95%.',
}
const run = (b: BatchResult[], plan = PLAN, ledger?: LookLedger) => analyze(plan, preregHash(plan), ledger ?? { plan_hash: preregHash(plan), looks: [] }, b, { at: '2026-10-21T00:00:00Z' })

test('a clear, repeated advantage wins every primary metric with intervals, and meets the registered targets', async () => {
  const s = run(await batches(() => ({ good: 5, bad: 0 }), () => ({ good: 2, bad: 3, interventions: 2 })))
  assert.equal(s.overall.decision, 'win', s.overall.why)
  const m = Object.fromEntries(s.metrics.map(x => [x.metric, x]))
  assert.deepEqual([m.precision_at_10.decision, m.precision_at_10.pairs, m.precision_at_10.clusters, m.precision_at_10.candidate_mean, m.precision_at_10.baseline_mean], ['win', 36, 12, 1, 0.4])
  assert.ok(m.precision_at_10.interval![0] > 0.05)
  assert.equal(m.validated.decision, 'win'); assert.equal(m.interventions.decision, 'win')
  assert.deepEqual([s.targets.precision_floor.met, s.targets.yield_advantage.met, s.targets.yield_advantage.ratio], [true, true, 2.5])
  assert.ok(s.floors.every(f => f.ok === true))
  assert.equal(s.label, 'SYNTHETIC batches: says nothing about any product')
  assert.deepEqual(s.evidence, { evaluator_validated: true, customer_outcomes: 'not measured here (opted-in pilot, #399)' })
  assert.deepEqual(s.segments.map(x => [x.value, x.metrics[0].pairs, x.metrics[0].decision]), [['London', 12, 'inconclusive'], ['Munich', 12, 'inconclusive'], ['Toronto', 12, 'inconclusive']]) // 4 clusters each < 6: too few to call a segment
})

test('inadequate sample is inconclusive: one batch of two tasks, or ten repetitions of ONE task (one cluster)', async () => {
  const small = run(await batches(() => ({ good: 5, bad: 0 }), () => ({ good: 1, bad: 4 }), 1, SET(2)))
  assert.ok(small.metrics.every(m => m.decision === 'inconclusive' && /inadequate sample/.test(m.why)))
  assert.equal(small.overall.decision, 'inconclusive')
  const one = run(await batches(() => ({ good: 5, bad: 0 }), () => ({ good: 1, bad: 4 }), 10, SET(1)))
  assert.deepEqual([one.metrics[0].pairs, one.metrics[0].clusters, one.metrics[0].decision], [10, 1, 'inconclusive']) // repeats are not independent evidence
})

test('a small or noisy difference is inconclusive, not a win', async () => {
  const s = run(await batches((b, rep) => ({ good: 4 + ((+b.task_id.slice(1) + rep) % 2), bad: 1 - ((+b.task_id.slice(1) + rep) % 2) }), (b, rep) => ({ good: 4 + ((+b.task_id.slice(1) + rep + 1) % 2), bad: 1 - ((+b.task_id.slice(1) + rep + 1) % 2) })))
  assert.equal(s.metrics[0].decision, 'inconclusive'); assert.match(s.metrics[0].why, /reaches inside the minimum effect/)
  assert.notEqual(s.overall.decision, 'win')
})

test('a loss is reported as a loss', async () => {
  const s = run(await batches(() => ({ good: 1, bad: 4 }), () => ({ good: 5, bad: 0 })))
  assert.equal(s.metrics[0].decision, 'loss')
  assert.notEqual(s.overall.decision, 'win')
})

test('no overall winner when a critical floor fails: one contradicted result, or precision under the floor', async () => {
  const contra = run(await batches(b => ({ good: 5, bad: 0, contra: b.task_id === 't03' ? 1 : 0 }), () => ({ good: 1, bad: 4 })))
  assert.equal(contra.metrics[0].decision, 'win')                                    // better than the baseline...
  assert.equal(contra.overall.decision, 'no_winner_floor_failed'); assert.match(contra.overall.why, /contradicted/)
  const low = run(await batches(() => ({ good: 4, bad: 1 }), () => ({ good: 1, bad: 4 })))
  assert.equal(low.metrics[0].decision, 'win')                                       // 0.8 beats 0.2 ...
  assert.equal(low.targets.precision_floor.met, false)                               // ... but 0.8 is under the 0.90 floor
  assert.equal(low.overall.decision, 'no_winner_floor_failed')
})

test('a task one side did not complete is a missing pair, never a zero', async () => {
  const s = run(await batches(() => ({ good: 5, bad: 0 }), b => ({ good: 2, bad: 3, fail: b.task_id === 't01' || b.task_id === 't02' })))
  assert.equal(s.missing_pairs.length, 6)
  assert.ok(s.missing_pairs.every(p => p.candidate_complete && !p.baseline_complete))
  assert.equal(s.metrics[0].pairs, 30)
  assert.equal(s.metrics.find(m => m.metric === 'failure_rate')!.pairs, 36)          // failures themselves are measured, as a rate
})

test('preregistered: the plan is hashed, a changed plan is refused, and the stop rule refuses a second look', async () => {
  const b = await batches(() => ({ good: 5, bad: 0 }), () => ({ good: 2, bad: 3 }))
  const ledger: LookLedger = { plan_hash: preregHash(PLAN), looks: [] }
  const loosened = { ...PLAN, precision_floor: 0.8 }
  assert.throws(() => analyze(loosened, preregHash(PLAN), ledger, b), /differs from the one registered/)
  assert.equal(ledger.looks.length, 0)                                               // a refused call is not a look
  run(b, PLAN, ledger)
  assert.equal(ledger.looks.length, 1)
  assert.throws(() => run(b, PLAN, ledger), (e: unknown) => e instanceof PreregError && /stop rule/.test((e as Error).message))
  assert.throws(() => checkPrereg({ ...PLAN, power_rationale: ' ' }), /rationale/)
  assert.throws(() => checkPrereg({ ...PLAN, min_pairs: 1 }), /min_pairs/)
  assert.equal(preregHash({ ...PLAN, metrics: [...PLAN.metrics] }), preregHash(PLAN))
})

test('batches are never pooled across origins or across different frozen briefs', async () => {
  const b = await batches(() => ({ good: 5, bad: 0 }), () => ({ good: 2, bad: 3 }), 2)
  const relabelled = { ...b[1], manifest: { ...b[1].manifest, origin: 'live' as const } }
  assert.throws(() => run([b[0], relabelled]), /different origins/)
  const other = (await batches(() => ({ good: 5, bad: 0 }), () => ({ good: 2, bad: 3 }), 1, SET(9)))[0]
  assert.throws(() => run([b[0], other]), /share the task set and frozen briefs/)
})

test('monitoring over two weeks: net-new events, duplicates, freshness, and whether a correction stays corrected', () => {
  const day = (d: number) => `2026-10-${String(d).padStart(2, '0')}`
  const snaps: Snapshot[] = Array.from({ length: 15 }, (_, i) => ({ day: day(i + 1), items: [
    { entity_key: `domain:new-${i}.example`, event_key: 'opening', event_date: day(Math.max(1, i)), validated: true },   // one new event a day, a day old
    ...(i > 0 ? [{ entity_key: `domain:new-${i - 1}.example`, event_key: 'opening', event_date: day(Math.max(1, i - 1)), validated: true }] : []), // yesterday's again: a duplicate
    ...(i === 3 ? [{ entity_key: 'domain:wrong.example', event_key: 'opening', event_date: day(2), validated: false, corrected: true }, { entity_key: 'domain:wrong2.example', event_key: 'opening', event_date: day(2), validated: false, corrected: true }] : []),
    ...(i === 9 ? [{ entity_key: 'domain:wrong2.example', event_key: 'opening', event_date: day(2), validated: true }] : []), // a corrected event back as new
  ] }))
  const m = monitoring(snaps)
  assert.deepEqual([m.days, m.span_days, m.adequate, m.corrections, m.correction_retention], [15, 14, true, 2, 0.5])
  assert.equal(m.net_new_events.length, 15); assert.ok(m.net_new_events.every(d => d.count === 1))
  assert.equal(m.duplicate_rate, Math.round((14 / (15 + 14 + 2 + 1)) * 1e4) / 1e4)
  assert.equal(m.freshness_median_days, 1)
  assert.equal(monitoring(snaps.slice(0, 7)).adequate, false)                        // a week is reported, never stretched to two
})

test('the interval decides, not the average: a positive mean difference with a wide interval is inconclusive', async () => {
  const odd = (b: Brief) => +b.task_id.slice(1) % 2 === 1
  const s = run(await batches(b => odd(b) ? { good: 5, bad: 0 } : { good: 2, bad: 3 }, () => ({ good: 3, bad: 2 })))
  const p = s.metrics[0]
  assert.ok(p.difference! > 0.05, String(p.difference))                              // the average says "better"...
  assert.ok(p.interval![0] < 0.05)                                                     // ...the interval does not
  assert.equal(p.decision, 'inconclusive')
})

test('winning the primary metrics is not enough when the registered yield advantage is not shown', async () => {
  const plan: Prereg = { ...PLAN, id: 'synthetic-sup-plan-yield', metrics: [{ metric: 'precision_at_10', direction: 'higher', min_effect: 0.01, primary: true }, { metric: 'validated', direction: 'higher', min_effect: 0.2, primary: true }] }
  const s = run(await batches(() => ({ good: 5, bad: 0 }), b => +b.task_id.slice(1) % 2 ? { good: 4, bad: 1 } : { good: 5, bad: 0 }), plan)
  assert.ok(s.metrics.every(m => m.decision === 'win'), JSON.stringify(s.metrics.map(m => [m.metric, m.decision, m.interval])))
  assert.equal(s.targets.yield_advantage.met, false)                                  // 5 / 4.5 = 1.11 < the registered 1.25
  assert.equal(s.overall.decision, 'inconclusive')
})
