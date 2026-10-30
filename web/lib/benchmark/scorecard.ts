// Lead-quality benchmark scorecard (issue #372; docs/BENCHMARK.md). Pure: no network, no model, no store.
//
// A run is one system (dazl, or a competitor / baseline) on one frozen task set (scoreboard/benchmark/v<N>/tasks.json).
// Every returned result carries a verdict on each field of the shared evaluation contract (#394):
//   identity     the account is the company the result names (not a same-name or wrong-domain entity)
//   constraints  every hard constraint of the task holds (geography, segment, size, exclusions)
//   event_date   the trigger event is evidenced and dated inside the task's window
//   contact      a current, relevant person or route is reachable and permitted
// Each verdict is pass | fail | unknown | contradicted. A result is VALIDATED only when all four pass: unknown is never
// a pass, and every precision denominator counts unknown results as not validated (the unknown rate is reported on
// its own). A task that did not complete (budget, timeout, crash, not run, unsupported by the system) is reported as
// such and never as zero results. Unknown cost stays unknown (null), never 0. Cost is what the run INCURRED: every
// attempted task (complete, incomplete, failed, and any other task that reports a cost) counts toward the total and
// toward cost per validated company; one attempted task with an unknown cost makes the total unknown. The
// complete-task-only figure is reported separately and labelled as such.
//
// Input integrity: the scorecard trusts nothing about its input. Every recorded attempt is accounted for exactly once
// (one record per task: its cost and its failure state), and the frozen task set, the recorded attempts and their
// results must agree. Any inconsistency (a duplicate or unknown task id, a cost or results recorded without an
// outcome, results on a task that did not run, a bad cost, a verdict outside the contract, a set/run version
// mismatch, ...) makes the WHOLE report invalid_input: nothing is scored, no cost is summed, no threshold is
// evaluated. inputProblems() lists every problem with its code, task id and reason.
//
// Who judged matters: a run records its evaluator. Verdicts derived from the pipeline's own fields
// (fromScoreboardResult) are a self-report; no release threshold can be met by a self-report, by synthetic data, or by
// a historical aggregate (counts with no per-result verdicts). Thresholds are proposals for the owner: this module
// reports whether a run meets them, it never accepts anything.
import { isReachable, RECENT_DAYS, FIT_MIN } from '../scan/scoreboard.ts'

export type Verdict = 'pass' | 'fail' | 'unknown' | 'contradicted'
export const FIELDS = ['identity', 'constraints', 'event_date', 'contact'] as const
export type Field = typeof FIELDS[number]
export type TaskStatus = 'complete' | 'incomplete' | 'failed' | 'unsupported' | 'not_run'
export type Origin = 'live' | 'recorded' | 'synthetic' | 'historical-aggregate'

export interface Task { id: string; region: string; country: string; sector: string; kind: 'standard' | 'negative' | 'ambiguous' | 'cold_start'; language: string; query: string; expect?: { expected_empty?: boolean } }
export interface TaskSet { version: string; frozen_at: string; tasks: Task[] }
export interface ResultRow { rank: number; entity_key: string; verdicts: Record<Field, Verdict>; evidence?: string[] }
export interface TaskRun { task_id: string; status: TaskStatus; reason?: string | null; seconds: number | null; cost_usd: number | null; results: ResultRow[]; aggregate?: Record<string, number> }
export interface BenchmarkRun {
  format: 'dazl-benchmark-run'; version: 1
  system: string                       // 'dazl', 'pancake', 'gojiberry', 'chatgpt-web-baseline', ...
  system_version: string | null
  origin: Origin
  task_set_version: string
  commit: string | null
  config: Record<string, unknown>      // model, rubric hash, enabled sources, budget...
  evaluator: { name: string; version: string; independent: boolean }
  started_at: string
  source?: string                      // where a recorded/historical run came from
  tasks: TaskRun[]
}

const ratio = (n: number, d: number) => d > 0 ? Math.round((n / d) * 1000) / 1000 : null
export const validated = (r: ResultRow) => FIELDS.every(f => r.verdicts[f] === 'pass')
const hasUnknown = (r: ResultRow) => FIELDS.some(f => r.verdicts[f] === 'unknown')

