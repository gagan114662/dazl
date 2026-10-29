// The eval suite: every case under a directory, replayed and scored, then compared with the committed baseline of known
// non-pass verdicts. Used by scripts/evals.mts (the CLI / CI gate) and test/evals.test.ts.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCase } from '../../lib/evals/case.ts'
import { replayCase } from './eval-replay.ts'
import type { ReplayResult } from '../../lib/evals/result.ts'
import { scoreCase, EVAL_CONTRACT, type CaseScore, type Verdict } from '../../lib/evals/evaluators.ts'
import { totals } from '../../lib/evals/trace.ts'

export interface Baseline { contract: string; cases: Record<string, { status: string; non_pass: string[]; why?: string }> }
export interface SuiteRow { case: string; score: CaseScore; totals: ReturnType<typeof totals>; result: ReplayResult; nonPass: string[] }
export interface BaselineDiff { case: string; regressions: string[]; fixed: string[]; missingBaseline: boolean }

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
  return b
}

// Exact comparison: anything not in the baseline is a regression, anything in it that no longer happens is fixed (and
// must be removed from the baseline). A case with no baseline entry must pass outright.
export function compareBaseline(rows: SuiteRow[], b: Baseline): BaselineDiff[] {
  return rows.map(r => {
    const known = new Set(b.cases[r.case]?.non_pass ?? [])
    return { case: r.case, regressions: r.nonPass.filter(k => !known.has(k)), fixed: [...known].filter(k => !r.nonPass.includes(k)), missingBaseline: !b.cases[r.case] && r.nonPass.length > 0 }
  })
}
