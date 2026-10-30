// lib/benchmark/scorecard.ts (issue #372) on SYNTHETIC runs (origin 'synthetic': they say nothing about lead quality).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateThresholds, fromScoreboardResult, regressions, scorecard, FIELDS, type BenchmarkRun, type ResultRow, type TaskSet, type ThresholdSet, type Verdict } from '../lib/benchmark/scorecard.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const set = JSON.parse(readFileSync(path.join(root, 'scoreboard/benchmark/v1/tasks.json'), 'utf8')) as TaskSet
const thresholds = JSON.parse(readFileSync(path.join(root, 'scoreboard/benchmark/proposed-thresholds.json'), 'utf8')) as ThresholdSet
const all = (v: Verdict) => Object.fromEntries(FIELDS.map(f => [f, v])) as ResultRow['verdicts']
const row = (rank: number, key: string, v: Partial<ResultRow['verdicts']> = {}): ResultRow => ({ rank, entity_key: key, verdicts: { ...all('pass'), ...v } })
const run = (over: Partial<BenchmarkRun> = {}, tasks: BenchmarkRun['tasks'] = []): BenchmarkRun => ({ format: 'dazl-benchmark-run', version: 1, system: 'dazl', system_version: 'test', origin: 'live', task_set_version: '1', commit: 'abc', config: {}, evaluator: { name: 'independent-test', version: '1', independent: true }, started_at: '2026-10-29T00:00:00Z', tasks, ...over })

test('the v1 task set: frozen, varied, and it reuses every scoreboard search unchanged', () => {
  const sb = JSON.parse(readFileSync(path.join(root, 'scoreboard/searches.json'), 'utf8')) as { id: string; query: string }[]
  for (const s of sb) assert.equal(set.tasks.find(t => t.id === s.id)?.query, s.query, `${s.id} reused unchanged`)
  assert.equal(new Set(set.tasks.map(t => t.id)).size, set.tasks.length)
  assert.ok(new Set(set.tasks.map(t => t.country)).size >= 8, 'several countries')
  for (const k of ['negative', 'ambiguous', 'cold_start']) assert.ok(set.tasks.some(t => t.kind === k), k)
  assert.ok(set.tasks.some(t => t.language !== 'en'), 'a non-English market')
  assert.ok(set.tasks.some(t => !/hir|funding|raised/i.test(t.query)), 'a request that is not hiring or funding')
})

test('unknown is never a pass; precision counts unknowns as not validated; the unknown rate is separate', () => {
  const c = scorecard(set, run({}, [{ task_id: 'london-saas-revops', status: 'complete', seconds: 30, cost_usd: 0.5, results: [row(1, 'A'), row(2, 'B', { contact: 'unknown' }), row(3, 'C', { identity: 'contradicted' }), row(4, 'D', { event_date: 'fail' })] }]))
  const t = c.tasks.find(x => x.task_id === 'london-saas-revops')!
  assert.deepEqual([t.returned, t.validated, t.unknown_results, t.contradicted_results, t.precision_at_10, t.unknown_rate], [4, 1, 1, 1, 0.25, 0.25])
  assert.deepEqual(t.fields.contact, { pass: 3, fail: 0, unknown: 1, contradicted: 0 })
})

test('incomplete, failed, unsupported and not-run tasks are never zero results; unknown cost stays unknown', () => {
  const c = scorecard(set, run({}, [
    { task_id: 'ohio-payroll', status: 'incomplete', reason: 'budget_stopped', seconds: 60, cost_usd: 1, results: [] },
    { task_id: 'lisbon-sales', status: 'complete', seconds: 10, cost_usd: null, results: [row(1, 'X')] },
    { task_id: 'dubai-b2b-launch', status: 'unsupported', reason: 'competitor cannot express the AND condition', seconds: null, cost_usd: null, results: [] },
  ]))
  const o = c.tasks.find(x => x.task_id === 'ohio-payroll')!
  assert.equal(o.status, 'incomplete'); assert.equal(o.precision_at_10, null, 'no precision for an incomplete task')
  assert.equal(c.totals.not_run, set.tasks.length - 3); assert.equal(c.totals.unsupported, 1)
  assert.equal(c.totals.cost_usd, null, 'a complete task without a cost makes the total unknown'); assert.equal(c.totals.cost_unknown_tasks, 1)
  assert.match(c.tasks.find(x => x.task_id === 'toronto-dental')!.reason!, /no run/)
})