export interface TaskScore {
  task_id: string; region: string; sector: string; kind: Task['kind']; status: TaskStatus; reason: string | null
  returned: number; validated: number; unknown_results: number; contradicted_results: number
  precision_at_5: number | null; precision_at_10: number | null; validated_at_10: number
  unknown_rate: number | null
  fields: Record<Field, Record<Verdict, number>>
  false_alerts: number | null          // negative tasks: validated results where none should exist
  seconds: number | null; cost_usd: number | null
}
export function scoreTask(task: Task, run: TaskRun | undefined): TaskScore {
  const results = [...(run?.results ?? [])].sort((a, b) => a.rank - b.rank)
  const status: TaskStatus = run?.status ?? 'not_run'
  const fields = Object.fromEntries(FIELDS.map(f => [f, { pass: 0, fail: 0, unknown: 0, contradicted: 0 }])) as TaskScore['fields']
  for (const r of results) for (const f of FIELDS) fields[f][r.verdicts[f] ?? 'unknown']++
  const at = (k: number) => { const top = results.slice(0, k); return top.length ? ratio(top.filter(validated).length, top.length) : null }
  const v = results.filter(validated).length
  return {
    task_id: task.id, region: task.region, sector: task.sector, kind: task.kind, status, reason: run?.reason ?? (run ? null : 'no run for this task'),
    returned: results.length, validated: v, unknown_results: results.filter(hasUnknown).length,
    contradicted_results: results.filter(r => FIELDS.some(f => r.verdicts[f] === 'contradicted')).length,
    precision_at_5: status === 'complete' ? at(5) : null, precision_at_10: status === 'complete' ? at(10) : null,
    validated_at_10: results.slice(0, 10).filter(validated).length,
    unknown_rate: ratio(results.filter(hasUnknown).length, results.length),
    fields, false_alerts: task.expect?.expected_empty ? v : null,
    seconds: run?.seconds ?? null, cost_usd: run?.cost_usd ?? null,
  }
}

export interface Scorecard {
  format: 'dazl-benchmark-scorecard'; version: 1; status: 'scored'
  system: string; system_version: string | null; origin: Origin; task_set_version: string; commit: string | null; config: Record<string, unknown>
  evaluator: BenchmarkRun['evaluator']; started_at: string; source: string | null
  evaluable: boolean; not_evaluable_reason: string | null
  totals: {
    tasks: number; complete: number; incomplete: number; failed: number; unsupported: number; not_run: number
    returned: number; validated: number; unique_validated_entities: number; unknown_results: number; contradicted_results: number
    precision_at_10: number | null          // pooled over complete tasks' top 10s (unknown = not validated)
    unknown_rate: number | null
    false_alerts: number; negative_tasks: number; negative_tasks_complete: number
    cost_usd: number | null               // every attempted task, failed and incomplete included
    cost_attempted_tasks: number; cost_unknown_tasks: number  // attempted tasks / those of them without a cost
    cost_per_validated_usd: number | null // cost_usd / validated
    cost_complete_only_usd: number | null // complete tasks only: NOT the run's cost, never used by a threshold
    median_seconds: number | null
  }
  by_region: Record<string, { tasks: number; complete: number; validated: number }>
  by_sector: Record<string, { tasks: number; complete: number; validated: number }>
  tasks: TaskScore[]
  aggregates: { task_id: string; status: TaskStatus; aggregate: Record<string, number> }[]
}

