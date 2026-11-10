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
  assert.match(scorecardView(pub(b, sup()), EX).superiority!.overall, /dazl wins/)
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
  const ok = toPublished(full('recorded'), sup(), 'd')
  assert.equal(ok.batch!.manifest.origin, 'recorded'); assert.equal(ok.generated_at, 'd')
})