test('negative task: any validated result is a false alert; unique entities across tasks are counted once', () => {
  const c = scorecard(set, run({}, [
    { task_id: 'negative-antarctica-dental', status: 'complete', seconds: 5, cost_usd: 0.1, results: [row(1, 'Fake Clinic')] },
    { task_id: 'toronto-dental', status: 'complete', seconds: 5, cost_usd: 0.1, results: [row(1, 'Same Co'), row(2, 'same co ')] },
  ]))
  assert.equal(c.totals.false_alerts, 1); assert.equal(c.totals.unique_validated_entities, 2)
})

test('thresholds: never met by synthetic data or a self-report, insufficient sample when too few tasks completed, and never "accepted"', () => {
  const tasks = (n: number) => set.tasks.filter(t => t.kind === 'standard').slice(0, n).map(t => ({ task_id: t.id, status: 'complete' as const, seconds: 10, cost_usd: 0.1, results: [row(1, t.id)] }))
  const synthetic = evaluateThresholds(scorecard(set, run({ origin: 'synthetic' }, tasks(11))), thresholds)
  assert.ok(synthetic.results.every(r => r.result === 'not_evaluable')); assert.match(synthetic.status, /proposed.*owner approval required/)
  const self = evaluateThresholds(scorecard(set, run({ evaluator: { name: 'pipeline-self-report', version: '1', independent: false } }, tasks(11))), thresholds)
  assert.ok(self.results.every(r => r.result === 'not_evaluable' && /not independent/.test(r.detail)))
  const few = evaluateThresholds(scorecard(set, run({}, tasks(3))), thresholds)
  assert.equal(few.results.find(r => r.id === 'precision-at-10')!.result, 'insufficient_sample')
  const enough = evaluateThresholds(scorecard(set, run({}, tasks(11))), thresholds)
  assert.equal(enough.results.find(r => r.id === 'precision-at-10')!.result, 'meets')
  assert.equal(enough.results.find(r => r.id === 'unique-yield')!.result, 'misses', '11 companies < 20')
  assert.ok(!JSON.stringify(enough).includes('accepted') || /nothing is accepted/.test(enough.status))
})

test('regression gate: worse precision, a new false alert or a task that stopped completing is a regression', () => {
  const base = scorecard(set, run({}, [{ task_id: 'toronto-dental', status: 'complete', seconds: 5, cost_usd: 0.1, results: [row(1, 'A'), row(2, 'B')] }]))
  const worse = scorecard(set, run({}, [{ task_id: 'toronto-dental', status: 'complete', seconds: 5, cost_usd: 0.1, results: [row(1, 'A'), row(2, 'B', { identity: 'unknown' })] }, { task_id: 'negative-antarctica-dental', status: 'complete', seconds: 1, cost_usd: 0, results: [row(1, 'Z')] }]))
  const r = regressions(base, worse)
  assert.ok(r.some(x => x.startsWith('precision_at_10')) && r.some(x => x.startsWith('false_alerts')), r.join('; '))
  const stopped = scorecard(set, run({}, [{ task_id: 'toronto-dental', status: 'incomplete', seconds: 5, cost_usd: 0.1, results: [] }]))
  assert.ok(regressions(base, stopped).some(x => /was complete, now incomplete/.test(x)))
  assert.deepEqual(regressions(base, base), [])
})

