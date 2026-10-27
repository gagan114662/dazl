// The web form's spend-limit control builds the SAME budget object the API takes (lib/scan/run-budget.ts), through the same
// validator, so the form can never send what the API would reject and the disclosure it shows is the one the server returns.
// It is the optional PARTIAL budget described there, not a whole-scan dollar ceiling.
import { normalizeScanBudget } from './run-budget.ts'
import type { RunBudget } from './runner.ts'

export interface BudgetForm { enabled: boolean; maxUsd: string; noFallback: boolean; noEnrichment: boolean; noJudge: boolean }
export const EMPTY_BUDGET_FORM: BudgetForm = { enabled: false, maxUsd: '', noFallback: false, noEnrichment: false, noJudge: false }

export function budgetFromForm(f: BudgetForm): { budget: RunBudget | null; error: string | null } {
  if (!f.enabled) return { budget: null, error: null } // off = no budget field at all: today's behaviour
  const o: Record<string, unknown> = {}
  const txt = f.maxUsd.trim()
  if (txt !== '') {
    if (!/^\d+(?:\.\d+)?$/.test(txt)) return { budget: null, error: 'Enter the dollar limit as a plain positive number, like 0.50.' }
    o.max_usd = Number(txt)
  }
  if (f.noFallback) o.paid_fallback = false
  if (f.noEnrichment) o.credit_enrichment = false
  if (f.noJudge) o.judge = false
  if (Object.keys(o).length === 0) return { budget: null, error: 'Set a dollar limit or tick at least one option, or turn the spend limit off.' }
  const n = normalizeScanBudget(o, true)
  return n.ok ? { budget: n.budget, error: null } : { budget: null, error: n.error }
}