// ---------- input integrity ----------
export interface InputProblem { code: string; task_id: string | null; detail: string }
export interface InvalidScorecard { format: 'dazl-benchmark-scorecard'; version: 1; status: 'invalid_input'; system: string | null; task_set_version: string | null; problems: InputProblem[] }
const STATUSES: TaskStatus[] = ['complete', 'incomplete', 'failed', 'unsupported', 'not_run']
const VERDICTS: Verdict[] = ['pass', 'fail', 'unknown', 'contradicted']
const KINDS: Task['kind'][] = ['standard', 'negative', 'ambiguous', 'cold_start']
const ORIGINS: Origin[] = ['live', 'recorded', 'synthetic', 'historical-aggregate']
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isId = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0
const nonNeg = (x: unknown) => x === null || x === undefined || (typeof x === 'number' && Number.isFinite(x) && x >= 0)
const show = (x: unknown) => x === undefined ? 'missing' : JSON.stringify(x)
// Every problem with the frozen set and the run, as plain parsed JSON (the declared types are not trusted). Empty = scorable.
export function inputProblems(set: TaskSet, run: BenchmarkRun): InputProblem[] {
  const out: InputProblem[] = []
  const bad = (code: string, task_id: string | null, detail: string) => { out.push({ code, task_id, detail }) }
  const s = set as unknown, r = run as unknown
  if (!isObj(s) || !isId(s.version)) { bad('set_invalid', null, 'the frozen task set has no version'); return out }
  if (!Array.isArray(s.tasks) || s.tasks.length === 0) { bad('set_invalid', null, `frozen task set v${s.version} has no tasks`); return out }
  const setIds = new Map<string, number>()
  s.tasks.forEach((t: unknown, i: number) => {
    if (!isObj(t) || !isId(t.id)) return bad('set_task_invalid', null, `frozen task set entry ${i} has no id`)
    setIds.set(t.id, (setIds.get(t.id) ?? 0) + 1)
    if (!KINDS.includes(t.kind as Task['kind'])) bad('set_task_invalid', t.id, `kind ${show(t.kind)} is not one of ${KINDS.join(', ')}`)
  })
  for (const [id, n] of setIds) if (n > 1) bad('set_duplicate_task', id, `frozen task set v${s.version} lists task ${id} ${n} times`)
  if (!isObj(r)) { bad('run_invalid', null, 'the run is not an object'); return out }
  if (r.format !== 'dazl-benchmark-run' || r.version !== 1) bad('run_format_invalid', null, `format ${show(r.format)} version ${show(r.version)}: expected dazl-benchmark-run version 1`)
  if (r.task_set_version !== s.version) bad('task_set_version_mismatch', null, `the run is for task set v${String(r.task_set_version)}, the frozen set is v${s.version}`)
  if (!ORIGINS.includes(r.origin as Origin)) bad('run_origin_invalid', null, `origin ${show(r.origin)} is not one of ${ORIGINS.join(', ')}`)
  if (!isObj(r.evaluator) || !isId(r.evaluator.name) || typeof r.evaluator.independent !== 'boolean') bad('run_evaluator_invalid', null, 'the run has no evaluator with a name and independent: true | false')
  if (!Array.isArray(r.tasks)) { bad('run_tasks_invalid', null, 'run.tasks is not a list'); return out }
  const seen = new Map<string, Record<string, unknown>[]>()
  r.tasks.forEach((t: unknown, i: number) => {
    if (!isObj(t) || !isId(t.task_id)) return bad('task_id_invalid', null, `run.tasks[${i}] has no task_id`)
    const id = t.task_id
    seen.set(id, [...(seen.get(id) ?? []), t])
    if (!setIds.has(id)) bad('unknown_task', id, `run.tasks[${i}] records task ${id}, which is not in frozen task set v${s.version}`)
    const n = Array.isArray(t.results) ? t.results.length : 0
    if (!STATUSES.includes(t.status as TaskStatus)) {
      const has = [typeof t.cost_usd === 'number' ? `cost_usd ${t.cost_usd}` : null, n ? `${n} result(s)` : null].filter(Boolean)
      bad('status_invalid', id, `status ${show(t.status)} is not one of ${STATUSES.join(', ')}${has.length ? `; ${has.join(' and ')} recorded without an outcome` : ''}`)
    }
    if (!nonNeg(t.cost_usd)) bad('cost_invalid', id, `cost_usd ${show(t.cost_usd)} is not a non-negative number or null (unknown)`)
    if (!nonNeg(t.seconds)) bad('seconds_invalid', id, `seconds ${show(t.seconds)} is not a non-negative number or null`)
    if (t.aggregate !== undefined && (!isObj(t.aggregate) || Object.values(t.aggregate).some(v => typeof v !== 'number' || !Number.isFinite(v)))) bad('aggregate_invalid', id, 'aggregate must map names to finite numbers')
    if (!Array.isArray(t.results)) return bad('results_invalid', id, `results ${show(t.results)} is not a list`)
    if (n && (t.status === 'not_run' || t.status === 'unsupported')) bad('results_without_attempt', id, `${n} result(s) recorded for a task with status ${t.status}: a task that did not run has no results`)
    const ranks = new Map<number, number>()
    t.results.forEach((x: unknown, j: number) => {
      if (!isObj(x)) return bad('result_invalid', id, `results[${j}] is not an object`)
      if (typeof x.rank === 'number' && Number.isInteger(x.rank) && x.rank >= 1) ranks.set(x.rank, (ranks.get(x.rank) ?? 0) + 1)
      else bad('rank_invalid', id, `results[${j}] rank ${show(x.rank)} is not a positive integer`)
      if (!isId(x.entity_key)) bad('entity_invalid', id, `results[${j}] has no entity_key`)
      if (!isObj(x.verdicts)) bad('verdict_invalid', id, `results[${j}] has no verdicts`)
      else for (const f of FIELDS) if (!VERDICTS.includes(x.verdicts[f] as Verdict)) bad('verdict_invalid', id, `results[${j}] ${f} verdict ${show(x.verdicts[f])} is not one of ${VERDICTS.join(', ')}`)
    })
    for (const [rank, k] of ranks) if (k > 1) bad('rank_duplicate', id, `rank ${rank} appears ${k} times`)
  })
  for (const [id, ts] of seen) if (ts.length > 1) bad('duplicate_task', id, `${ts.length} attempts recorded for task ${id} (${ts.map(t => `${String(t.status)} cost_usd ${t.cost_usd ?? 'unknown'}, ${Array.isArray(t.results) ? t.results.length : 0} result(s)`).join('; ')}): one record per task; a repeated attempt is never selected, merged or dropped`)
  return out
}
export const problemSummary = (ps: InputProblem[]) => ps.map(p => `${p.code}${p.task_id ? ` ${p.task_id}` : ''}`).join(', ')