test('a recorded scoreboard result converts to a self-reported run: verdicts from the pipeline fields, not release evidence', () => {
  const sb = { commit: 'c0ffee1', date: '2026-10-29', rows: [{ id: 'toronto-dental', status: 'done', error: null, complete: true, seconds: 40, leads: [
    { name: 'Owner', company: 'Good Dental', contact: 'owner@good.example', review_reason: null, event_date: '2026-10-01', fit: 5, contacts: [] },
    { name: '', company: 'Undated Dental', contact: null, review_reason: null, event_date: null, fit: 4, contacts: ['+1 416 555 0100'] },
    { name: '', company: 'Wrong Dental', contact: 'x@other.example', review_reason: 'Contact unconfirmed: domain mismatch other.example vs wrong.example', event_date: '2026-10-10', fit: 4, contacts: [] },
  ] }, { id: 'ohio-payroll', status: 'INCOMPLETE', error: 'budget_stopped', complete: false, seconds: 90, leads: [] }] }
  const r = fromScoreboardResult(sb, set, 'synthetic-result.json')
  assert.equal(r.evaluator.independent, false); assert.equal(r.origin, 'recorded')
  const c = scorecard(set, r)
  const t = c.tasks.find(x => x.task_id === 'toronto-dental')!
  assert.deepEqual([t.returned, t.validated], [3, 1])
  assert.deepEqual(t.fields.event_date, { pass: 2, fail: 0, unknown: 1, contradicted: 0 })
  assert.deepEqual(t.fields.identity, { pass: 2, fail: 0, unknown: 0, contradicted: 1 })
  assert.equal(c.tasks.find(x => x.task_id === 'ohio-payroll')!.status, 'incomplete')
  assert.equal(c.evaluable, false)
})

