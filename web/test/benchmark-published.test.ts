// #398: the published scorecard view never says more than the evidence does (lib/benchmark/published.ts, scripts/publish-scorecard.mts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scorecardView, systemRow, type Published, type PublishedBatch } from '../lib/benchmark/published.ts'
import { toPublished } from '../scripts/publish-scorecard.mts'
import type { BatchResult, SystemReport } from '../lib/benchmark/runner.ts'
import type { Superiority } from '../lib/benchmark/superiority.ts'
import example from '../lib/benchmark/published/example-synthetic.json' with { type: 'json' }

const EX = example as unknown as Published
const liveBatch = (over: Partial<PublishedBatch['manifest']> = {}, independent = true): PublishedBatch => {
  const b = structuredClone(EX.batch) as PublishedBatch
  b.manifest = { ...b.manifest, origin: 'live', label: 'LIVE run', ...over }
  b.evaluator = { ...b.evaluator, independent }
  return b
}
const pub = (batch: PublishedBatch | null, superiority: Superiority | null = null): Published => ({ format: 'dazl-published-scorecard', version: 1, generated_at: '2026-11-10', batch, superiority })
const sup = (over: Partial<Superiority> = {}): Superiority => ({
  format: 'dazl-superiority', version: 1, plan: { id: 'plan-1', hash: 'abcdef0123456789abcdef', registered_at: '2026-11-01' }, look: 1, origin: 'live', label: 'LIVE',
  systems: { candidate: 'dazl', baseline: 'pancake' }, batches: ['b1'], tasks: 14, repetitions: 3, missing_pairs: [],
  metrics: [{ metric: 'precision_at_10', direction: 'higher', min_effect: 0.05, primary: true, pairs: 40, clusters: 14, candidate_mean: 0.9, baseline_mean: 0.7, difference: 0.2, interval: [0.1, 0.3], decision: 'win', why: 'the whole interval is beyond the minimum effect 0.05' }],
  floors: [{ id: 'precision_floor', ok: true, detail: 'ok' }],
  targets: { precision_floor: { target: 0.9, candidate_interval: [0.91, 0.95], met: true }, yield_advantage: { target: 1.25, ratio: 1.4, interval: [1.3, 1.5], met: true } },
  segments: [], overall: { decision: 'win', why: 'every primary metric won' }, evidence: { evaluator_validated: true, customer_outcomes: 'not measured here (opted-in pilot, #399)' },
  ...over,
} as Superiority)

test('no published batch: nothing is claimed, the example is labelled invented and is never the headline', () => {
  const v = scorecardView(pub(null), EX)
  assert.equal(v.state, 'none'); assert.equal(v.live, null); assert.equal(v.superiority, null)
  assert.match(v.headline, /No live or recorded comparison/)
  assert.match(v.superiorityNote, /No win or loss can be stated/)
  assert.match(v.example.label, /SYNTHETIC/)
  assert.equal(v.example.origin, 'synthetic')
})

test('a synthetic batch placed in the published slot is ignored, never shown as results', () => {
  const v = scorecardView(pub(EX.batch), EX)
  assert.equal(v.state, 'none'); assert.equal(v.live, null)
})

test('a system that did not run has no numbers, no rank and is not a loss', () => {
  const v = scorecardView(pub(liveBatch()), EX)
  const gone = v.live!.systems.filter(s => !s.ran)
  assert.deepEqual(gone.map(s => s.system).sort(), ['gojiberry', 'pancake'])
  for (const s of gone) { assert.deepEqual(s.facts, []); assert.match(s.line, /^Not run: .*Not ranked, and not counted as a loss\.$/) }
  const ran = v.live!.systems.map(s => s.ran)
  assert.deepEqual(ran, [...ran].sort((a, b) => Number(b) - Number(a)), 'systems that ran are listed first')
})

test('unknown stays unknown: a missing cost is "unknown", a missing precision is "n/a", never 0', () => {
  const r: SystemReport = { system: 'x', origin: 'live', status: 'ran', reason: null, tasks: 4, complete: 3, coverage: 0.75, precision_at_5: null, precision_at_10: null, validated: 0, unique_actionable_yield: 0, seconds: null, spend_usd: null, interventions: 2 }
  const f = Object.fromEntries(systemRow(r).facts.map(x => [x.label, x.value]))
  assert.equal(f['Spend'], 'unknown'); assert.equal(f['Precision, top 10'], 'n/a'); assert.equal(f['Time'], 'n/a')
  assert.equal(f['Validated leads'], '0')
})

