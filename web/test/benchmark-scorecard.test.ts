// lib/benchmark/scorecard.ts (issue #372) on SYNTHETIC runs (origin 'synthetic': they say nothing about lead quality).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateThresholds, fromScoreboardResult, inputProblems, regressions, scorecard, scorecardMarkdown, FIELDS, type BenchmarkRun, type InvalidScorecard, type ResultRow, type Scorecard, type TaskRun, type TaskSet, type TaskStatus, type ThresholdSet, type Verdict } from '../lib/benchmark/scorecard.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const set = JSON.parse(readFileSync(path.join(root, 'scoreboard/benchmark/v1/tasks.json'), 'utf8')) as TaskSet
const thresholds = JSON.parse(readFileSync(path.join(root, 'scoreboard/benchmark/proposed-thresholds.json'), 'utf8')) as ThresholdSet
const all = (v: Verdict) => Object.fromEntries(FIELDS.map(f => [f, v])) as ResultRow['verdicts']
const row = (rank: number, key: string, v: Partial<ResultRow['verdicts']> = {}): ResultRow => ({ rank, entity_key: key, verdicts: { ...all('pass'), ...v } })
// sc: a scorecard that MUST have scored (the integrity tests below use scorecard() directly)
const sc = (s: TaskSet, r: BenchmarkRun): Scorecard => { const c = scorecard(s, r); if (c.status !== 'scored') throw new Error(`invalid input: ${JSON.stringify(c.problems)}`); return c }
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
  const c = sc(set, run({}, [{ task_id: 'london-saas-revops', status: 'complete', seconds: 30, cost_usd: 0.5, results: [row(1, 'A'), row(2, 'B', { contact: 'unknown' }), row(3, 'C', { identity: 'contradicted' }), row(4, 'D', { event_date: 'fail' })] }]))
  const t = c.tasks.find(x => x.task_id === 'london-saas-revops')!
  assert.deepEqual([t.returned, t.validated, t.unknown_results, t.contradicted_results, t.precision_at_10, t.unknown_rate], [4, 1, 1, 1, 0.25, 0.25])
  assert.deepEqual(t.fields.contact, { pass: 3, fail: 0, unknown: 1, contradicted: 0 })
})