test('CLI: scorecard with thresholds, compare exits 1 on a regression, history prints the recorded evidence', () => {
  const T = mkdtempSync(path.join(tmpdir(), 'bench-cli-'))
  try {
    const web = path.join(root, 'web'), cli = (...a: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/benchmark.mts', ...a], { cwd: web, encoding: 'utf8' })
    const good = path.join(T, 'good.json'), bad = path.join(T, 'bad.json')
    writeFileSync(good, JSON.stringify(run({ origin: 'synthetic', commit: 'good' }, [{ task_id: 'toronto-dental', status: 'complete', seconds: 5, cost_usd: 0.1, results: [row(1, 'A')] }])))
    writeFileSync(bad, JSON.stringify(run({ origin: 'synthetic', commit: 'bad' }, [{ task_id: 'toronto-dental', status: 'complete', seconds: 5, cost_usd: 0.1, results: [row(1, 'A', { contact: 'fail' })] }])))
    const s = cli('scorecard', '--run', good, '--thresholds', '--out', T)
    assert.equal(s.status, 0, s.stderr); assert.match(s.stdout, /Not release evidence:\*\* synthetic data/); assert.match(s.stdout, /owner approval required/)
    cli('scorecard', '--run', bad, '--out', T)
    const c = cli('compare', '--before', path.join(T, 'dazl-good-v1.json'), '--after', path.join(T, 'dazl-bad-v1.json'))
    assert.equal(c.status, 1); assert.match(c.stdout, /precision_at_10: 1 -> 0/)
    const h = cli('history'); assert.equal(h.status, 0); assert.match(h.stdout, /verified=0/); assert.match(h.stdout, /not yet run with a real key/)
  } finally { rmSync(T, { recursive: true, force: true }) }
})

// #459 review: a false-alert threshold cannot be met by a negative task that never ran, and failed/incomplete attempts'
// spend belongs to the run.
test('no-false-alerts needs every negative task complete: not run / incomplete -> insufficient_sample; complete -> meets or misses', () => {
  const neg = set.tasks.filter(t => t.kind === 'negative')
  assert.ok(neg.length >= 1)
  const std = set.tasks.filter(t => t.kind === 'standard').slice(0, 10).map(t => ({ task_id: t.id, status: 'complete' as const, seconds: 10, cost_usd: 1, results: [row(1, t.id)] }))
  const fa = (tasks: BenchmarkRun['tasks'], ths: ThresholdSet = thresholds) => evaluateThresholds(scorecard(set, run({}, tasks)), ths).results.find(r => r.id === 'no-false-alerts')!
  const none = fa(std)
  assert.equal(none.result, 'insufficient_sample', 'ten standard tasks, no negative task run'); assert.match(none.detail, /0 of 1 negative/)
  assert.equal(fa([...std, ...neg.map(t => ({ task_id: t.id, status: 'incomplete' as const, reason: 'timeout', seconds: 60, cost_usd: 1, results: [] }))]).result, 'insufficient_sample', 'incomplete negative')
  assert.equal(fa([...std, ...neg.map(t => ({ task_id: t.id, status: 'failed' as const, reason: 'crash', seconds: 1, cost_usd: 1, results: [] }))]).result, 'insufficient_sample', 'failed negative')
  assert.equal(fa([...std, ...neg.map(t => ({ task_id: t.id, status: 'complete' as const, seconds: 5, cost_usd: 1, results: [] }))]).result, 'meets', 'complete negative, nothing returned')
  const alert = fa([...std, ...neg.map(t => ({ task_id: t.id, status: 'complete' as const, seconds: 5, cost_usd: 1, results: [row(1, 'Fake Clinic')] }))])
  assert.equal(alert.result, 'misses'); assert.equal(alert.observed, 1)
  // a threshold file that forgets `sample: negative` still cannot meet on an unrun negative task
  const stripped = { ...thresholds, thresholds: thresholds.thresholds.map(t => { const { sample: _, ...rest } = t; return rest }) }
  assert.equal(fa(std, stripped).result, 'insufficient_sample')
  const md = scorecard(set, run({}, std))
  assert.equal(md.totals.negative_tasks, neg.length); assert.equal(md.totals.negative_tasks_complete, 0)
})

test('cost counts every attempt: failed and incomplete spend is in the total and per validated; unknown attempt cost propagates', () => {
  const std = set.tasks.filter(t => t.kind === 'standard')
  const ten = std.slice(0, 10).map(t => ({ task_id: t.id, status: 'complete' as const, seconds: 10, cost_usd: 1, results: [row(1, t.id)] }))
  const extra = std[10].id
  const known = scorecard(set, run({}, [...ten, { task_id: extra, status: 'incomplete', reason: 'budget_stopped', seconds: 600, cost_usd: 100, results: [] }])).totals
  assert.equal(known.cost_usd, 110, 'the incomplete attempt\'s $100 is part of the run'); assert.equal(known.cost_per_validated_usd, 11)
  assert.equal(known.cost_complete_only_usd, 10, 'complete-only reported separately'); assert.equal(known.cost_attempted_tasks, 11); assert.equal(known.cost_unknown_tasks, 0)
  const failed = scorecard(set, run({}, [...ten, { task_id: extra, status: 'failed', reason: 'crash', seconds: 3, cost_usd: 5, results: [] }])).totals
  assert.equal(failed.cost_usd, 15); assert.equal(failed.cost_per_validated_usd, 1.5)
  const unknown = scorecard(set, run({}, [...ten, { task_id: extra, status: 'failed', reason: 'crash', seconds: 3, cost_usd: null, results: [] }])).totals
  assert.equal(unknown.cost_usd, null, 'a failed attempt with unknown cost makes the run cost unknown'); assert.equal(unknown.cost_per_validated_usd, null)
  assert.equal(unknown.cost_unknown_tasks, 1); assert.equal(unknown.cost_complete_only_usd, 10)
  const cpv = evaluateThresholds(scorecard(set, run({}, [...ten, { task_id: extra, status: 'incomplete', seconds: 600, cost_usd: 100, results: [] }])), thresholds).results.find(r => r.id === 'cost-per-validated')!
  assert.equal(cpv.result, 'misses', '$11 per validated, not $1'); assert.equal(cpv.observed, 11)
  // no complete task at all: the spend is still reported, nothing per validated
  const zero = scorecard(set, run({}, [{ task_id: extra, status: 'incomplete', seconds: 600, cost_usd: 7, results: [] }, { task_id: std[0].id, status: 'failed', seconds: 1, cost_usd: 0.5, results: [] }])).totals
  assert.equal(zero.complete, 0); assert.equal(zero.cost_usd, 7.5); assert.equal(zero.cost_per_validated_usd, null); assert.equal(zero.cost_complete_only_usd, null)
  const zeroUnknown = scorecard(set, run({}, [{ task_id: extra, status: 'incomplete', seconds: 600, cost_usd: null, results: [] }])).totals
  assert.equal(zeroUnknown.cost_usd, null); assert.equal(zeroUnknown.cost_unknown_tasks, 1)
  // unsupported / not run with no cost incurred nothing; with a reported cost it counts
  const uns = scorecard(set, run({}, [...ten, { task_id: extra, status: 'unsupported', seconds: null, cost_usd: null, results: [] }])).totals
  assert.equal(uns.cost_usd, 10); assert.equal(uns.cost_attempted_tasks, 10)
  assert.equal(scorecard(set, run({}, [...ten, { task_id: extra, status: 'unsupported', seconds: 2, cost_usd: 3, results: [] }])).totals.cost_usd, 13)
})