test('a live batch with an evaluator that is not independent says so', () => {
  const v = scorecardView(pub(liveBatch({}, false)), EX)
  assert.match(v.live!.evaluator, /NOT independent/)
})

test('one batch cannot show a win: without a repeated-run analysis the page says so', () => {
  const v = scorecardView(pub(liveBatch()), EX)
  assert.equal(v.superiority, null)
  assert.match(v.superiorityNote, /one batch cannot show a win, a loss or an interval/)
})

test('a win is stated only for decision win; a failed critical floor reads no winner; inconclusive stays inconclusive', () => {
  const b = liveBatch({ batch_id: 'b1' })
  assert.match(scorecardView(pub(b, sup({ batches: ['b1', 'b2'] })), EX).superiority!.overall, /dazl wins/)
  assert.match(scorecardView(pub(b, sup()), EX).superiority!.overall, /^Inconclusive: a win or a loss needs at least 2 distinct batches/)
  const floor = scorecardView(pub(b, sup({ overall: { decision: 'no_winner_floor_failed', why: 'precision floor failed' }, floors: [{ id: 'precision_floor', ok: false, detail: 'p@10 0.6' }] })), EX).superiority!
  assert.match(floor.overall, /^No winner/); assert.doesNotMatch(floor.overall, /wins/); assert.equal(floor.floors[0].state, 'FAILED')
  const inc = scorecardView(pub(b, sup({ overall: { decision: 'inconclusive', why: 'interval reaches inside' } })), EX).superiority!
  assert.equal(inc.overall, 'Inconclusive')
})

test('an analysis marked synthetic is never shown beside a live batch', () => {
  assert.equal(scorecardView(pub(liveBatch({ batch_id: 'b1' }), sup({ origin: 'synthetic' })), EX).superiority, null)
})

test('publishing refuses a synthetic batch, a non-independent evaluator, a synthetic analysis and an analysis of another batch', () => {
  const full = (origin: string, independent = true) => ({ manifest: { batch_id: 'b1', task_set_version: '1', as_of: '2026-11-10', origin, label: 'l', budget: { usd_per_task: 1, seconds_per_task: 1, batch_usd: 1 }, systems: [] as unknown[], evaluator: { name: 'e', version: '1', independent } }, report: [] as SystemReport[], spent_usd: 0 }) as unknown as BatchResult
  assert.throws(() => toPublished(full('synthetic'), null, 'd'), /cannot be published/)
  assert.throws(() => toPublished(full('live', false), null, 'd'), /not independent/)
  assert.throws(() => toPublished(full('live'), sup({ origin: 'synthetic' }), 'd'), /synthetic/)
  assert.throws(() => toPublished(full('live'), sup({ batches: ['other'] }), 'd'), /does not include batch b1/)
  assert.throws(() => toPublished(full('live'), sup(), 'd'), /a win or a loss needs at least 2 distinct batches/)
  assert.throws(() => toPublished(full('live'), sup({ batches: ['b1', 'b1'] }), 'd'), /at least 2 distinct batches/)
  const ok = toPublished(full('recorded'), sup({ batches: ['b1', 'b2'] }), 'd')
  assert.equal(ok.batch!.manifest.origin, 'recorded'); assert.equal(ok.generated_at, 'd')
})

// ---- Hermes-PC re-check of #1026 (head ad87036d) ----

test('2a: a one-batch LOSS is refused at publish and never shown as "loses"', () => {
  const full = { manifest: { batch_id: 'b1', task_set_version: '1', as_of: '2026-11-10', origin: 'live', label: 'l', budget: { usd_per_task: 1, seconds_per_task: 1, batch_usd: 1 }, evaluator: { name: 'e', version: '1', independent: true }, systems: [] }, report: [], spent_usd: 0 } as never
  const loss = { overall: { decision: 'loss', why: 'worse' } } as never
  assert.throws(() => toPublished(full, sup({ batches: ['b1'], ...(loss as object) }), 'd'), /a win or a loss needs at least 2 distinct batches/)
  assert.throws(() => toPublished(full, sup({ batches: ['b1', 'b1'], ...(loss as object) }), 'd'), /at least 2 distinct batches/)
  assert.doesNotThrow(() => toPublished(full, sup({ batches: ['b1', 'b2'], ...(loss as object) }), 'd'))
  // a hand-edited or older latest.json skips toPublished, so the view must hold the same rule
  const one = scorecardView(pub(liveBatch({ batch_id: 'b1' }), sup({ batches: ['b1'], ...(loss as object) })), EX).superiority!
  assert.match(one.overall, /^Inconclusive/); assert.doesNotMatch(one.overall, /loses/)
  assert.match(scorecardView(pub(liveBatch({ batch_id: 'b1' }), sup({ batches: ['b1', 'b2'], ...(loss as object) })), EX).superiority!.overall, /dazl loses/)
})

