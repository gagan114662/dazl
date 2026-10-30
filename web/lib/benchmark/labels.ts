// Independent labels for benchmark runs (issue #372, part 2; docs/BENCHMARK.md "Independent evaluation"). Pure: no
// network, no model, no store.
//
// The scorecard (scorecard.ts) only lets a run meet a threshold when its evaluator is independent of the system that
// produced the results. This module is how a run gets such an evaluator:
//   1. labelSheet(run, set): a BLIND sheet of every returned result, one row per (task, company), without the system's
//      name, its rank or its own verdicts, in a seeded shuffled order, so the labeller judges the evidence alone.
//   2. A labeller (a person, or a separate evaluator that never saw the system's verdicts) fills a LabelSet: one verdict
//      per field of the shared contract for each row, and declares which systems it is independent of.
//   3. applyLabels(run, labels): the run's verdicts are replaced by the labels. A result with no label gets 'unknown' on
//      every field (never a pass), and the coverage is reported. The evaluator is independent only when the label set
//      says it is independent of this run's system.
//   4. agreement(a, b): two labellers on the same rows, per field: how many rows both labelled, observed agreement and
//      Cohen's kappa. Low agreement means the contract or the evidence is ambiguous, not that either labeller is right.
// Labels are matched by task and normalised company key, so a result's rank or order does not matter.
import { FIELDS, type BenchmarkRun, type Field, type TaskSet, type Verdict } from './scorecard.ts'

export const VERDICTS: Verdict[] = ['pass', 'fail', 'unknown', 'contradicted']
export interface Label { task_id: string; entity_key: string; verdicts: Partial<Record<Field, Verdict>>; evidence?: string[]; note?: string }
export interface LabelSet {
  format: 'dazl-benchmark-labels'; version: 1
  task_set_version: string
  evaluator: { name: string; version: string; independent_of: string[] }   // systems whose results it judges blind
  labelled_at: string
  labels: Label[]
}
export interface SheetRow { row_id: string; task_id: string; query: string; entity_key: string; evidence: string }

export const normKey = (k: string) => k.trim().toLowerCase().replace(/\s+/g, ' ')
const keyOf = (task: string, entity: string) => `${task}\u0000${normKey(entity)}`

// Deterministic PRNG (mulberry32): the same seed gives the same order, so a sheet can be regenerated for audit.
export function rng(seed: number) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

export function labelSheet(run: BenchmarkRun, set: TaskSet, seed = 1): SheetRow[] {
  const query = new Map(set.tasks.map(t => [t.id, t.query]))
  const seen = new Set<string>()
  const rows: Omit<SheetRow, 'row_id'>[] = []
  for (const t of run.tasks) for (const r of t.results) {
    const k = keyOf(t.task_id, r.entity_key)
    if (seen.has(k)) continue                       // the same company twice in one task is one row to label
    seen.add(k)
    rows.push({ task_id: t.task_id, query: query.get(t.task_id) ?? '', entity_key: r.entity_key.trim(), evidence: (r.evidence ?? []).join(' ') })
  }
  const next = rng(seed)
  for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]] }
  return rows.map((r, i) => ({ row_id: `r${String(i + 1).padStart(4, '0')}`, ...r }))
}

const csvCell = (v: string) => /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
export function sheetCsv(rows: SheetRow[]): string {
  const head = ['row_id', 'task_id', 'query', 'entity_key', 'evidence', ...FIELDS]
  return [head.join(','), ...rows.map(r => [r.row_id, r.task_id, r.query, r.entity_key, r.evidence, ...FIELDS.map(() => '')].map(csvCell).join(','))].join('\n') + '\n'
}

