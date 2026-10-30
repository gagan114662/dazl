// Repeated-run superiority tests and uncertainty-aware scorecards (#398; docs/BENCHMARK.md, "Superiority"). Pure: it reads
// batches the runner (./runner.ts, #397) produced and the plan registered before them; it calls nothing.
//
//  - Preregistered. The plan - metrics and their direction, minimum effects, the precision floor, the yield advantage,
//    the cost ceiling, the minimum sample, critical floors, the bootstrap and the stop rule - is frozen and hashed before
//    any result is viewed. A scorecard names that hash; a plan changed afterwards is a different plan. Looks are counted
//    in a ledger the caller keeps: past `max_looks` the analysis refuses, so nobody re-runs until a win appears.
//  - Paired. Each (task, repetition) where both systems completed the task is one pair; a task one side did not
//    complete is reported as missing, never scored as zero. Uncertainty is a cluster bootstrap over tasks (or briefs or
//    accounts, as registered), so repeated runs of one task never count as independent evidence.
//  - Three answers. Each metric, overall and per segment, is `win`, `loss` or `inconclusive`, with its interval, the
//    pair and cluster counts. Too few pairs or an interval that reaches inside the minimum effect is inconclusive.
//  - Floors first. There is no overall winner when a critical accuracy floor fails (contradicted results, precision below
//    the floor, false alerts), whatever the other metrics say.
//  - Kinds of evidence kept apart. Evaluator-validated performance is all this measures; observed customer outcomes come
//    from an opted-in pilot (#399) and are reported as not measured here. Synthetic batches are labelled as such and say
//    nothing about any product.
import { createHash } from 'node:crypto'
import { validated } from './scorecard.ts'
import type { BatchResult, AdapterOrigin } from './runner.ts'

export const METRICS = ['precision_at_5', 'precision_at_10', 'validated', 'unique_actionable_yield', 'unknown_rate', 'failure_rate', 'seconds', 'cost_usd', 'interventions'] as const
export type Metric = typeof METRICS[number]
export interface MetricPlan { metric: Metric; direction: 'higher' | 'lower'; min_effect: number; primary: boolean }
export interface Prereg {
  id: string; registered_at: string
  systems: { candidate: string; baseline: string }
  metrics: MetricPlan[]
  precision_floor: number                                 // the candidate's precision@10 lower bound must reach this (0.90 proposed)
  yield_advantage: number                                 // the candidate's validated yield / the baseline's, lower bound (1.25 = +25% proposed)
  cost_ceiling_usd_per_validated: number | null
  critical: { max_contradicted: number; max_false_alerts: number }
  min_pairs: number; min_clusters: number
  cluster_by: 'task' | 'brief' | 'account'
  segments: ('region' | 'sector')[]
  bootstrap: { resamples: number; level: number; seed: number }
  stop_rule: { max_looks: number }
  power_rationale: string                                 // why min_pairs suffices for min_effect: stated before results
}
export class PreregError extends Error {}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon((v as Record<string, unknown>)[k])])) : v
export const preregHash = (p: Prereg): string => sha(JSON.stringify(canon(p)))

