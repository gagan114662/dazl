// The estimate for a scan REQUEST body: the same validation POST /api/scan applies to the budget and mode, the same payer
// decision (own key vs shared trial), and the same caps, so the estimate shown and the run that follows cannot disagree.
// Read-only: nothing is queued, counted or reserved.
import { cleanText } from '../validate.ts'
import { MAX_QUERY, normalizeIcp } from './icp.ts'
import { normalizeScanBudget } from './run-budget.ts'
import { estimateRun, type RunEstimate } from './price-estimate.ts'
import { ownerMaxUsd } from './runner.ts'
import { poolReservedUsd } from '../llm/spend-guard.ts'
import { salesHiringRequired } from './sales-hiring-required.ts'

export type EstimateResult = { ok: true; estimate: RunEstimate } | { ok: false; status: number; error: string; detail?: string }
export function estimateForBody(body: unknown, ctx: { userId: string; hasOwnKey: boolean; enrichmentVendors: string[] }): EstimateResult {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const first5 = b.mode === 'first5'
  if (b.mode !== undefined && b.mode !== 'first5') return { ok: false, status: 400, error: 'unknown_mode' }
  const supplied = 'budget' in b
  if (first5 && supplied) return { ok: false, status: 400, error: 'invalid_budget', detail: 'mode first5 takes no budget' }
  const nb = first5 ? normalizeScanBudget({ first5: true, paid_fallback: false, credit_enrichment: false }, true) : normalizeScanBudget(supplied ? b.budget : undefined, supplied)
  if (!nb.ok) return { ok: false, status: 400, error: 'invalid_budget', detail: nb.error }
  const query = cleanText(b.query, MAX_QUERY)
  const icp = b.icp === undefined || b.icp === null ? null : normalizeIcp(b.icp)
  const estimate = estimateRun({
    budget: nb.budget, payer: ctx.hasOwnKey ? 'you' : 'trial', enrichmentVendors: ctx.enrichmentVendors,
    hiringRequest: salesHiringRequired(query, icp ? JSON.stringify(icp) : null),
    reservedUsd: poolReservedUsd(ctx.userId), ownerCapUsd: ownerMaxUsd(ctx.userId),
  })
  return { ok: true, estimate }
}
