// lib/benchmark/labels.ts and paired.ts (issue #372, part 2) on SYNTHETIC runs and labels only: they say nothing about
// lead quality. No network, no model, no scan.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { agreement, applyLabels, labelSheet, sheetCsv, validateLabels, type Label, type LabelSet } from '../lib/benchmark/labels.ts'
import { pairedComparison } from '../lib/benchmark/paired.ts'
import { evaluateThresholds, scorecard, FIELDS, type BenchmarkRun, type ResultRow, type TaskSet, type ThresholdSet, type Verdict } from '../lib/benchmark/scorecard.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const set = JSON.parse(readFileSync(path.join(root, 'scoreboard/benchmark/v1/tasks.json'), 'utf8')) as TaskSet
const thresholds = JSON.parse(readFileSync(path.join(root, 'scoreboard/benchmark/proposed-thresholds.json'), 'utf8')) as ThresholdSet
const all = (v: Verdict) => Object.fromEntries(FIELDS.map(f => [f, v])) as ResultRow['verdicts']
const row = (rank: number, key: string, v: Partial<ResultRow['verdicts']> = {}, evidence: string[] = []): ResultRow => ({ rank, entity_key: key, verdicts: { ...all('pass'), ...v }, evidence })
const run = (over: Partial<BenchmarkRun> = {}, tasks: BenchmarkRun['tasks'] = []): BenchmarkRun => ({ format: 'dazl-benchmark-run', version: 1, system: 'dazl', system_version: 'test', origin: 'live', task_set_version: '1', commit: 'abc', config: {}, evaluator: { name: 'pipeline-self-report', version: '1', independent: false }, started_at: '2026-10-30T00:00:00Z', tasks, ...over })
const labelSet = (labels: Label[], over: Partial<LabelSet> = {}): LabelSet => ({ format: 'dazl-benchmark-labels', version: 1, task_set_version: '1', evaluator: { name: 'synthetic-labeller', version: '1', independent_of: ['dazl'] }, labelled_at: '2026-10-30T00:00:00Z', labels, ...over })
const std = set.tasks.filter(t => t.kind === 'standard')

test('label sheet: blind (no system, rank or verdicts), one row per task and company, seeded order, CSV-safe', () => {
  const r = run({ system: 'secret-system-name' }, [
    { task_id: std[0].id, status: 'complete', seconds: 1, cost_usd: 0.1, results: [row(1, 'Acme, Inc', { contact: 'contradicted' }, ['https://acme.example/news "launch"']), row(2, 'acme,  inc '), row(3, 'Beta')] },
    { task_id: std[1].id, status: 'complete', seconds: 1, cost_usd: 0.1, results: [row(1, 'Acme, Inc')] },
  ])
  const rows = labelSheet(r, set, 7)
  assert.equal(rows.length, 3, 'Acme twice in one task is one row; Acme in another task is its own row')
  assert.deepEqual(rows.map(x => x.row_id), ['r0001', 'r0002', 'r0003'])
  assert.ok(rows.every(x => x.query === set.tasks.find(t => t.id === x.task_id)!.query))
  const csv = sheetCsv(rows)
  assert.doesNotMatch(csv, /secret-system-name|contradicted|\bpass\b|rank/)
  assert.match(csv.split('\n')[0], /^row_id,task_id,query,entity_key,evidence,identity,constraints,event_date,contact$/)
  assert.match(csv, /"Acme, Inc"/); assert.match(csv, /"https:\/\/acme\.example\/news ""launch"""/)
  assert.deepEqual(labelSheet(r, set, 7), rows, 'same seed, same sheet')
  const orders = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(s => labelSheet(r, set, s).map(x => `${x.task_id}/${x.entity_key}`).join('|')))
  assert.ok(orders.size > 1, 'the order is shuffled by the seed, not the system\'s rank')
})