test('2b: with one batch no metric says Win or Loss, none shows an interval, and no target says met', () => {
  for (const decision of ['win', 'loss']) {
    const v = scorecardView(pub(liveBatch({ batch_id: 'b1' }), sup({ batches: ['b1'], overall: { decision, why: 'x' } } as never)), EX).superiority!
    assert.match(v.overall, /^Inconclusive/)
    assert.ok(v.metrics.length > 0); for (const m of v.metrics) { assert.equal(m.decision, 'Inconclusive'); assert.doesNotMatch(m.detail, /interval \d|Difference/) }
    for (const t of v.targets) { assert.match(t, /not shown \(one batch\)/); assert.doesNotMatch(t, /\bmet\b|not met/) }
    const text = JSON.stringify(v); assert.doesNotMatch(text, /"Win"|"Loss"|wins|loses/)
  }
  // with two batches the detail is back
  const two = scorecardView(pub(liveBatch({ batch_id: 'b1' }), sup({ batches: ['b1', 'b2'] })), EX).superiority!
  assert.ok(two.metrics.some(m => m.decision === 'Win')); assert.ok(two.metrics.some(m => /interval \d/.test(m.detail))); assert.ok(two.targets.some(t => /: met\./.test(t)))
})

// ---- Hermes-PC re-check of #1026 (head c4b969e6), second round ----

test('2c: with one batch the reason shown is the one-batch message, not the analysis\' own "every primary metric won"', () => {
  for (const [decision, why] of [['win', 'every primary metric won'], ['loss', 'the whole interval is below the minimum effect'], ['inconclusive', 'interval reaches inside the minimum effect']] as const) {
    const v = scorecardView(pub(liveBatch({ batch_id: 'b1' }), sup({ batches: ['b1'], overall: { decision, why } } as never)), EX).superiority!
    assert.match(v.overall, /^Inconclusive/); assert.match(v.why, /Only one batch has been run/); assert.doesNotMatch(v.why, new RegExp(why)); assert.doesNotMatch(JSON.stringify(v), /every primary metric won|below the minimum effect|reaches inside/)
  }
  // a failed critical floor keeps its own reason, and with two batches the analysis' reason is shown
  assert.match(scorecardView(pub(liveBatch({ batch_id: 'b1' }), sup({ batches: ['b1'], overall: { decision: 'no_winner_floor_failed', why: 'precision floor failed' } } as never)), EX).superiority!.why, /precision floor failed/)
  assert.equal(scorecardView(pub(liveBatch({ batch_id: 'b1' }), sup({ batches: ['b1', 'b2'] })), EX).superiority!.why, 'every primary metric won')
})

test('2d: a batches value that is not a list of strings is under 2 batches, in the view and at publish', () => {
  const full = { manifest: { batch_id: 'b1', task_set_version: '1', as_of: '2026-11-10', origin: 'live', label: 'l', budget: { usd_per_task: 1, seconds_per_task: 1, batch_usd: 1 }, evaluator: { name: 'e', version: '1', independent: true }, systems: [] }, report: [], spent_usd: 0 } as never
  for (const bad of ['b1', 'b1b2', 'b1,b2', { 0: 'b1', 1: 'b2', length: 2 }, null, undefined, 5, [1, 2], ['b1', 2], [['b1', 'b2']], ['b1', null]] as unknown[]) {
    const name = JSON.stringify(bad)
    const view = scorecardView(pub(liveBatch({ batch_id: 'b1' }), sup({ batches: bad } as never)), EX).superiority!
    assert.match(view.overall, /^Inconclusive/, name); assert.doesNotMatch(view.overall, /wins|loses/, name); assert.ok(view.metrics.every(m => m.decision === 'Inconclusive'), name)
    for (const decision of ['win', 'loss']) assert.throws(() => toPublished(full, sup({ batches: bad, overall: { decision, why: 'x' } } as never), 'd'), /batch/, name + ' ' + decision)
  }
  assert.doesNotThrow(() => toPublished(full, sup({ batches: ['b1', 'b2'] }), 'd'))
})