export function scorecard(set: TaskSet, run: BenchmarkRun): Scorecard | InvalidScorecard {
  const problems = inputProblems(set, run)
  if (problems.length) return { format: 'dazl-benchmark-scorecard', version: 1, status: 'invalid_input', system: isObj(run) && isId(run.system) ? run.system : null, task_set_version: isObj(set) && isId(set.version) ? set.version : null, problems }
  const byId = new Map(run.tasks.map(t => [t.task_id, t]))   // one record per task: inputProblems rejected duplicates
  const tasks = set.tasks.map(t => scoreTask(t, byId.get(t.id)))
  const done = tasks.filter(t => t.status === 'complete')
  const top10 = set.tasks.flatMap(t => (byId.get(t.id)?.status === 'complete' ? [...byId.get(t.id)!.results].sort((a, b) => a.rank - b.rank).slice(0, 10) : []))
  const all = run.tasks.flatMap(t => t.results)
  const entities = new Set(all.filter(validated).map(r => r.entity_key.trim().toLowerCase()))
  const sum = (xs: TaskScore[]) => xs.length && xs.every(t => t.cost_usd !== null) ? Math.round(xs.reduce((a, t) => a + t.cost_usd!, 0) * 1e6) / 1e6 : null
  // an attempt incurred cost whether or not it finished; unsupported / not_run count only when they report a cost
  const attempted = tasks.filter(t => ['complete', 'incomplete', 'failed'].includes(t.status) || t.cost_usd !== null)
  const cost = sum(attempted)
  const secs = done.map(t => t.seconds).filter((s): s is number => s !== null).sort((a, b) => a - b)
  const group = (key: 'region' | 'sector') => {
    const out: Record<string, { tasks: number; complete: number; validated: number }> = {}
    for (const t of tasks) { const g = out[t[key]] ??= { tasks: 0, complete: 0, validated: 0 }; g.tasks++; if (t.status === 'complete') g.complete++; g.validated += t.validated }
    return out
  }
  const count = (s: TaskStatus) => tasks.filter(t => t.status === s).length
  const validatedTotal = tasks.reduce((a, t) => a + t.validated, 0)
  const reasons: string[] = []
  if (run.origin === 'synthetic') reasons.push('synthetic data: says nothing about live lead quality')
  if (run.origin === 'historical-aggregate') reasons.push('historical aggregate: counts only, no per-result verdicts')
  if (!run.evaluator.independent) reasons.push(`evaluator "${run.evaluator.name}" is not independent of the system that produced the results`)
  return {
    format: 'dazl-benchmark-scorecard', version: 1, status: 'scored',
    system: run.system, system_version: run.system_version, origin: run.origin, task_set_version: set.version, commit: run.commit, config: run.config,
    evaluator: run.evaluator, started_at: run.started_at, source: run.source ?? null,
    evaluable: reasons.length === 0, not_evaluable_reason: reasons.length ? reasons.join('; ') : null,
    totals: {
      tasks: tasks.length, complete: done.length, incomplete: count('incomplete'), failed: count('failed'), unsupported: count('unsupported'), not_run: count('not_run'),
      returned: tasks.reduce((a, t) => a + t.returned, 0), validated: validatedTotal, unique_validated_entities: entities.size,
      unknown_results: tasks.reduce((a, t) => a + t.unknown_results, 0), contradicted_results: tasks.reduce((a, t) => a + t.contradicted_results, 0),
      precision_at_10: ratio(top10.filter(validated).length, top10.length), unknown_rate: ratio(all.filter(hasUnknown).length, all.length),
      false_alerts: tasks.reduce((a, t) => a + (t.false_alerts ?? 0), 0),
      negative_tasks: tasks.filter(t => t.kind === 'negative').length, negative_tasks_complete: done.filter(t => t.kind === 'negative').length,
      cost_usd: cost, cost_attempted_tasks: attempted.length, cost_unknown_tasks: attempted.filter(t => t.cost_usd === null).length,
      cost_per_validated_usd: cost !== null && validatedTotal ? Math.round((cost / validatedTotal) * 100) / 100 : null,
      cost_complete_only_usd: sum(done),
      median_seconds: secs.length ? secs[Math.floor((secs.length - 1) / 2)] : null,
    },
    by_region: group('region'), by_sector: group('sector'), tasks,
    aggregates: run.tasks.filter(t => t.aggregate).map(t => ({ task_id: t.task_id, status: t.status, aggregate: t.aggregate! })),
  }
}