test('apply labels: the labeller\'s verdicts replace the system\'s; unlabelled or blank is unknown; independence is declared per system', () => {
  const tasks: BenchmarkRun['tasks'] = std.slice(0, 10).map((t, i) => ({ task_id: t.id, status: 'complete', seconds: 5, cost_usd: 0.1, results: [row(1, `Co ${i}`), row(2, `Other ${i}`)] }))
  const self = run({}, tasks)
  // the self-report says every result passes everything
  assert.equal(scorecard(set, self).totals.validated, 20)
  assert.ok(evaluateThresholds(scorecard(set, self), thresholds).results.every(r => r.result === 'not_evaluable'))
  // the labeller: "Co i" passes all four; "Other i" has no reachable contact; Co 0 left contact blank; Other 9 unlabelled
  const labels = labelSet([
    ...std.slice(0, 10).map((t, i) => ({ task_id: t.id, entity_key: ` co ${i} `, verdicts: i === 0 ? { identity: 'pass', constraints: 'pass', event_date: 'pass' } : all('pass') } as Label)),
    ...std.slice(0, 9).map((t, i) => ({ task_id: t.id, entity_key: `Other ${i}`, verdicts: { ...all('pass'), contact: 'fail' } } as Label)),
    { task_id: set.tasks.at(-1)!.id, entity_key: 'Never returned', verdicts: all('pass') },
  ])
  const { run: labelled, coverage } = applyLabels(self, labels)
  assert.deepEqual(coverage, { results: 20, labelled: 19, unlabelled: 1, fields_missing: 1, labels_unused: 1 })
  assert.deepEqual(labelled.evaluator, { name: 'synthetic-labeller', version: '1', independent: true })
  const card = scorecard(set, labelled)
  assert.equal(card.evaluable, true)
  assert.equal(card.totals.validated, 9, 'Co 1..9 only: Co 0 has a blank contact (unknown), every Other fails contact or is unlabelled')
  const other9 = labelled.tasks[9].results[1]; assert.deepEqual(other9.verdicts, all('unknown'), 'unlabelled: unknown on every field, never the system\'s pass')
  assert.equal(labelled.tasks[0].results[0].verdicts.contact, 'unknown', 'a blank field is not inherited from the system')
  assert.equal(evaluateThresholds(card, thresholds).results.find(r => r.id === 'precision-at-10')!.result, 'misses', '9 of 20 validated')
  // the same labels, but not declared independent of this system: not evaluable
  const notIndependent = applyLabels(self, { ...labels, evaluator: { ...labels.evaluator, independent_of: ['pancake'] } }).run
  assert.equal(notIndependent.evaluator.independent, false); assert.equal(scorecard(set, notIndependent).evaluable, false)
  // the input run is not modified
  assert.equal(self.tasks[0].results[0].verdicts.contact, 'pass')
})

test('labels are validated: wrong task set, duplicates, unknown fields and verdicts are refused', () => {
  const ok = labelSet([{ task_id: std[0].id, entity_key: 'A', verdicts: all('pass') }])
  assert.deepEqual(validateLabels(ok), [])
  assert.throws(() => applyLabels(run({}, []), { ...ok, task_set_version: '2' }), /task set v2/)
  assert.throws(() => applyLabels(run({}, []), labelSet([{ task_id: std[0].id, entity_key: 'A', verdicts: all('pass') }, { task_id: std[0].id, entity_key: ' a ', verdicts: all('fail') }])), /labelled twice/)
  assert.throws(() => applyLabels(run({}, []), labelSet([{ task_id: std[0].id, entity_key: 'A', verdicts: { identity: 'yes' as Verdict } }])), /verdict yes/)
  assert.throws(() => applyLabels(run({}, []), labelSet([{ task_id: std[0].id, entity_key: 'A', verdicts: { vibes: 'pass' } as Label['verdicts'] }])), /unknown field vibes/)
  assert.throws(() => applyLabels(run({}, []), { ...ok, format: 'other' as 'dazl-benchmark-labels' }), /not a dazl-benchmark-labels/)
})

