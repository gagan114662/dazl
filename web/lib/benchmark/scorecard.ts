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
// such and never as zero results. Unknown cost stays unknown (null), never 0.
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
  format: 'dazl-benchmark-scorecard'; version: 1
  system: string; system_version: string | null; origin: Origin; task_set_version: string; commit: string | null; config: Record<string, unknown>
  evaluator: BenchmarkRun['evaluator']; started_at: string; source: string | null
  evaluable: boolean; not_evaluable_reason: string | null
  totals: {
    tasks: number; complete: number; incomplete: number; failed: number; unsupported: number; not_run: number
    returned: number; validated: number; unique_validated_entities: number; unknown_results: number; contradicted_results: number
    precision_at_10: number | null          // pooled over complete tasks' top 10s (unknown = not validated)
    unknown_rate: number | null
    false_alerts: number; negative_tasks_complete: number
    cost_usd: number | null; cost_unknown_tasks: number; cost_per_validated_usd: number | null
    median_seconds: number | null
  }
  by_region: Record<string, { tasks: number; complete: number; validated: number }>
  by_sector: Record<string, { tasks: number; complete: number; validated: number }>
  tasks: TaskScore[]
  aggregates: { task_id: string; status: TaskStatus; aggregate: Record<string, number> }[]
}

export function scorecard(set: TaskSet, run: BenchmarkRun): Scorecard {
  if (run.task_set_version !== set.version) throw new Error(`run is for task set v${run.task_set_version}, not v${set.version}`)
  const byId = new Map(run.tasks.map(t => [t.task_id, t]))
  for (const t of run.tasks) if (!set.tasks.some(s => s.id === t.task_id)) throw new Error(`run has a task not in the set: ${t.task_id}`)
  const tasks = set.tasks.map(t => scoreTask(t, byId.get(t.id)))
  const done = tasks.filter(t => t.status === 'complete')
  const top10 = set.tasks.flatMap(t => (byId.get(t.id)?.status === 'complete' ? [...byId.get(t.id)!.results].sort((a, b) => a.rank - b.rank).slice(0, 10) : []))
  const all = run.tasks.flatMap(t => t.results)
  const entities = new Set(all.filter(validated).map(r => r.entity_key.trim().toLowerCase()))
  const costKnown = done.filter(t => t.cost_usd !== null)
  const cost = costKnown.length === done.length && done.length ? costKnown.reduce((a, t) => a + t.cost_usd!, 0) : null
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
    format: 'dazl-benchmark-scorecard', version: 1,
    system: run.system, system_version: run.system_version, origin: run.origin, task_set_version: set.version, commit: run.commit, config: run.config,
    evaluator: run.evaluator, started_at: run.started_at, source: run.source ?? null,
    evaluable: reasons.length === 0, not_evaluable_reason: reasons.length ? reasons.join('; ') : null,
    totals: {
      tasks: tasks.length, complete: done.length, incomplete: count('incomplete'), failed: count('failed'), unsupported: count('unsupported'), not_run: count('not_run'),
      returned: tasks.reduce((a, t) => a + t.returned, 0), validated: validatedTotal, unique_validated_entities: entities.size,
      unknown_results: tasks.reduce((a, t) => a + t.unknown_results, 0), contradicted_results: tasks.reduce((a, t) => a + t.contradicted_results, 0),
      precision_at_10: ratio(top10.filter(validated).length, top10.length), unknown_rate: ratio(all.filter(hasUnknown).length, all.length),
      false_alerts: tasks.reduce((a, t) => a + (t.false_alerts ?? 0), 0), negative_tasks_complete: done.filter(t => t.kind === 'negative').length,
      cost_usd: cost, cost_unknown_tasks: done.length - costKnown.length, cost_per_validated_usd: cost !== null && validatedTotal ? Math.round((cost / validatedTotal) * 100) / 100 : null,
      median_seconds: secs.length ? secs[Math.floor((secs.length - 1) / 2)] : null,
    },
    by_region: group('region'), by_sector: group('sector'), tasks,
    aggregates: run.tasks.filter(t => t.aggregate).map(t => ({ task_id: t.task_id, status: t.status, aggregate: t.aggregate! })),
  }
}