// ---------- proposed release thresholds (for the owner; never accepted here) ----------
// sample 'negative': the metric is only decided by negative tasks, so EVERY negative task in the set must have run to
// completion (and the set must have one); otherwise it is insufficient_sample, never meets. A false_alerts threshold
// always needs this, whether or not its definition says so.
export const NEGATIVE_METRICS: (keyof Scorecard['totals'])[] = ['false_alerts']
export interface Threshold { id: string; metric: keyof Scorecard['totals']; op: '>=' | '<=' | '=='; value: number; min_complete_tasks: number; sample?: 'negative'; why: string }
export interface ThresholdSet { status: 'proposed'; version: string; thresholds: Threshold[] }
export type ThresholdResult = { id: string; result: 'meets' | 'misses' | 'insufficient_sample' | 'not_evaluable' | 'invalid_input'; observed: number | null; detail: string }
export function evaluateThresholds(card: Scorecard | InvalidScorecard, set: ThresholdSet): { status: string; results: ThresholdResult[] } {
  if (card.status === 'invalid_input') {
    const detail = `invalid_input: ${problemSummary(card.problems)}`
    return { status: `invalid_input: nothing was evaluated (${card.problems.length} input problem(s): ${problemSummary(card.problems)})`, results: set.thresholds.map(t => ({ id: t.id, result: 'invalid_input', observed: null, detail })) }
  }
  const results = set.thresholds.map((t): ThresholdResult => {
    if (!(t.metric in card.totals)) return { id: t.id, result: 'invalid_input', observed: null, detail: `metric ${show(t.metric)} is not on the scorecard` }
    const observed = card.totals[t.metric] as number | null
    if (!card.evaluable) return { id: t.id, result: 'not_evaluable', observed, detail: card.not_evaluable_reason! }
    if (card.totals.complete < t.min_complete_tasks) return { id: t.id, result: 'insufficient_sample', observed, detail: `${card.totals.complete} complete task(s), at least ${t.min_complete_tasks} needed` }
    if (t.sample === 'negative' || NEGATIVE_METRICS.includes(t.metric)) {
      const { negative_tasks: n, negative_tasks_complete: c } = card.totals
      if (n === 0 || c < n) return { id: t.id, result: 'insufficient_sample', observed, detail: n === 0 ? 'the task set has no negative task' : `${c} of ${n} negative task(s) complete: ${t.metric} on a negative task that did not run is unknown, not 0` }
    }
    if (observed === null) return { id: t.id, result: 'insufficient_sample', observed, detail: `${t.metric} has no value (no denominator)` }
    const ok = t.op === '>=' ? observed >= t.value : t.op === '<=' ? observed <= t.value : observed === t.value
    return { id: t.id, result: ok ? 'meets' : 'misses', observed, detail: `${t.metric} ${observed} ${t.op} ${t.value}` }
  })
  return { status: `thresholds are ${set.status} (v${set.version}): owner approval required; nothing is accepted by this report`, results }
}