// Plans, ledgers and batches arrive as JSON files: every field is checked for its type and range here, and anything
// else (a wrong type, a missing or unknown key, a non-finite number, a huge bootstrap) is refused as a whole with every
// problem named. It never reaches the arithmetic as a TypeError, and nothing is guessed.
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const int = (v: unknown, lo: number, hi: number): v is number => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi
const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max
export const MAX_RESAMPLES = 20_000
export const MAX_LOOKS = 20
const PREREG_KEYS = ['id', 'registered_at', 'systems', 'metrics', 'precision_floor', 'yield_advantage', 'cost_ceiling_usd_per_validated', 'critical', 'min_pairs', 'min_clusters', 'cluster_by', 'segments', 'bootstrap', 'stop_rule', 'power_rationale']
export function checkPrereg(raw: unknown): Prereg {
  if (!isObj(raw)) throw new PreregError('prereg: the plan is not a JSON object')
  const problems: string[] = []
  for (const k of Object.keys(raw)) if (!PREREG_KEYS.includes(k)) problems.push(`unknown key ${k} (a misspelt plan field is never ignored)`)
  if (!str(raw.id)) problems.push('id: a non-empty string')
  if (!str(raw.registered_at, 40) || !/^\d{4}-\d{2}-\d{2}T/.test(raw.registered_at) || Number.isNaN(Date.parse(raw.registered_at))) problems.push('registered_at: an ISO timestamp')
  const sys = raw.systems
  if (!isObj(sys) || !str(sys.candidate) || !str(sys.baseline)) problems.push('systems: { candidate, baseline } names')
  else if (sys.candidate === sys.baseline) problems.push('candidate and baseline differ')
  if (!Array.isArray(raw.metrics) || raw.metrics.length === 0 || raw.metrics.length > METRICS.length) problems.push(`metrics: a list of 1 to ${METRICS.length}`)
  else {
    const seen = new Set<unknown>()
    raw.metrics.forEach((m: unknown, i: number) => {
      if (!isObj(m)) { problems.push(`metrics[${i}]: an object`); return }
      if (!METRICS.includes(m.metric as Metric)) problems.push(`metrics[${i}]: unknown metric ${JSON.stringify(m.metric)?.slice(0, 40)}`)
      else if (seen.has(m.metric)) problems.push(`metrics[${i}]: ${String(m.metric)} is listed twice`)
      seen.add(m.metric)
      if (m.direction !== 'higher' && m.direction !== 'lower') problems.push(`metrics[${i}]: direction higher or lower`)
      if (!num(m.min_effect) || m.min_effect < 0) problems.push(`metrics[${i}]: min_effect a number >= 0`)
      if (typeof m.primary !== 'boolean') problems.push(`metrics[${i}]: primary true or false`)
    })
    if (!raw.metrics.some((m: unknown) => isObj(m) && m.primary === true)) problems.push('at least one primary metric')
  }
  if (!num(raw.precision_floor) || !(raw.precision_floor > 0 && raw.precision_floor <= 1)) problems.push('precision_floor in (0, 1]')
  if (!num(raw.yield_advantage) || raw.yield_advantage < 1 || raw.yield_advantage > 100) problems.push('yield_advantage in [1, 100]')
  if (raw.cost_ceiling_usd_per_validated !== null && (!num(raw.cost_ceiling_usd_per_validated) || raw.cost_ceiling_usd_per_validated <= 0)) problems.push('cost_ceiling_usd_per_validated: null or a number > 0')
  if (!isObj(raw.critical) || !int(raw.critical.max_contradicted, 0, 1e6) || !int(raw.critical.max_false_alerts, 0, 1e6)) problems.push('critical: { max_contradicted, max_false_alerts } whole numbers >= 0')
  if (!int(raw.min_pairs, 2, 1e6) || !int(raw.min_clusters, 2, 1e6)) problems.push('min_pairs and min_clusters: whole numbers >= 2')
  if (raw.cluster_by !== 'task' && raw.cluster_by !== 'brief' && raw.cluster_by !== 'account') problems.push('cluster_by: task, brief or account')
  if (!Array.isArray(raw.segments) || raw.segments.some((s: unknown) => s !== 'region' && s !== 'sector') || new Set(raw.segments).size !== raw.segments.length) problems.push('segments: a list of region / sector, each at most once')
  if (!isObj(raw.bootstrap) || !int(raw.bootstrap.resamples, 200, MAX_RESAMPLES) || !num(raw.bootstrap.level) || !(raw.bootstrap.level > 0.5 && raw.bootstrap.level < 1) || !int(raw.bootstrap.seed, 0, 2 ** 32 - 1))
    problems.push(`bootstrap: 200 to ${MAX_RESAMPLES} resamples, level in (0.5, 1), a whole-number seed`)
  if (!isObj(raw.stop_rule) || !int(raw.stop_rule.max_looks, 1, MAX_LOOKS)) problems.push(`stop_rule.max_looks: 1 to ${MAX_LOOKS}`)
  if (!str(raw.power_rationale, 4000)) problems.push('a power / sample-size rationale is stated before results')
  if (problems.length) throw new PreregError(`prereg ${str(raw.id) ? raw.id : '(no id)'}: ${problems.join('; ')}`)
  return raw as unknown as Prereg
}

