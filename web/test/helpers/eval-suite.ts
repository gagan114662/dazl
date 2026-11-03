// The eval suite: every case under a directory, replayed and scored, then compared with the committed baseline of known
// non-pass verdicts. Used by scripts/evals.mts (the CLI / CI gate) and test/evals.test.ts.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCase } from '../../lib/evals/case.ts'
import { replayCase } from './eval-replay.ts'
import type { ReplayResult } from '../../lib/evals/result.ts'
import { scoreCase, EVAL_CONTRACT, type CaseScore, type Verdict } from '../../lib/evals/evaluators.ts'
import { totals } from '../../lib/evals/trace.ts'

// The baseline is the REGISTRY of the suite: every case, passing ones too (non_pass: []), and a floor on how many must run.
// Deleting a case therefore needs its entry removed and min_cases lowered, both visible in review; neither leaves the gate green
// by itself.
export interface Baseline { contract: string; min_cases: number; cases: Record<string, { status: string; non_pass: string[]; why?: string }> }
export interface SuiteRow { case: string; score: CaseScore; totals: ReturnType<typeof totals>; result: ReplayResult; nonPass: string[] }
export interface BaselineDiff { case: string; regressions: string[]; fixed: string[] }

export const verdictKey = (v: Verdict) => `${v.evaluator}|${v.subject}|${v.status}`

export async function runSuite(casesDir: string, opts: { commit?: string | null; agentLabel?: string } = {}): Promise<SuiteRow[]> {
  const rows: SuiteRow[] = []
  for (const f of readdirSync(casesDir).filter(f => f.endsWith('.case.json')).sort()) {
    const { kase, world } = loadCase(join(casesDir, f))
    const result = await replayCase(kase, world, opts)
    const score = scoreCase({ kase, world, result })
    rows.push({ case: kase.id, score, totals: totals(result.trace), result, nonPass: score.verdicts.filter(v => v.status !== 'pass').map(verdictKey).sort() })
  }
  return rows
}

export function loadBaseline(file: string): Baseline {
  const b = JSON.parse(readFileSync(file, 'utf8')) as Baseline
  if (b.contract !== EVAL_CONTRACT) throw new Error(`baseline contract ${b.contract} is not ${EVAL_CONTRACT}`)
  if (!Number.isInteger(b.min_cases) || b.min_cases < 1) throw new Error('baseline min_cases must be a whole number of at least 1')
  if (!b.cases || typeof b.cases !== 'object') throw new Error('baseline cases must be an object')
  return b
}

// Exact per-case comparison: anything not in the baseline is a regression, anything in it that no longer happens is fixed (and
// must be removed from the baseline); a registered case that did not run is a regression. gate() below adds the rest of the
// case-set checks (unregistered, duplicate, min_cases, empty).
export const CASE_DID_NOT_RUN = 'case_did_not_run'
export function compareBaseline(rows: SuiteRow[], b: Baseline): BaselineDiff[] {
  const ran = rows.map(r => {
    const known = new Set(b.cases[r.case]?.non_pass ?? [])
    return { case: r.case, regressions: r.nonPass.filter(k => !known.has(k)), fixed: [...known].filter(k => !r.nonPass.includes(k)) }
  })
  // A registered case that did not run is a diff too, so no caller of this comparison can read "no change" for a missing case.
  const ids = new Set(rows.map(r => r.case))
  return [...ran, ...Object.keys(b.cases).filter(id => !ids.has(id)).sort().map(id => ({ case: id, regressions: [CASE_DID_NOT_RUN], fixed: [] }))]
}

export interface GateResult {
  ok: boolean
  diffs: BaselineDiff[]
  missing: string[]        // registered in the baseline, but no case ran (file deleted, renamed, or no longer *.case.json)
  unregistered: string[]   // ran, but not in the baseline: register it (non_pass: [] when it passes)
  duplicates: string[]     // two case files with the same id
  ran: number; minCases: number
}

// The whole gate: verdict changes per case AND the case set itself. Red unless every registered case ran, every case that ran is
// registered, ids are unique, at least min_cases ran, and no verdict differs from the baseline.
export function gate(rows: SuiteRow[], b: Baseline): GateResult {
  const ids = rows.map(r => r.case)
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
  const missing = Object.keys(b.cases).filter(id => !ids.includes(id)).sort()
  const unregistered = [...new Set(ids.filter(id => !(id in b.cases)))].sort()
  const diffs = compareBaseline(rows, b)
  const changed = diffs.some(d => d.regressions.length || d.fixed.length)
  const ok = rows.length > 0 && rows.length >= b.min_cases && !missing.length && !unregistered.length && !duplicates.length && !changed
  return { ok, diffs, missing, unregistered, duplicates, ran: rows.length, minCases: b.min_cases }
}