// ---------- regression between two scorecards of the same system and task set ----------
const HIGHER_IS_BETTER: (keyof Scorecard['totals'])[] = ['precision_at_10', 'validated', 'unique_validated_entities', 'complete']
const LOWER_IS_BETTER: (keyof Scorecard['totals'])[] = ['false_alerts', 'unknown_rate', 'contradicted_results']
export function regressions(before: Scorecard, after: Scorecard, tolerance = 0): string[] {
  if (before.task_set_version !== after.task_set_version) throw new Error('scorecards are for different task sets')
  const out: string[] = []
  for (const k of HIGHER_IS_BETTER) { const a = before.totals[k] as number | null, b = after.totals[k] as number | null; if (a !== null && (b === null || b < a - tolerance)) out.push(`${k}: ${a} -> ${b}`) }
  for (const k of LOWER_IS_BETTER) { const a = before.totals[k] as number | null, b = after.totals[k] as number | null; if (a !== null && b !== null && b > a + tolerance) out.push(`${k}: ${a} -> ${b}`) }
  for (const t of after.tasks) { const p = before.tasks.find(x => x.task_id === t.task_id); if (p?.status === 'complete' && t.status !== 'complete') out.push(`${t.task_id}: was complete, now ${t.status}`) }
  return out
}

// ---------- recorded scoreboard runs (web/scripts/scoreboard.mts output) as benchmark runs ----------
// Verdicts from the pipeline's own fields: a SELF-REPORT (evaluator.independent = false), never release evidence.
type SbLead = { name: string; company: string; contact: string | null; review_reason: string | null; event_date: string | null; fit: number | null; contacts: string[]; source_url?: string }
type SbResult = { commit: string; date: string; model?: string; rubric?: string; budgetUsdTotal?: number; rows: { id: string; status: string; error: string | null; complete: boolean; seconds: number; leads: SbLead[] }[] }
export function selfReportVerdicts(l: SbLead, asOf: Date): Record<Field, Verdict> {
  const r = l.review_reason ?? ''
  const identity: Verdict = !r ? 'pass' : /mismatch|wrong (company|entity)|someone else|other company/i.test(r) ? 'contradicted' : 'unknown'
  const age = l.event_date && /^\d{4}-\d{2}-\d{2}$/.test(l.event_date) ? (asOf.getTime() - Date.parse(`${l.event_date}T00:00:00Z`)) / 86_400_000 : null
  const event_date: Verdict = age === null ? 'unknown' : age >= -1 && age <= RECENT_DAYS ? 'pass' : 'fail'
  const constraints: Verdict = typeof l.fit !== 'number' ? 'unknown' : l.fit >= FIT_MIN ? 'pass' : l.fit <= 2 ? 'fail' : 'unknown'
  const contact: Verdict = /contact unconfirmed/i.test(r) ? 'unknown' : isReachable(l.contact) || (l.contacts ?? []).some(isReachable) ? 'pass' : 'fail'
  return { identity, constraints, event_date, contact }
}
export function fromScoreboardResult(sb: SbResult, set: TaskSet, source: string): BenchmarkRun {
  const asOf = new Date(`${sb.date}T23:59:59Z`)
  // every row is kept, including one not in the set or a duplicate: the scorecard reports those as invalid_input
  return {
    format: 'dazl-benchmark-run', version: 1, system: 'dazl', system_version: sb.commit, origin: 'recorded', task_set_version: set.version, commit: sb.commit,
    config: { model: sb.model ?? null, rubric: sb.rubric ?? null, budget_usd_total: sb.budgetUsdTotal ?? null, harness: 'web/scripts/scoreboard.mts' },
    evaluator: { name: 'pipeline-self-report', version: '1', independent: false }, started_at: asOf.toISOString(), source,
    tasks: sb.rows.map(r => ({
      task_id: r.id, status: r.complete ? 'complete' : 'incomplete', reason: r.error, seconds: r.seconds, cost_usd: null,
      results: r.leads.map((l, i) => ({ rank: i + 1, entity_key: l.company, verdicts: selfReportVerdicts(l, asOf), evidence: l.source_url ? [l.source_url] : [] })),
    })),
  }
}