export function checkLedger(raw: unknown, planHash: string): LookLedger {
  if (!isObj(raw) || typeof raw.plan_hash !== 'string' || !Array.isArray(raw.looks)
    || !raw.looks.every((l: unknown) => isObj(l) && typeof l.at === 'string' && Array.isArray(l.batches) && l.batches.every((b: unknown) => typeof b === 'string')))
    throw new PreregError('the look ledger is malformed: { plan_hash, looks: [{ at, batches }] }; it is never reset or repaired by the analysis')
  if (raw.plan_hash !== planHash) throw new PreregError('the look ledger belongs to another plan')
  return raw as unknown as LookLedger
}

// The shape analyze reads from each batch file (runner.ts BatchResult). A batch named twice is one batch: repetitions
// are distinct batches, never a replay of the same one.
export function checkBatches(raw: unknown): BatchResult[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new PreregError('no batches')
  const problems: string[] = [], ids = new Set<string>()
  raw.forEach((b: unknown, i: number) => {
    const at = `batch[${i}]`
    if (!isObj(b) || !isObj(b.manifest)) { problems.push(`${at}: not a runner batch result`); return }
    const m = b.manifest
    if (!str(m.batch_id) || !str(m.task_set_version) || !str(m.briefs_hash) || !['synthetic', 'recorded', 'live'].includes(m.origin as string)) { problems.push(`${at}: manifest needs batch_id, task_set_version, briefs_hash and origin`); return }
    if (ids.has(m.batch_id)) problems.push(`${at}: batch ${m.batch_id} is given twice (a replay is not a repetition)`)
    ids.add(m.batch_id)
    if (!Array.isArray(b.runs) || !Array.isArray(b.scorecards) || b.runs.length !== b.scorecards.length) { problems.push(`${at}: runs and scorecards must be lists of the same length`); return }
    if (b.interventions !== undefined && !isObj(b.interventions)) problems.push(`${at}: interventions must be an object`)
    b.runs.forEach((r: unknown, j: number) => {
      const card: unknown = (b.scorecards as unknown[])[j]
      if (!isObj(r) || !str(r.system) || !Array.isArray(r.tasks) || !r.tasks.every((t: unknown) => isObj(t) && str(t.task_id) && Array.isArray(t.results))) { problems.push(`${at}.runs[${j}]: { system, tasks: [{ task_id, results }] }`); return }
      if (!isObj(card) || !Array.isArray(card.tasks) || !card.tasks.every((t: unknown) => isObj(t) && str(t.task_id) && typeof t.status === 'string' && typeof t.region === 'string' && typeof t.sector === 'string')) { problems.push(`${at}.scorecards[${j}]: { tasks: [{ task_id, status, region, sector }] }`); return }
      const runTasks = new Set(r.tasks.map((t: Record<string, unknown>) => t.task_id))
      for (const t of card.tasks as Record<string, unknown>[]) if (!runTasks.has(t.task_id)) problems.push(`${at}: scorecard task ${String(t.task_id)} has no run task`)
    })
  })
  if (problems.length) throw new PreregError(`invalid batches: ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? ` (+${problems.length - 20} more)` : ''}`)
  return raw as BatchResult[]
}

// The look ledger: one entry per analysis of a plan. The caller persists it (a file next to the plan); the analysis
// refuses past max_looks, so results cannot be re-examined until they look like a win.
export interface LookLedger { plan_hash: string; looks: { at: string; batches: string[] }[] }

// --- per (task, repetition) observations ----------------------------------------------------------------------------

interface Obs { task_id: string; rep: number; region: string; sector: string; cluster: string; complete: boolean; m: Record<Metric, number | null>; validatedKeys: Set<string>; contradicted: number; false_alerts: number; cost: number | null }