test('incomplete, failed, unsupported and not-run tasks are never zero results; unknown cost stays unknown', () => {
  const c = sc(set, run({}, [
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
  const c = sc(set, run({}, [
    { task_id: 'negative-antarctica-dental', status: 'complete', seconds: 5, cost_usd: 0.1, results: [row(1, 'Fake Clinic')] },
    { task_id: 'toronto-dental', status: 'complete', seconds: 5, cost_usd: 0.1, results: [row(1, 'Same Co'), row(2, 'same co ')] },
  ]))
  assert.equal(c.totals.false_alerts, 1); assert.equal(c.totals.unique_validated_entities, 2)
})

test('thresholds: never met by synthetic data or a self-report, insufficient sample when too few tasks completed, and never "accepted"', () => {
  const tasks = (n: number) => set.tasks.filter(t => t.kind === 'standard').slice(0, n).map(t => ({ task_id: t.id, status: 'complete' as const, seconds: 10, cost_usd: 0.1, results: [row(1, t.id)] }))
  const synthetic = evaluateThresholds(sc(set, run({ origin: 'synthetic' }, tasks(11))), thresholds)
  assert.ok(synthetic.results.every(r => r.result === 'not_evaluable')); assert.match(synthetic.status, /proposed.*owner approval required/)
  const self = evaluateThresholds(sc(set, run({ evaluator: { name: 'pipeline-self-report', version: '1', independent: false } }, tasks(11))), thresholds)
  assert.ok(self.results.every(r => r.result === 'not_evaluable' && /not independent/.test(r.detail)))
  const few = evaluateThresholds(sc(set, run({}, tasks(3))), thresholds)
  assert.equal(few.results.find(r => r.id === 'precision-at-10')!.result, 'insufficient_sample')
  const enough = evaluateThresholds(sc(set, run({}, tasks(11))), thresholds)
  assert.equal(enough.results.find(r => r.id === 'precision-at-10')!.result, 'meets')
  assert.equal(enough.results.find(r => r.id === 'unique-yield')!.result, 'misses', '11 companies < 20')
  assert.ok(!JSON.stringify(enough).includes('accepted') || /nothing is accepted/.test(enough.status))
})

test('regression gate: worse precision, a new false alert or a task that stopped completing is a regression', () => {
  const base = sc(set, run({}, [{ task_id: 'toronto-dental', status: 'complete', seconds: 5, cost_usd: 0.1, results: [row(1, 'A'), row(2, 'B')] }]))
  const worse = sc(set, run({}, [{ task_id: 'toronto-dental', status: 'complete', seconds: 5, cost_usd: 0.1, results: [row(1, 'A'), row(2, 'B', { identity: 'unknown' })] }, { task_id: 'negative-antarctica-dental', status: 'complete', seconds: 1, cost_usd: 0, results: [row(1, 'Z')] }]))
  const r = regressions(base, worse)
  assert.ok(r.some(x => x.startsWith('precision_at_10')) && r.some(x => x.startsWith('false_alerts')), r.join('; '))
  const stopped = sc(set, run({}, [{ task_id: 'toronto-dental', status: 'incomplete', seconds: 5, cost_usd: 0.1, results: [] }]))
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
  const c = sc(set, r)
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
  const fa = (tasks: BenchmarkRun['tasks'], ths: ThresholdSet = thresholds) => evaluateThresholds(sc(set, run({}, tasks)), ths).results.find(r => r.id === 'no-false-alerts')!
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
  const md = sc(set, run({}, std))
  assert.equal(md.totals.negative_tasks, neg.length); assert.equal(md.totals.negative_tasks_complete, 0)
})

test('cost counts every attempt: failed and incomplete spend is in the total and per validated; unknown attempt cost propagates', () => {
  const std = set.tasks.filter(t => t.kind === 'standard')
  const ten = std.slice(0, 10).map(t => ({ task_id: t.id, status: 'complete' as const, seconds: 10, cost_usd: 1, results: [row(1, t.id)] }))
  const extra = std[10].id
  const known = sc(set, run({}, [...ten, { task_id: extra, status: 'incomplete', reason: 'budget_stopped', seconds: 600, cost_usd: 100, results: [] }])).totals
  assert.equal(known.cost_usd, 110, 'the incomplete attempt\'s $100 is part of the run'); assert.equal(known.cost_per_validated_usd, 11)
  assert.equal(known.cost_complete_only_usd, 10, 'complete-only reported separately'); assert.equal(known.cost_attempted_tasks, 11); assert.equal(known.cost_unknown_tasks, 0)
  const failed = sc(set, run({}, [...ten, { task_id: extra, status: 'failed', reason: 'crash', seconds: 3, cost_usd: 5, results: [] }])).totals
  assert.equal(failed.cost_usd, 15); assert.equal(failed.cost_per_validated_usd, 1.5)
  const unknown = sc(set, run({}, [...ten, { task_id: extra, status: 'failed', reason: 'crash', seconds: 3, cost_usd: null, results: [] }])).totals
  assert.equal(unknown.cost_usd, null, 'a failed attempt with unknown cost makes the run cost unknown'); assert.equal(unknown.cost_per_validated_usd, null)
  assert.equal(unknown.cost_unknown_tasks, 1); assert.equal(unknown.cost_complete_only_usd, 10)
  const cpv = evaluateThresholds(sc(set, run({}, [...ten, { task_id: extra, status: 'incomplete', seconds: 600, cost_usd: 100, results: [] }])), thresholds).results.find(r => r.id === 'cost-per-validated')!
  assert.equal(cpv.result, 'misses', '$11 per validated, not $1'); assert.equal(cpv.observed, 11)
  // no complete task at all: the spend is still reported, nothing per validated
  const zero = sc(set, run({}, [{ task_id: extra, status: 'incomplete', seconds: 600, cost_usd: 7, results: [] }, { task_id: std[0].id, status: 'failed', seconds: 1, cost_usd: 0.5, results: [] }])).totals
  assert.equal(zero.complete, 0); assert.equal(zero.cost_usd, 7.5); assert.equal(zero.cost_per_validated_usd, null); assert.equal(zero.cost_complete_only_usd, null)
  const zeroUnknown = sc(set, run({}, [{ task_id: extra, status: 'incomplete', seconds: 600, cost_usd: null, results: [] }])).totals
  assert.equal(zeroUnknown.cost_usd, null); assert.equal(zeroUnknown.cost_unknown_tasks, 1)
  // unsupported / not run with no cost incurred nothing; with a reported cost it counts
  const uns = sc(set, run({}, [...ten, { task_id: extra, status: 'unsupported', seconds: null, cost_usd: null, results: [] }])).totals
  assert.equal(uns.cost_usd, 10); assert.equal(uns.cost_attempted_tasks, 10)
  assert.equal(sc(set, run({}, [...ten, { task_id: extra, status: 'unsupported', seconds: 2, cost_usd: 3, results: [] }])).totals.cost_usd, 13)
})

// #459 re-review: input integrity. Every recorded attempt is accounted for exactly once (its cost and its failure
// state), and the frozen task set, the recorded attempts and their results must agree. Any inconsistency makes the
// WHOLE report invalid_input: no totals, no lower cost, no threshold result (never meets/misses), naming the problem
// and the task ids. These runs are synthetic.
const one: TaskSet = { version: '9', frozen_at: '2026-10-30', tasks: [{ id: 'a', region: 'R', country: 'XX', sector: 's', kind: 'standard', language: 'en', query: 'q' }] }
const attempt = (task_id: string, status: TaskStatus, cost_usd: number | null, results: ResultRow[] = []): TaskRun => ({ task_id, status, seconds: 1, cost_usd, results })
const invalid = (c: Scorecard | InvalidScorecard, why: string): InvalidScorecard => { assert.equal(c.status, 'invalid_input', `${why}: ${JSON.stringify(c)}`); return c as InvalidScorecard }

test("reviewer's negative: a failed $100 attempt and a complete $1 attempt on one task id is invalid input, never a $1 card", () => {
  const r = run({ task_set_version: '9' }, [attempt('a', 'failed', 100), attempt('a', 'complete', 1, [row(1, 'A')])])
  const c = invalid(scorecard(one, r), 'duplicate task id')
  assert.ok(!('totals' in c), 'no totals on invalid input')
  const p = c.problems.filter(p => p.code === 'duplicate_task')
  assert.equal(p.length, 1); assert.equal(p[0].task_id, 'a')
  assert.match(p[0].detail, /2 attempts/); assert.match(p[0].detail, /failed[^;]*100/); assert.match(p[0].detail, /complete[^;]*\b1\b/)
  const th = evaluateThresholds(c, thresholds)
  assert.equal(th.results.length, thresholds.thresholds.length)
  assert.ok(th.results.every(x => x.result === 'invalid_input' && x.observed === null && /duplicate_task.*\ba\b/.test(x.detail)), JSON.stringify(th))
  assert.match(th.status, /invalid_input/); assert.doesNotMatch(th.status, /meets|misses|accepted/)
  const md = scorecardMarkdown(c, th)
  assert.match(md, /\*\*invalid_input\*\*/); assert.match(md, /duplicate_task \(task a\)/); assert.match(md, /failed[^;]*100/)
  assert.doesNotMatch(md, /Tasks: |per validated|meets|misses/)
  // the same attempts, one record each, score: this is the positive control for the rule
  const two: TaskSet = { ...one, tasks: [...one.tasks, { ...one.tasks[0], id: 'b' }] }
  const ok = sc(two, run({ task_set_version: '9' }, [attempt('b', 'failed', 100), attempt('a', 'complete', 1, [row(1, 'A')])]))
  assert.deepEqual([ok.totals.tasks, ok.totals.complete, ok.totals.failed, ok.totals.cost_usd, ok.totals.cost_per_validated_usd, ok.totals.cost_complete_only_usd], [2, 1, 1, 101, 101, 1])
  assert.deepEqual(inputProblems(two, run({ task_set_version: '9' }, [attempt('a', 'complete', 1, [row(1, 'A')])])), [])
})

test('integrity matrix: every inconsistency between the frozen set, the attempts and the results is invalid_input with its ids', () => {
  const r9 = (tasks: unknown[], over: Partial<BenchmarkRun> = {}) => run({ task_set_version: '9', ...over }, tasks as TaskRun[])
  const okRow = row(1, 'A')
  const cases: { name: string; set?: TaskSet; run: BenchmarkRun; code: string; id: string | null; detail?: RegExp }[] = [
    { name: 'unknown task id in results', run: r9([attempt('zzz', 'complete', 1, [okRow])]), code: 'unknown_task', id: 'zzz', detail: /not in frozen task set v9/ },
    { name: 'unknown task id with a failed attempt and a cost', run: r9([attempt('a', 'complete', 1, [okRow]), attempt('ghost', 'failed', 50)]), code: 'unknown_task', id: 'ghost' },
    { name: 'task in the set with no attempt but results (not_run)', run: r9([attempt('a', 'not_run', null, [okRow])]), code: 'results_without_attempt', id: 'a' },
    { name: 'results on an unsupported task', run: r9([attempt('a', 'unsupported', null, [okRow])]), code: 'results_without_attempt', id: 'a' },
    { name: 'duplicate attempt ids, both complete, differing cost', run: r9([attempt('a', 'complete', 1, [okRow]), attempt('a', 'complete', 2, [okRow])]), code: 'duplicate_task', id: 'a', detail: /cost_usd 1.*cost_usd 2/ },
    { name: 'duplicate attempt ids, incomplete then complete', run: r9([attempt('a', 'incomplete', 7), attempt('a', 'complete', 1, [okRow])]), code: 'duplicate_task', id: 'a' },
    { name: 'duplicate attempt ids, both failed', run: r9([attempt('a', 'failed', 3), attempt('a', 'failed', 4)]), code: 'duplicate_task', id: 'a' },
    { name: 'duplicate attempt ids, one with unknown cost', run: r9([attempt('a', 'failed', null), attempt('a', 'complete', 1, [okRow])]), code: 'duplicate_task', id: 'a', detail: /unknown/ },
    { name: 'attempt with cost but no outcome (status missing)', run: r9([{ task_id: 'a', seconds: 1, cost_usd: 5, results: [] }]), code: 'status_invalid', id: 'a', detail: /cost_usd 5 .*without an outcome/ },
    { name: 'outcome (results) without an attempt status', run: r9([{ task_id: 'a', seconds: 1, cost_usd: null, results: [okRow] }]), code: 'status_invalid', id: 'a', detail: /1 result\(s\).*without an outcome/ },
    { name: 'status outside the contract', run: r9([{ ...attempt('a', 'complete', 1, [okRow]), status: 'done' }]), code: 'status_invalid', id: 'a' },
    { name: 'negative cost', run: r9([attempt('a', 'complete', -1, [okRow])]), code: 'cost_invalid', id: 'a' },
    { name: 'non-numeric cost', run: r9([{ ...attempt('a', 'complete', 1, [okRow]), cost_usd: '1' }]), code: 'cost_invalid', id: 'a' },
    { name: 'non-finite cost', run: r9([attempt('a', 'complete', Number.NaN, [okRow])]), code: 'cost_invalid', id: 'a' },
    { name: 'negative seconds', run: r9([{ ...attempt('a', 'complete', 1, [okRow]), seconds: -5 }]), code: 'seconds_invalid', id: 'a' },
    { name: 'result referencing a task not in the frozen set', set: { ...one, version: '1' }, run: run({}, [attempt('toronto-dental', 'complete', 1, [okRow])]), code: 'unknown_task', id: 'toronto-dental' },
    { name: 'version mismatch between set and run', run: run({ task_set_version: '1' }, [attempt('a', 'complete', 1, [okRow])]), code: 'task_set_version_mismatch', id: null, detail: /v1.*v9/ },
    { name: 'duplicate frozen task ids in the set', set: { ...one, tasks: [one.tasks[0], { ...one.tasks[0] }] }, run: r9([attempt('a', 'complete', 1, [okRow])]), code: 'set_duplicate_task', id: 'a' },
    { name: 'frozen task without an id', set: { ...one, tasks: [{ ...one.tasks[0], id: '' }] }, run: r9([]), code: 'set_task_invalid', id: null },
    { name: 'frozen task with an unknown kind', set: { ...one, tasks: [{ ...one.tasks[0], kind: 'positive' as never }] }, run: r9([]), code: 'set_task_invalid', id: 'a' },
    { name: 'attempt without a task id', run: r9([{ status: 'complete', seconds: 1, cost_usd: 1, results: [] }]), code: 'task_id_invalid', id: null },
    { name: 'run with the wrong format', run: r9([attempt('a', 'complete', 1, [okRow])], { format: 'scoreboard' as never }), code: 'run_format_invalid', id: null },
    { name: 'run with an unknown origin', run: r9([attempt('a', 'complete', 1, [okRow])], { origin: 'real' as never }), code: 'run_origin_invalid', id: null },
    { name: 'run without an evaluator', run: r9([attempt('a', 'complete', 1, [okRow])], { evaluator: undefined as never }), code: 'run_evaluator_invalid', id: null },
    { name: 'results that are not a list', run: r9([{ ...attempt('a', 'complete', 1), results: { rank: 1 } }]), code: 'results_invalid', id: 'a' },
    { name: 'verdict outside the contract', run: r9([attempt('a', 'complete', 1, [{ ...okRow, verdicts: { ...okRow.verdicts, identity: 'passed' as never } }])]), code: 'verdict_invalid', id: 'a', detail: /identity.*"passed"/ },
    { name: 'result with a field verdict missing', run: r9([attempt('a', 'complete', 1, [{ ...okRow, verdicts: { identity: 'pass', constraints: 'pass', event_date: 'pass' } as never }])]), code: 'verdict_invalid', id: 'a', detail: /contact/ },
    { name: 'result without verdicts', run: r9([attempt('a', 'complete', 1, [{ rank: 1, entity_key: 'A' } as never])]), code: 'verdict_invalid', id: 'a' },
    { name: 'result without an entity', run: r9([attempt('a', 'complete', 1, [{ ...okRow, entity_key: ' ' }])]), code: 'entity_invalid', id: 'a' },
    { name: 'duplicate ranks', run: r9([attempt('a', 'complete', 1, [row(1, 'A'), row(1, 'B')])]), code: 'rank_duplicate', id: 'a' },
    { name: 'rank that is not a positive integer', run: r9([attempt('a', 'complete', 1, [row(0, 'A')])]), code: 'rank_invalid', id: 'a' },
    { name: 'aggregate with a non-numeric count', run: r9([{ ...attempt('a', 'complete', 1), aggregate: { hits: 'many' } }]), code: 'aggregate_invalid', id: 'a' },
  ]
  for (const k of cases) {
    const c = invalid(scorecard(k.set ?? one, k.run), k.name)
    const p = c.problems.find(p => p.code === k.code)
    assert.ok(p, `${k.name}: expected ${k.code}, got ${JSON.stringify(c.problems)}`)
    assert.equal(p.task_id, k.id, `${k.name}: task id`)
    if (k.detail) assert.match(p.detail, k.detail, k.name)
    const th = evaluateThresholds(c, thresholds)
    assert.ok(th.results.every(x => x.result === 'invalid_input'), `${k.name}: thresholds`)
    if (k.id) assert.ok(th.results.every(x => x.detail.includes(k.id!)), `${k.name}: the id is in the threshold detail`)
    assert.match(scorecardMarkdown(c), new RegExp(`invalid_input[\\s\\S]*${k.code}`), `${k.name}: markdown`)
  }
  // every problem is reported, not only the first
  const many = invalid(scorecard(one, r9([attempt('a', 'complete', -1, [row(1, 'A'), row(1, 'B')]), attempt('a', 'failed', 2), attempt('zzz', 'failed', null)])), 'several problems')
  assert.deepEqual([...new Set(many.problems.map(p => p.code))].sort(), ['cost_invalid', 'duplicate_task', 'rank_duplicate', 'unknown_task'])
  // positive controls: one record per task scores, and the earlier accounting is unchanged
  assert.deepEqual(inputProblems(one, r9([attempt('a', 'complete', 1, [okRow])])), [])
  const std = set.tasks.filter(t => t.kind === 'standard')
  const ten = std.slice(0, 10).map(t => attempt(t.id, 'complete', 1, [row(1, t.id)]))
  const t = sc(set, run({}, [...ten, attempt(std[10].id, 'incomplete', 100)])).totals
  assert.deepEqual([t.cost_usd, t.cost_per_validated_usd, t.cost_complete_only_usd, t.complete, t.incomplete], [110, 11, 10, 10, 1])
  assert.equal(sc(set, run({}, [...ten, attempt(std[10].id, 'not_run', null), attempt(std[11].id, 'unsupported', 3)])).totals.cost_usd, 13, 'an explicit not_run / unsupported record without results is fine')
  // a threshold whose metric is not on the card is invalid input for that threshold only
  const card = sc(set, run({}, ten))
  const typo = evaluateThresholds(card, { ...thresholds, thresholds: [{ id: 'typo', metric: 'precision_at_ten' as never, op: '>=', value: 0.9, min_complete_tasks: 10, why: '' }, thresholds.thresholds[0]] })
  assert.equal(typo.results[0].result, 'invalid_input'); assert.match(typo.results[0].detail, /precision_at_ten/); assert.equal(typo.results[1].result, 'meets')
})

test('CLI integrity: duplicate ids, truncated or malformed files, an unknown task set and a scoreboard row outside the set all exit 2 with invalid_input and write nothing', () => {
  const T = mkdtempSync(path.join(tmpdir(), 'bench-integrity-'))
  try {
    const web = path.join(root, 'web'), cli = (...a: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/benchmark.mts', ...a], { cwd: web, encoding: 'utf8' })
    const out = path.join(T, 'cards'), good = path.join(T, 'good.json')
    const dup = path.join(T, 'dup.json')
    writeFileSync(dup, JSON.stringify(run({ commit: 'dup' }, [attempt('toronto-dental', 'failed', 100), attempt('toronto-dental', 'complete', 1, [row(1, 'A')])])))
    const d = cli('scorecard', '--run', dup, '--thresholds', '--out', out)
    assert.equal(d.status, 2, d.stdout + d.stderr); assert.match(d.stderr, /invalid_input/); assert.match(d.stdout, /invalid_input[\s\S]*duplicate_task \(task toronto-dental\)[\s\S]*failed[^;]*100/)
    assert.doesNotMatch(d.stdout, /meets|misses|Tasks: /); assert.ok(!existsSync(path.join(out, 'dazl-dup-v1.json')), 'no card written for invalid input')
    writeFileSync(good, JSON.stringify(run({ commit: 'good' }, [attempt('toronto-dental', 'complete', 1, [row(1, 'A')])])))
    const cut = path.join(T, 'cut.json'); writeFileSync(cut, readFileSync(good, 'utf8').slice(0, 120))
    const c = cli('scorecard', '--run', cut, '--out', out)
    assert.equal(c.status, 2); assert.match(c.stderr, /invalid_input.*cut\.json.*(truncated|malformed)/); assert.doesNotMatch(c.stderr, /\n\s+at /, 'no stack trace')
    const notRun = path.join(T, 'obj.json'); writeFileSync(notRun, '{"hello":"world"}')
    const n = cli('scorecard', '--run', notRun, '--out', out); assert.equal(n.status, 2); assert.match(n.stderr, /invalid_input/)
    const v77 = path.join(T, 'v77.json'); writeFileSync(v77, JSON.stringify(run({ task_set_version: '77' }, [])))
    const v = cli('scorecard', '--run', v77); assert.equal(v.status, 2); assert.match(v.stderr, /invalid_input.*no frozen task set v77/)
    assert.equal(cli('scorecard', '--run', good, '--out', out).status, 0)
    const card = path.join(out, 'dazl-good-v1.json'), cutCard = path.join(T, 'cut-card.json'); writeFileSync(cutCard, readFileSync(card, 'utf8').slice(0, 200))
    const cmp = cli('compare', '--before', card, '--after', cutCard); assert.equal(cmp.status, 2); assert.match(cmp.stderr, /invalid_input/)
    const cmp2 = cli('compare', '--before', card, '--after', dup); assert.equal(cmp2.status, 2); assert.match(cmp2.stderr, /invalid_input.*not a .*scorecard/)
    const sbRow = (id: string) => ({ id, status: 'done', error: null, complete: true, seconds: 1, leads: [] })
    const sb = path.join(T, 'sb.json'), sbOut = path.join(T, 'sb-run.json')
    writeFileSync(sb, JSON.stringify({ commit: 'c0ffee1', date: '2026-10-29', rows: [sbRow('toronto-dental'), sbRow('not-a-benchmark-task')] }))
    const f = cli('from-scoreboard', '--result', sb, '--out', sbOut); assert.equal(f.status, 2); assert.match(f.stderr, /invalid_input.*unknown_task.*not-a-benchmark-task/); assert.ok(!existsSync(sbOut))
    writeFileSync(sb, JSON.stringify({ commit: 'c0ffee1', date: '2026-10-29', rows: [sbRow('toronto-dental'), sbRow('toronto-dental')] }))
    const f2 = cli('from-scoreboard', '--result', sb, '--out', sbOut); assert.equal(f2.status, 2); assert.match(f2.stderr, /invalid_input.*duplicate_task.*toronto-dental/)
    writeFileSync(sb, JSON.stringify({ commit: 'c0ffee1', date: '2026-10-29', rows: [sbRow('toronto-dental')] }))
    assert.equal(cli('from-scoreboard', '--result', sb, '--out', sbOut).status, 0); assert.ok(existsSync(sbOut))
  } finally { rmSync(T, { recursive: true, force: true }) }
})
