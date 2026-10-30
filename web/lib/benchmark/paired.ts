// Paired comparison of two systems over repeated runs (issue #372, part 2; docs/BENCHMARK.md "Comparing systems").
// Pure: it reads scorecards that already exist.
//
// One run of each system says little: discovery is noisy run to run. So a comparison takes every scorecard of system A
// and of system B on the SAME task set, and for each task averages the metric over that system's complete runs. Only
// tasks where both systems have at least one complete run are paired; every other task is listed with why it was left
// out (never counted as a zero). The result is the mean per-task difference B - A with a seeded bootstrap 95% interval
// over tasks:
//   b_better / a_better   the interval excludes 0
//   inconclusive          it includes 0
//   insufficient_sample   fewer than minPairs paired tasks
// Run-to-run spread (the mean within-task standard deviation for a system with repeats) is reported beside it. A
// comparison of scorecards that are not all evaluable (synthetic, self-report, aggregate) is labelled not release
// evidence, whatever it shows.
import { rng } from './labels.ts'
import type { Scorecard, TaskScore } from './scorecard.ts'

export type PairedMetric = 'validated_at_10' | 'precision_at_10' | 'validated' | 'unknown_rate'
export interface PairedResult {
  metric: PairedMetric; task_set_version: string
  a: { system: string; runs: number; spread: number | null }; b: { system: string; runs: number; spread: number | null }
  paired_tasks: number; excluded: { task_id: string; reason: string }[]
  mean_difference: number | null; ci95: [number, number] | null
  verdict: 'b_better' | 'a_better' | 'inconclusive' | 'insufficient_sample'
  release_evidence: boolean; not_evidence_reason: string | null
  per_task: { task_id: string; a: number; b: number; difference: number }[]
}

const value = (t: TaskScore, m: PairedMetric) => t[m]
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)) }
const r3 = (x: number) => Math.round(x * 1000) / 1000

export function pairedComparison(as: Scorecard[], bs: Scorecard[], opts: { metric?: PairedMetric; resamples?: number; seed?: number; minPairs?: number; lowerIsBetter?: boolean } = {}): PairedResult {
  const metric = opts.metric ?? 'validated_at_10', resamples = opts.resamples ?? 2000, minPairs = opts.minPairs ?? 5
  if (!as.length || !bs.length) throw new Error('need at least one scorecard of each system')
  const all = [...as, ...bs]
  const version = all[0].task_set_version
  if (all.some(c => c.task_set_version !== version)) throw new Error('scorecards are for different task sets')
  for (const [side, cards] of [['A', as], ['B', bs]] as const) if (new Set(cards.map(c => c.system)).size !== 1) throw new Error(`side ${side} mixes systems`)
  if (as[0].system === bs[0].system && as.some(c => bs.includes(c))) throw new Error('the same scorecard is on both sides')

  // per task: that system's values over its complete runs where the metric has a value
  const collect = (cards: Scorecard[]) => {
    const m = new Map<string, number[]>()
    for (const c of cards) for (const t of c.tasks) {
      const v = value(t, metric)
      if (t.status === 'complete' && v !== null) { const xs = m.get(t.task_id) ?? []; xs.push(v); m.set(t.task_id, xs) }
    }
    return m
  }
  const am = collect(as), bm = collect(bs)
  const ids = [...new Set(all.flatMap(c => c.tasks.map(t => t.task_id)))].sort()
  const per_task: PairedResult['per_task'] = [], excluded: PairedResult['excluded'] = []
  for (const id of ids) {
    const x = am.get(id), y = bm.get(id)
    if (!x && !y) excluded.push({ task_id: id, reason: 'no complete run with a value for either system' })
    else if (!x) excluded.push({ task_id: id, reason: `no complete run with a value for ${as[0].system}` })
    else if (!y) excluded.push({ task_id: id, reason: `no complete run with a value for ${bs[0].system}` })
    else per_task.push({ task_id: id, a: r3(mean(x)), b: r3(mean(y)), difference: r3(mean(y) - mean(x)) })
  }
  const spread = (m: Map<string, number[]>) => { const s = [...m.values()].filter(xs => xs.length >= 2).map(sd); return s.length ? r3(mean(s)) : null }

  const notEvidence = all.filter(c => !c.evaluable).map(c => `${c.system} ${c.commit ?? ''}: ${c.not_evaluable_reason}`.trim())
  const base = {
    metric, task_set_version: version,
    a: { system: as[0].system, runs: as.length, spread: spread(am) }, b: { system: bs[0].system, runs: bs.length, spread: spread(bm) },
    paired_tasks: per_task.length, excluded, per_task,
    release_evidence: notEvidence.length === 0, not_evidence_reason: notEvidence.length ? [...new Set(notEvidence)].join('; ') : null,
  }
  if (per_task.length < minPairs) return { ...base, mean_difference: per_task.length ? r3(mean(per_task.map(p => p.difference))) : null, ci95: null, verdict: 'insufficient_sample' }

  const d = per_task.map(p => p.difference), next = rng(opts.seed ?? 1)
  const boots: number[] = []
  for (let i = 0; i < resamples; i++) { let s = 0; for (let j = 0; j < d.length; j++) s += d[Math.floor(next() * d.length)]; boots.push(s / d.length) }
  boots.sort((x, y) => x - y)
  const lo = r3(boots[Math.floor(0.025 * (resamples - 1))]), hi = r3(boots[Math.ceil(0.975 * (resamples - 1))])
  // for a lower-is-better metric (unknown_rate) a negative difference favours B
  const sign = opts.lowerIsBetter ?? metric === 'unknown_rate' ? -1 : 1
  const verdict = sign * lo > 0 && sign * hi > 0 ? 'b_better' : sign * lo < 0 && sign * hi < 0 ? 'a_better' : 'inconclusive'
  return { ...base, mean_difference: r3(mean(d)), ci95: [lo, hi], verdict }
}