function observations(batches: BatchResult[], system: string, clusterBy: Prereg['cluster_by'], clusterOf: (task: string) => string): Obs[] {
  const out: Obs[] = []
  batches.forEach((b, rep) => {
    const i = b.runs.findIndex(r => r.system === system)
    if (i < 0) throw new PreregError(`batch ${b.manifest.batch_id} has no system ${system}`)
    const run = b.runs[i], card = b.scorecards[i]
    const others = new Set(b.runs.filter(r => r.system !== system).flatMap(r => r.tasks.flatMap(t => t.results.filter(validated).map(x => `${t.task_id}|${x.entity_key}`))))
    for (const ts of card.tasks) {
      const tr = run.tasks.find(t => t.task_id === ts.task_id)!
      const keys = new Set(tr.results.filter(validated).map(x => x.entity_key))
      const complete = ts.status === 'complete'
      out.push({
        task_id: ts.task_id, rep, region: ts.region, sector: ts.sector, cluster: clusterBy === 'task' ? ts.task_id : clusterOf(ts.task_id), complete,
        validatedKeys: keys, contradicted: ts.contradicted_results, false_alerts: ts.false_alerts ?? 0, cost: ts.cost_usd,
        m: {
          precision_at_5: ts.precision_at_5, precision_at_10: ts.precision_at_10, validated: complete ? ts.validated : null,
          unique_actionable_yield: complete ? [...keys].filter(k => !others.has(`${ts.task_id}|${k}`)).length : null,
          unknown_rate: ts.unknown_rate, failure_rate: ['failed', 'incomplete'].includes(ts.status) ? 1 : ts.status === 'complete' ? 0 : null,
          seconds: ts.seconds, cost_usd: ts.cost_usd, interventions: complete ? b.interventions[system]?.[ts.task_id] ?? null : null,
        },
      })
    }
  })
  return out
}

// --- the bootstrap --------------------------------------------------------------------------------------------------

const rng = (seed: number) => { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296 } }
const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length
const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * q; const lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo) }
const r4 = (x: number) => Math.round(x * 1e4) / 1e4
// Percentile interval of a statistic over clusters resampled with replacement.
function clusterBootstrap<T>(clusters: T[][], stat: (rows: T[]) => number | null, b: Prereg['bootstrap']): { estimate: number | null; lo: number | null; hi: number | null } {
  const all = clusters.flat()
  const estimate = all.length ? stat(all) : null
  if (estimate === null || clusters.length < 2) return { estimate, lo: null, hi: null }
  const rand = rng(b.seed); const draws: number[] = []
  for (let k = 0; k < b.resamples; k++) {
    const rows: T[] = []
    for (let j = 0; j < clusters.length; j++) rows.push(...clusters[Math.floor(rand() * clusters.length)])
    const v = stat(rows); if (v !== null && Number.isFinite(v)) draws.push(v)
  }
  if (draws.length < b.resamples / 2) return { estimate, lo: null, hi: null }
  const a = (1 - b.level) / 2
  return { estimate: r4(estimate), lo: r4(quantile(draws, a)), hi: r4(quantile(draws, 1 - a)) }
}

export type Decision = 'win' | 'loss' | 'inconclusive'
export interface MetricResult { metric: Metric; direction: 'higher' | 'lower'; min_effect: number; primary: boolean; pairs: number; clusters: number; candidate_mean: number | null; baseline_mean: number | null; difference: number | null; interval: [number, number] | null; decision: Decision; why: string }

function decide(m: MetricPlan, pairs: { c: number; b: number; cluster: string }[], p: Prereg): MetricResult {
  const byCluster = new Map<string, { c: number; b: number }[]>()
  for (const x of pairs) byCluster.set(x.cluster, [...(byCluster.get(x.cluster) ?? []), x])
  const clusters = [...byCluster.values()]
  const base = { metric: m.metric, direction: m.direction, min_effect: m.min_effect, primary: m.primary, pairs: pairs.length, clusters: clusters.length, candidate_mean: pairs.length ? r4(mean(pairs.map(x => x.c))) : null, baseline_mean: pairs.length ? r4(mean(pairs.map(x => x.b))) : null }
  if (pairs.length < p.min_pairs || clusters.length < p.min_clusters) return { ...base, difference: null, interval: null, decision: 'inconclusive', why: `inadequate sample: ${pairs.length} pairs in ${clusters.length} clusters (registered minimum ${p.min_pairs} pairs, ${p.min_clusters} clusters)` }
  const ci = clusterBootstrap(clusters, rows => mean(rows.map(r => r.c - r.b)), p.bootstrap)
  if (ci.lo === null || ci.hi === null) return { ...base, difference: ci.estimate, interval: null, decision: 'inconclusive', why: 'no interval could be formed' }
  const better = m.direction === 'higher' ? ci.lo > m.min_effect : ci.hi < -m.min_effect
  const worse = m.direction === 'higher' ? ci.hi < -m.min_effect : ci.lo > m.min_effect
  return { ...base, difference: ci.estimate, interval: [ci.lo, ci.hi], decision: better ? 'win' : worse ? 'loss' : 'inconclusive', why: better ? `the whole interval is beyond the minimum effect ${m.min_effect}` : worse ? `the whole interval is beyond the minimum effect ${m.min_effect}, the wrong way` : `the interval reaches inside the minimum effect ${m.min_effect}: not enough to call` }
}