test('agreement: per field, only rows both labelled; Cohen\'s kappa; undefined when there is no variation', () => {
  const l = (key: string, v: Partial<Record<string, Verdict>>): Label => ({ task_id: std[0].id, entity_key: key, verdicts: v })
  const a = labelSet([l('A', { identity: 'pass', contact: 'pass' }), l('B', { identity: 'pass', contact: 'fail' }), l('C', { identity: 'fail', contact: 'fail' }), l('D', { identity: 'fail', contact: 'pass' }), l('E', { contact: 'pass' })])
  const b = labelSet([l('a', { identity: 'pass', contact: 'pass' }), l('B', { identity: 'fail', contact: 'fail' }), l('C', { identity: 'fail', contact: 'fail' }), l('D', { identity: 'fail', contact: 'pass' })])
  const r = Object.fromEntries(agreement(a, b).map(x => [x.field, x]))
  // identity: 4 shared, 3 agree; a = 2 pass 2 fail, b = 1 pass 3 fail; pe = .5*.25 + .5*.75 = .5; kappa = (.75-.5)/.5 = .5
  assert.deepEqual(r.identity, { field: 'identity', both_labelled: 4, agreed: 3, observed: 0.75, kappa: 0.5 })
  assert.deepEqual(r.contact, { field: 'contact', both_labelled: 4, agreed: 4, observed: 1, kappa: 1 }, 'E is only in one set')
  assert.deepEqual(r.event_date, { field: 'event_date', both_labelled: 0, agreed: 0, observed: null, kappa: null })
  const same = agreement(labelSet([l('A', { identity: 'pass' }), l('B', { identity: 'pass' })]), labelSet([l('A', { identity: 'pass' }), l('B', { identity: 'pass' })]))
  assert.equal(same[0].observed, 1); assert.equal(same[0].kappa, null, 'everything "pass" for both: agreement by chance alone, kappa undefined')
  assert.throws(() => agreement(a, { ...b, task_set_version: '2' }), /different task sets/)
})

// Synthetic scorecards: system `name`, run `k`, with validated_at_10 per task given by f(taskIndex, k).
const card = (name: string, k: number, f: (i: number, k: number) => number | 'incomplete', over: Partial<BenchmarkRun> = {}) =>
  scorecard(set, run({ system: name, commit: `${name}-${k}`, evaluator: { name: 'synthetic-labeller', version: '1', independent: true }, ...over }, std.slice(0, 10).map((t, i) => {
    const n = f(i, k)
    return n === 'incomplete' ? { task_id: t.id, status: 'incomplete', reason: 'timeout', seconds: 60, cost_usd: 0.1, results: [] }
      : { task_id: t.id, status: 'complete', seconds: 5, cost_usd: 0.1, results: Array.from({ length: 10 }, (_, j) => row(j + 1, `${name}-${t.id}-${j}`, j < n ? {} : { contact: 'fail' })) }
  })))

test('paired comparison: B clearly better -> b_better with an interval above 0; noise -> inconclusive; same seed, same answer', () => {
  const as = [0, 1, 2].map(k => card('dazl', k, (i, k) => 2 + ((i + k) % 2)))
  const bs = [0, 1, 2].map(k => card('rival', k, (i, k) => 6 + ((i + k) % 3)))
  const r = pairedComparison(as, bs, { seed: 3 })
  assert.equal(r.verdict, 'b_better'); assert.equal(r.paired_tasks, 10); assert.ok(r.ci95![0] > 0, `${r.ci95}`)
  assert.equal(r.a.runs, 3); assert.ok(r.a.spread !== null && r.a.spread > 0, 'run-to-run spread is reported')
  assert.equal(r.release_evidence, true, 'every card live with an independent evaluator')
  assert.deepEqual(pairedComparison(as, bs, { seed: 3 }), r, 'deterministic')
  assert.equal(pairedComparison(bs, as).verdict, 'a_better')
  // the same systems at the same level, run-to-run noise only: the interval spans 0
  const noisyA = [0, 1, 2].map(k => card('dazl', k, (i, k) => 4 + ((i * 7 + k * 3) % 3) - 1))
  const noisyB = [0, 1, 2].map(k => card('rival', k, (i, k) => 4 + ((i * 5 + k * 2 + 1) % 3) - 1))
  assert.equal(pairedComparison(noisyA, noisyB).verdict, 'inconclusive')
})