export function scorecardMarkdown(card: Scorecard | InvalidScorecard, thresholds?: ReturnType<typeof evaluateThresholds>): string {
  if (card.status === 'invalid_input') return [
    `# Benchmark scorecard: ${card.system ?? 'unknown system'}, task set v${card.task_set_version ?? '?'}`,
    '',
    `**invalid_input**: nothing was scored. Every recorded attempt must be accounted for exactly once, and the frozen task set, the recorded attempts and their results must agree. ${card.problems.length} problem(s):`,
    '',
    ...card.problems.map(p => `- ${p.code}${p.task_id ? ` (task ${p.task_id})` : ''}: ${p.detail}`),
    ...(thresholds ? ['', `**${thresholds.status}**`] : []),
  ].join('\n') + '\n'
  const t = card.totals, pct = (x: number | null) => x === null ? 'n/a' : `${Math.round(x * 100)}%`
  const lines = [
    `# Benchmark scorecard: ${card.system}${card.system_version ? ` ${card.system_version}` : ''}, task set v${card.task_set_version}`,
    '',
    `Origin **${card.origin}**${card.source ? ` (${card.source})` : ''}, started ${card.started_at}, evaluator ${card.evaluator.name} v${card.evaluator.version} (${card.evaluator.independent ? 'independent' : 'NOT independent'}).`,
    ...(card.evaluable ? [] : ['', `**Not release evidence:** ${card.not_evaluable_reason}.`]),
    '',
    `Tasks: ${t.tasks} (complete ${t.complete}, incomplete ${t.incomplete}, failed ${t.failed}, unsupported ${t.unsupported}, not run ${t.not_run}). Incomplete and not-run tasks are unknown, not zero.`,
    `Results ${t.returned}; validated ${t.validated} (all four fields pass); unique validated companies ${t.unique_validated_entities}; precision@10 ${pct(t.precision_at_10)} (unknown counts as not validated); unknown rate ${pct(t.unknown_rate)}; false alerts on negative tasks ${t.false_alerts} (${t.negative_tasks_complete} of ${t.negative_tasks} negative task(s) complete${t.negative_tasks_complete < t.negative_tasks ? ': not established' : ''}).`,
    `Cost of all ${t.cost_attempted_tasks} attempted task(s), failed and incomplete included: ${t.cost_usd === null ? `unknown (${t.cost_unknown_tasks} attempted task(s) without a cost)` : `$${t.cost_usd}`}; complete tasks only (not the run's cost) ${t.cost_complete_only_usd === null ? 'unknown' : `$${t.cost_complete_only_usd}`}; per validated ${t.cost_per_validated_usd === null ? 'n/a' : `$${t.cost_per_validated_usd}`}; median ${t.median_seconds ?? 'n/a'} s.`,
    '',
    '| Task | Region | Kind | Status | Returned | Validated | P@10 | Unknown | Identity p/f/u/c | Constraints p/f/u/c | Date p/f/u/c | Contact p/f/u/c |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...card.tasks.map(s => { const f = (k: Field) => `${s.fields[k].pass}/${s.fields[k].fail}/${s.fields[k].unknown}/${s.fields[k].contradicted}`; return `| ${s.task_id} | ${s.region} | ${s.kind} | ${s.status}${s.reason ? ` (${String(s.reason).slice(0, 40)})` : ''} | ${s.returned} | **${s.validated}** | ${pct(s.precision_at_10)} | ${pct(s.unknown_rate)} | ${f('identity')} | ${f('constraints')} | ${f('event_date')} | ${f('contact')} |` }),
  ]
  if (card.aggregates.length) lines.push('', 'Aggregate-only evidence (no per-result verdicts):', '', ...card.aggregates.map(a => `- ${a.task_id} (${a.status}): ${Object.entries(a.aggregate).map(([k, v]) => `${k} ${v}`).join(', ')}`))
  if (thresholds) lines.push('', `**${thresholds.status}**`, '', '| Threshold | Result | Observed | Detail |', '| --- | --- | --- | --- |', ...thresholds.results.map(r => `| ${r.id} | ${r.result} | ${r.observed ?? 'n/a'} | ${r.detail} |`))
  return lines.join('\n') + '\n'
}