export interface FloorResult { id: string; ok: boolean | null; detail: string }
export interface SegmentResult { segment: string; value: string; metrics: MetricResult[] }
export interface Superiority {
  format: 'dazl-superiority'; version: 1
  plan: { id: string; hash: string; registered_at: string }; look: number
  origin: AdapterOrigin; label: string
  systems: Prereg['systems']; batches: string[]; tasks: number; repetitions: number
  missing_pairs: { task_id: string; rep: number; candidate_complete: boolean; baseline_complete: boolean }[]
  metrics: MetricResult[]; floors: FloorResult[]
  targets: { precision_floor: { target: number; candidate_interval: [number, number] | null; met: boolean | null }; yield_advantage: { target: number; ratio: number | null; interval: [number, number] | null; met: boolean | null } }
  segments: SegmentResult[]
  overall: { decision: 'win' | 'loss' | 'inconclusive' | 'no_winner_floor_failed'; why: string }
  evidence: { evaluator_validated: true; customer_outcomes: 'not measured here (opted-in pilot, #399)' }
}

export interface AnalyzeOptions { clusterOf?: (task: string) => string; at?: string }
// The analysis. `ledger` is the caller's look record for this plan; the look is appended (and the call refused past
// max_looks) before anything is computed.
// Every input is checked (checkPrereg, checkLedger, checkBatches) and every refusal happens before the look is counted;
// once counted, the look stands even if the caller never sees the result.
export function analyze(planIn: Prereg, registeredHash: string, ledgerIn: LookLedger, batchesIn: BatchResult[], o: AnalyzeOptions = {}): Superiority {
  const plan = checkPrereg(planIn)
  const hash = preregHash(plan)
  if (hash !== registeredHash) throw new PreregError('the plan differs from the one registered (hash mismatch): a changed plan is a new plan, registered before its results')
  const ledger = checkLedger(ledgerIn, hash)
  if (ledger.looks.length >= plan.stop_rule.max_looks) throw new PreregError(`stop rule: this plan allows ${plan.stop_rule.max_looks} look(s) and ${ledger.looks.length} were taken; looking again until a win appears is not allowed`)
  const batches = checkBatches(batchesIn)
  // clustering by brief or account needs the registered map: never a silent fall back to one cluster per task
  if (plan.cluster_by !== 'task' && !o.clusterOf) throw new PreregError(`cluster_by ${plan.cluster_by} needs a cluster map (task -> ${plan.cluster_by})`)
  if (o.clusterOf) {
    const unmapped = [...new Set(batches.flatMap(b => b.scorecards.flatMap(c => c.tasks.map(t => t.task_id))))].filter(t => { const c = o.clusterOf!(t); return typeof c !== 'string' || !c.trim() })
    if (unmapped.length) throw new PreregError(`the cluster map has no ${plan.cluster_by} for task(s) ${unmapped.slice(0, 10).join(', ')}`)
  }
  const origins = new Set(batches.map(b => b.manifest.origin))
  if (origins.size !== 1) throw new PreregError('batches of different origins are never pooled')
  const sets = new Set(batches.map(b => `${b.manifest.task_set_version}|${b.manifest.briefs_hash}`))
  if (sets.size !== 1) throw new PreregError('repetitions must share the task set and frozen briefs')
  ledger.looks.push({ at: o.at ?? new Date().toISOString(), batches: batches.map(b => b.manifest.batch_id) })

  const clusterOf = o.clusterOf ?? (t => t)
  const C = observations(batches, plan.systems.candidate, plan.cluster_by, clusterOf)
  const B = observations(batches, plan.systems.baseline, plan.cluster_by, clusterOf)
  const key = (x: Obs) => `${x.task_id}|${x.rep}`
  const bBy = new Map(B.map(x => [key(x), x]))
  const both = C.map(c => ({ c, b: bBy.get(key(c))! })).filter(x => x.b)
  const paired = both.filter(x => x.c.complete && x.b.complete)
  const missing = both.filter(x => !(x.c.complete && x.b.complete)).map(x => ({ task_id: x.c.task_id, rep: x.c.rep, candidate_complete: x.c.complete, baseline_complete: x.b.complete }))

  const metricsFor = (rows: typeof paired): MetricResult[] => plan.metrics.map(m => {
    const pairs = (m.metric === 'failure_rate' ? both : rows).map(x => ({ c: x.c.m[m.metric], b: x.b.m[m.metric], cluster: x.c.cluster })).filter((x): x is { c: number; b: number; cluster: string } => x.c !== null && x.b !== null)
    return decide(m, pairs, plan)
  })
  const metrics = metricsFor(paired)

  // Targets: the candidate's own precision@10 interval against the floor; yield as a ratio of sums against the advantage.
  const cl = (rows: typeof paired) => { const m = new Map<string, typeof paired>(); for (const r of rows) m.set(r.c.cluster, [...(m.get(r.c.cluster) ?? []), r]); return [...m.values()] }
  const enough = paired.length >= plan.min_pairs && cl(paired).length >= plan.min_clusters
  const pRows = paired.filter(x => x.c.m.precision_at_10 !== null)
  const prec = enough ? clusterBootstrap(cl(pRows), rows => mean(rows.map(r => r.c.m.precision_at_10!)), plan.bootstrap) : { estimate: null, lo: null, hi: null }
  const yld = enough ? clusterBootstrap(cl(paired), rows => { const b = rows.reduce((a, r) => a + (r.b.m.validated ?? 0), 0); return b > 0 ? rows.reduce((a, r) => a + (r.c.m.validated ?? 0), 0) / b : null }, plan.bootstrap) : { estimate: null, lo: null, hi: null }
  const targets: Superiority['targets'] = {
    precision_floor: { target: plan.precision_floor, candidate_interval: prec.lo !== null ? [prec.lo, prec.hi!] : null, met: prec.lo === null ? null : prec.lo >= plan.precision_floor },
    yield_advantage: { target: plan.yield_advantage, ratio: yld.estimate, interval: yld.lo !== null ? [yld.lo, yld.hi!] : null, met: yld.lo === null ? null : yld.lo >= plan.yield_advantage },
  }

  // Critical floors: the candidate's own accuracy, counted over every repetition.
  const contradicted = C.reduce((a, x) => a + x.contradicted, 0), falseAlerts = C.reduce((a, x) => a + x.false_alerts, 0)
  const cCost = C.every(x => !x.complete || x.cost !== null) ? C.reduce((a, x) => a + (x.cost ?? 0), 0) : null
  const cValidated = C.reduce((a, x) => a + (x.complete ? x.validatedKeys.size : 0), 0)
  const floors: FloorResult[] = [
    { id: 'contradicted', ok: contradicted <= plan.critical.max_contradicted, detail: `${contradicted} contradicted result(s); registered maximum ${plan.critical.max_contradicted}` },
    { id: 'false_alerts', ok: falseAlerts <= plan.critical.max_false_alerts, detail: `${falseAlerts} false alert(s) on negative tasks; registered maximum ${plan.critical.max_false_alerts}` },
    { id: 'precision_floor', ok: targets.precision_floor.met, detail: targets.precision_floor.met === null ? 'inadequate sample for the precision floor' : `precision@10 interval ${JSON.stringify(targets.precision_floor.candidate_interval)} vs floor ${plan.precision_floor}` },
    ...(plan.cost_ceiling_usd_per_validated === null ? [] : [{ id: 'cost_ceiling', ok: cCost === null || cValidated === 0 ? null : cCost / cValidated <= plan.cost_ceiling_usd_per_validated, detail: cCost === null ? 'cost unknown for a complete task: the ceiling cannot be shown met' : cValidated === 0 ? 'no validated result: no cost per validated' : `$${r4(cCost / cValidated)} per validated vs ceiling $${plan.cost_ceiling_usd_per_validated}` }]),
  ]

  const segments: SegmentResult[] = plan.segments.flatMap(seg => [...new Set(paired.map(x => x.c[seg]))].sort().map(value => ({ segment: seg, value, metrics: metricsFor(paired.filter(x => x.c[seg] === value)) })))

  const primary = metrics.filter(m => m.primary)
  const failedFloor = floors.filter(f => f.ok === false)
  const overall: Superiority['overall'] = failedFloor.length ? { decision: 'no_winner_floor_failed', why: `critical floor(s) failed: ${failedFloor.map(f => f.id).join(', ')}` }
    : floors.some(f => f.ok === null) ? { decision: 'inconclusive', why: `floor(s) not shown: ${floors.filter(f => f.ok === null).map(f => f.id).join(', ')}` }
    : primary.every(m => m.decision === 'win') && targets.yield_advantage.met === true ? { decision: 'win', why: 'every primary metric wins, every floor holds and the registered yield advantage is met' }
    : primary.some(m => m.decision === 'loss') ? { decision: 'loss', why: `primary metric(s) lost: ${primary.filter(m => m.decision === 'loss').map(m => m.metric).join(', ')}` }
    : { decision: 'inconclusive', why: 'not every primary metric wins, or the yield advantage is not shown' }
  const origin = batches[0].manifest.origin
  return {
    format: 'dazl-superiority', version: 1, plan: { id: plan.id, hash, registered_at: plan.registered_at }, look: ledger.looks.length,
    origin, label: origin === 'synthetic' ? 'SYNTHETIC batches: says nothing about any product' : origin === 'recorded' ? 'recorded outputs' : 'live runs',
    systems: plan.systems, batches: batches.map(b => b.manifest.batch_id), tasks: new Set(C.map(x => x.task_id)).size, repetitions: batches.length,
    missing_pairs: missing, metrics, floors, targets, segments, overall,
    evidence: { evaluator_validated: true, customer_outcomes: 'not measured here (opted-in pilot, #399)' },
  }
}