// ---------- proposed release thresholds (for the owner; never accepted here) ----------
export interface Threshold { id: string; metric: keyof Scorecard['totals']; op: '>=' | '<=' | '=='; value: number; min_complete_tasks: number; why: string }
export interface ThresholdSet { status: 'proposed'; version: string; thresholds: Threshold[] }
export type ThresholdResult = { id: string; result: 'meets' | 'misses' | 'insufficient_sample' | 'not_evaluable'; observed: number | null; detail: string }
export function evaluateThresholds(card: Scorecard, set: ThresholdSet): { status: string; results: ThresholdResult[] } {
  const results = set.thresholds.map((t): ThresholdResult => {
    const observed = card.totals[t.metric] as number | null
    if (!card.evaluable) return { id: t.id, result: 'not_evaluable', observed, detail: card.not_evaluable_reason! }
    if (card.totals.complete < t.min_complete_tasks) return { id: t.id, result: 'insufficient_sample', observed, detail: `${card.totals.complete} complete task(s), at least ${t.min_complete_tasks} needed` }
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
  const ids = new Set(set.tasks.map(t => t.id))
  return {
    format: 'dazl-benchmark-run', version: 1, system: 'dazl', system_version: sb.commit, origin: 'recorded', task_set_version: set.version, commit: sb.commit,
    config: { model: sb.model ?? null, rubric: sb.rubric ?? null, budget_usd_total: sb.budgetUsdTotal ?? null, harness: 'web/scripts/scoreboard.mts' },
    evaluator: { name: 'pipeline-self-report', version: '1', independent: false }, started_at: asOf.toISOString(), source,
    tasks: sb.rows.filter(r => ids.has(r.id)).map(r => ({
      task_id: r.id, status: r.complete ? 'complete' : 'incomplete', reason: r.error, seconds: r.seconds, cost_usd: null,
      results: r.leads.map((l, i) => ({ rank: i + 1, entity_key: l.company, verdicts: selfReportVerdicts(l, asOf), evidence: l.source_url ? [l.source_url] : [] })),
    })),
  }
}

export function scorecardMarkdown(card: Scorecard, thresholds?: ReturnType<typeof evaluateThresholds>): string {
  const t = card.totals, pct = (x: number | null) => x === null ? 'n/a' : `${Math.round(x * 100)}%`
  const lines = [
    `# Benchmark scorecard: ${card.system}${card.system_version ? ` ${card.system_version}` : ''}, task set v${card.task_set_version}`,
    '',
    `Origin **${card.origin}**${card.source ? ` (${card.source})` : ''}, started ${card.started_at}, evaluator ${card.evaluator.name} v${card.evaluator.version} (${card.evaluator.independent ? 'independent' : 'NOT independent'}).`,
    ...(card.evaluable ? [] : ['', `**Not release evidence:** ${card.not_evaluable_reason}.`]),
    '',
    `Tasks: ${t.tasks} (complete ${t.complete}, incomplete ${t.incomplete}, failed ${t.failed}, unsupported ${t.unsupported}, not run ${t.not_run}). Incomplete and not-run tasks are unknown, not zero.`,
    `Results ${t.returned}; validated ${t.validated} (all four fields pass); unique validated companies ${t.unique_validated_entities}; precision@10 ${pct(t.precision_at_10)} (unknown counts as not validated); unknown rate ${pct(t.unknown_rate)}; false alerts on negative tasks ${t.false_alerts} (${t.negative_tasks_complete} complete).`,
    `Cost ${t.cost_usd === null ? `unknown (${t.cost_unknown_tasks} complete task(s) without a cost)` : `$${t.cost_usd}`}; per validated ${t.cost_per_validated_usd === null ? 'n/a' : `$${t.cost_per_validated_usd}`}; median ${t.median_seconds ?? 'n/a'} s.`,
    '',
    '| Task | Region | Kind | Status | Returned | Validated | P@10 | Unknown | Identity p/f/u/c | Constraints p/f/u/c | Date p/f/u/c | Contact p/f/u/c |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...card.tasks.map(s => { const f = (k: Field) => `${s.fields[k].pass}/${s.fields[k].fail}/${s.fields[k].unknown}/${s.fields[k].contradicted}`; return `| ${s.task_id} | ${s.region} | ${s.kind} | ${s.status}${s.reason ? ` (${String(s.reason).slice(0, 40)})` : ''} | ${s.returned} | **${s.validated}** | ${pct(s.precision_at_10)} | ${pct(s.unknown_rate)} | ${f('identity')} | ${f('constraints')} | ${f('event_date')} | ${f('contact')} |` }),
  ]
  if (card.aggregates.length) lines.push('', 'Aggregate-only evidence (no per-result verdicts):', '', ...card.aggregates.map(a => `- ${a.task_id} (${a.status}): ${Object.entries(a.aggregate).map(([k, v]) => `${k} ${v}`).join(', ')}`))
  if (thresholds) lines.push('', `**${thresholds.status}**`, '', '| Threshold | Result | Observed | Detail |', '| --- | --- | --- | --- |', ...thresholds.results.map(r => `| ${r.id} | ${r.result} | ${r.observed ?? 'n/a'} | ${r.detail} |`))
  return lines.join('\n') + '\n'
}