test('paired comparison: unpaired tasks are excluded with a reason (never zero); too few pairs; mismatched inputs refused; not release evidence when any card is not evaluable', () => {
  // dazl never completes tasks 0-6: only 3 pairs, below the minimum of 5
  const as = [card('dazl', 0, i => i < 7 ? 'incomplete' : 3)]
  const bs = [card('rival', 0, () => 5)]
  const r = pairedComparison(as, bs)
  assert.equal(r.verdict, 'insufficient_sample'); assert.equal(r.paired_tasks, 3); assert.equal(r.ci95, null)
  assert.equal(r.excluded.filter(e => /no complete run with a value for dazl/.test(e.reason)).length, 7)
  assert.ok(r.excluded.some(e => /either system/.test(e.reason)), 'tasks neither system ran')
  // an incomplete task counted as 0 would make B look 5 better on 10 tasks; excluded, the mean difference is 2
  assert.equal(r.mean_difference, 2)
  assert.throws(() => pairedComparison([card('dazl', 0, () => 1)], [card('rival', 0, () => 1), card('other', 0, () => 1)]), /side B mixes systems/)
  const v2 = { ...card('rival', 0, () => 1), task_set_version: '2' }
  assert.throws(() => pairedComparison([card('dazl', 0, () => 1)], [v2]), /different task sets/)
  assert.throws(() => pairedComparison([], [v2]), /at least one/)
  const synthetic = pairedComparison([card('dazl', 0, () => 2, { origin: 'synthetic' })], [card('rival', 0, () => 6)])
  assert.equal(synthetic.release_evidence, false); assert.match(synthetic.not_evidence_reason!, /synthetic/)
  const selfReport = pairedComparison([card('dazl', 0, () => 2, { evaluator: { name: 'pipeline-self-report', version: '1', independent: false } })], [card('rival', 0, () => 6)])
  assert.equal(selfReport.release_evidence, false); assert.match(selfReport.not_evidence_reason!, /not independent/)
  assert.equal(pairedComparison([card('dazl', 0, () => 2)], [card('rival', 0, () => 6)]).release_evidence, true)
})

test('paired comparison: a lower-is-better metric (unknown rate) points the verdict the right way', () => {
  const unk = (name: string, k: number, n: number) => scorecard(set, run({ system: name, commit: `${name}${k}`, evaluator: { name: 'l', version: '1', independent: true } }, std.slice(0, 10).map(t => ({
    task_id: t.id, status: 'complete', seconds: 1, cost_usd: 0.1, results: Array.from({ length: 10 }, (_, j) => row(j + 1, `${name}${t.id}${j}`, j < n ? { event_date: 'unknown' } : {})) }))))
  const r = pairedComparison([unk('dazl', 0, 6), unk('dazl', 1, 7)], [unk('rival', 0, 1), unk('rival', 1, 2)], { metric: 'unknown_rate' })
  assert.ok(r.mean_difference! < 0); assert.equal(r.verdict, 'b_better', 'rival has fewer unknowns')
})

test('CLI: label-sheet -> apply-labels -> scorecard -> paired, offline', () => {
  const T = mkdtempSync(path.join(tmpdir(), 'bench-eval-'))
  const cli = (...a: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(root, 'web/scripts/benchmark.mts'), ...a], { encoding: 'utf8', env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv })
  const r1 = run({}, std.slice(0, 2).map(t => ({ task_id: t.id, status: 'complete', seconds: 1, cost_usd: 0.1, results: [row(1, `X ${t.id}`)] })))
  writeFileSync(path.join(T, 'run.json'), JSON.stringify(r1))
  let r = cli('label-sheet', '--run', path.join(T, 'run.json'), '--out', path.join(T, 'sheet.csv'))
  assert.equal(r.status, 0, r.stderr); assert.equal(readFileSync(path.join(T, 'sheet.csv'), 'utf8').trim().split('\n').length, 3)
  writeFileSync(path.join(T, 'labels.json'), JSON.stringify(labelSet([{ task_id: std[0].id, entity_key: `x ${std[0].id}`, verdicts: { ...all('pass'), identity: 'contradicted' } }])))
  r = cli('apply-labels', '--run', path.join(T, 'run.json'), '--labels', path.join(T, 'labels.json'), '--out', path.join(T, 'run2.json'))
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout).coverage, { results: 2, labelled: 1, unlabelled: 1, fields_missing: 0, labels_unused: 0 })
  r = cli('scorecard', '--run', path.join(T, 'run2.json'), '--out', T)
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /contradicted|Results 2; validated 0/)
  const a = card('dazl', 0, () => 2), b = card('rival', 0, () => 7)
  writeFileSync(path.join(T, 'a.json'), JSON.stringify(a)); writeFileSync(path.join(T, 'b.json'), JSON.stringify(b))
  r = cli('paired', '--a', path.join(T, 'a.json'), '--b', path.join(T, 'b.json'))
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).verdict, 'b_better')
})