// --- recurring monitoring (two weeks) -------------------------------------------------------------------------------

export interface Snapshot { day: string; items: { entity_key: string; event_key: string; event_date: string | null; validated: boolean; corrected?: boolean }[] }
export interface MonitoringReport {
  days: number; span_days: number; adequate: boolean
  net_new_events: { day: string; count: number }[]; duplicate_rate: number | null
  freshness_median_days: number | null; correction_retention: number | null; corrections: number
}
// Over repeated runs of one monitor: each day's validated events not seen on an earlier day (net new), the share of
// returned items that repeat an event already returned (duplicates), the median age of new events on the day they
// appeared (freshness), and whether a correction - an item once marked corrected (rejected) - stays out afterwards.
// Under 14 days of span is reported, never stretched: `adequate` says so.
export function monitoring(snaps: Snapshot[]): MonitoringReport {
  const s = [...snaps].sort((a, b) => a.day.localeCompare(b.day))
  const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`)
  const span = s.length ? Math.round((dayMs(s[s.length - 1].day) - dayMs(s[0].day)) / 86_400_000) : 0
  const seen = new Set<string>(); const corrected = new Set<string>(); const reappeared = new Set<string>(); let returned = 0, dup = 0
  const ages: number[] = []; const net: { day: string; count: number }[] = []
  for (const snap of s) {
    let n = 0
    for (const it of snap.items) {
      returned++
      const k = `${it.entity_key}|${it.event_key}`
      if (corrected.has(k)) { if (!it.corrected) reappeared.add(k); continue } // a corrected event back as if new: the correction was not kept
      if (it.corrected) { corrected.add(k); continue }
      if (seen.has(k)) { dup++; continue }
      seen.add(k)
      if (it.validated) { n++; if (it.event_date) ages.push(Math.round((dayMs(snap.day) - dayMs(it.event_date)) / 86_400_000)) }
    }
    net.push({ day: snap.day, count: n })
  }
  return {
    days: s.length, span_days: span, adequate: span >= 14,
    net_new_events: net, duplicate_rate: returned ? r4(dup / returned) : null,
    freshness_median_days: ages.length ? quantile(ages, 0.5) : null,
    correction_retention: corrected.size ? r4((corrected.size - reappeared.size) / corrected.size) : null, corrections: corrected.size,
  }
}