export function validateLabels(labels: LabelSet): string[] {
  const problems: string[] = []
  if (labels.format !== 'dazl-benchmark-labels' || labels.version !== 1) problems.push('not a dazl-benchmark-labels v1 file')
  if (!labels.evaluator?.name || !Array.isArray(labels.evaluator.independent_of)) problems.push('evaluator needs a name and independent_of')
  const seen = new Set<string>()
  for (const [i, l] of (labels.labels ?? []).entries()) {
    const k = keyOf(l.task_id, l.entity_key)
    if (seen.has(k)) problems.push(`label ${i}: ${l.task_id} / ${l.entity_key} is labelled twice`)
    seen.add(k)
    for (const [f, v] of Object.entries(l.verdicts ?? {})) {
      if (!(FIELDS as readonly string[]).includes(f)) problems.push(`label ${i}: unknown field ${f}`)
      if (!VERDICTS.includes(v as Verdict)) problems.push(`label ${i}: ${f} has verdict ${v}`)
    }
  }
  return problems
}

export interface Coverage { results: number; labelled: number; unlabelled: number; fields_missing: number; labels_unused: number }
export function applyLabels(run: BenchmarkRun, labels: LabelSet): { run: BenchmarkRun; coverage: Coverage } {
  if (labels.task_set_version !== run.task_set_version) throw new Error(`labels are for task set v${labels.task_set_version}, the run is v${run.task_set_version}`)
  const problems = validateLabels(labels)
  if (problems.length) throw new Error(`invalid labels: ${problems.join('; ')}`)
  const byKey = new Map(labels.labels.map(l => [keyOf(l.task_id, l.entity_key), l]))
  const used = new Set<string>()
  let results = 0, labelled = 0, fieldsMissing = 0
  const tasks = run.tasks.map(t => ({
    ...t,
    results: t.results.map(r => {
      results++
      const k = keyOf(t.task_id, r.entity_key), l = byKey.get(k)
      if (!l) return { ...r, verdicts: Object.fromEntries(FIELDS.map(f => [f, 'unknown'])) as Record<Field, Verdict> }
      labelled++; used.add(k)
      // a field the labeller left blank is unknown, never inherited from the system's own verdict
      const verdicts = Object.fromEntries(FIELDS.map(f => { const v = l.verdicts[f]; if (!v) fieldsMissing++; return [f, v ?? 'unknown'] })) as Record<Field, Verdict>
      return { ...r, verdicts, evidence: [...(r.evidence ?? []), ...(l.evidence ?? [])] }
    }),
  }))
  const independent = labels.evaluator.independent_of.includes(run.system)
  return {
    run: { ...run, tasks, evaluator: { name: labels.evaluator.name, version: labels.evaluator.version, independent } },
    coverage: { results, labelled, unlabelled: results - labelled, fields_missing: fieldsMissing, labels_unused: [...byKey.keys()].filter(k => !used.has(k)).length },
  }
}

export interface FieldAgreement { field: Field; both_labelled: number; agreed: number; observed: number | null; kappa: number | null }
export function agreement(a: LabelSet, b: LabelSet): FieldAgreement[] {
  if (a.task_set_version !== b.task_set_version) throw new Error('label sets are for different task sets')
  const bm = new Map(b.labels.map(l => [keyOf(l.task_id, l.entity_key), l]))
  return FIELDS.map(field => {
    const pairs: [Verdict, Verdict][] = []
    for (const l of a.labels) { const o = bm.get(keyOf(l.task_id, l.entity_key)); const x = l.verdicts[field], y = o?.verdicts[field]; if (x && y) pairs.push([x, y]) }
    const n = pairs.length
    if (!n) return { field, both_labelled: 0, agreed: 0, observed: null, kappa: null }
    const agreed = pairs.filter(([x, y]) => x === y).length, po = agreed / n
    const pe = VERDICTS.reduce((s, v) => s + (pairs.filter(p => p[0] === v).length / n) * (pairs.filter(p => p[1] === v).length / n), 0)
    const round = (x: number) => Math.round(x * 1000) / 1000
    // every row the same category for both: chance agreement is 1 and kappa is undefined, not perfect
    return { field, both_labelled: n, agreed, observed: round(po), kappa: pe === 1 ? null : round((po - pe) / (1 - pe)) }
  })
}
