// Typed partial-result provenance. Only a numeric reservation refusal belongs here;
// an unavailable ledger, unpriced model or provider response is not a budget limit.
export const SCORE_BUDGET_REASONS = ['over_limit', 'over_cap', 'owner_pool_limit', 'trial_budget_reached'] as const
export type ScoreBudgetReason = typeof SCORE_BUDGET_REASONS[number]
export type ScoreBudgetStage = 'icp_grading' | 'buyer_fit'
export interface ScoreBudgetHold { stage: ScoreBudgetStage; reason: ScoreBudgetReason; requested_max_usd: number | null }

export function scoreBudgetReason(v: unknown): ScoreBudgetReason | null {
  return SCORE_BUDGET_REASONS.find(r => r === v) ?? null
}

export function readScoreBudgetHolds(report: unknown, attempt: number): ScoreBudgetHold[] {
  if (!report || typeof report !== 'object') return []
  const r = report as { attempt?: number; scoring_budget_holds?: unknown }
  if (r.attempt !== attempt || !Array.isArray(r.scoring_budget_holds)) return []
  const out: ScoreBudgetHold[] = []
  for (const row of r.scoring_budget_holds.slice(0, 2)) {
    if (!row || typeof row !== 'object') continue
    const { stage, reason, requested_max_usd: usd } = row as Partial<ScoreBudgetHold>
    if ((stage !== 'icp_grading' && stage !== 'buyer_fit') || !reason || !scoreBudgetReason(reason) || out.some(x => x.stage === stage)) continue
    out.push({ stage, reason, requested_max_usd: typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? usd : null })
  }
  return out
}

export const ICP_BUDGET_WHY = 'Not graded: the spending limit prevented ICP fit grading.'
export const BUYER_BUDGET_WHY = 'Buyer fit unconfirmed: the spending limit prevented the company-site fit check.'

// A capacity hold is kept at a non-actionable numeric fit for the existing
// filtering/gates; do not display that placeholder as a model grade.
export function heldFitLabel(fit: number | null | undefined, intent: number | null | undefined, why: string | null | undefined): string | null {
  if (fit === 0 && intent == null && (why?.startsWith(ICP_BUDGET_WHY) || why?.startsWith(`Hiring signal without pain in the quoted evidence. ${ICP_BUDGET_WHY}`))) return 'Not graded (spending limit)'
  if (typeof fit === 'number' && fit <= 3 && why?.startsWith(BUYER_BUDGET_WHY)) return 'Buyer fit not checked (spending limit)'
  return null
}

export function scoreBudgetCopy(holds: readonly ScoreBudgetHold[]): string | null {
  if (holds.length === 0) return null
  const money = (usd: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(usd)
  const parts = holds.map(h => {
    const step = h.stage === 'icp_grading' ? 'ICP fit grading' : 'The company-site buyer-fit check'
    const limit = h.reason === 'owner_pool_limit' ? 'the shared account spending limit'
      : h.reason === 'trial_budget_reached' ? 'the trial spending limit'
        : h.reason === 'over_limit' ? 'this run’s spending limit' : 'the applicable per-scan spending cap'
    const request = h.requested_max_usd === null ? '' : ` The requested run limit was ${money(h.requested_max_usd)} USD.`
    return `${step} did not run because it would exceed ${limit}.${request}${h.reason === 'over_limit' ? ' A higher run limit may let it run if your account and service limits allow it.' : ''}`
  })
  return `Partial results. ${parts.join(' ')} Leads already found were kept. Missing fit checks are not low-fit grades.`
}

export interface PaidLimitRefusal { kind: string; reason: ScoreBudgetReason; count: number }

// Keep the cost line for recorded historical/non-grading paid steps without using
// it as evidence for any lead's grading state. The ledger does not name model stages.
export function paidLimitRefusalCopy(rows: readonly PaidLimitRefusal[] | null | undefined): string {
  const kinds: Record<string, string> = {
    'llm.anthropic': 'AI model request', 'llm.openai': 'AI model request',
    'tinyfish.search': 'web search', 'tinyfish.fetch': 'page fetch',
    'apollo.org': 'enrichment request', 'apollo.people': 'enrichment request', 'pdl.people': 'enrichment request',
    render: 'page render',
  }
  const limits: Record<ScoreBudgetReason, string> = {
    over_limit: 'this run’s spending limit', over_cap: 'the applicable per-scan spending cap',
    owner_pool_limit: 'the shared account spending limit', trial_budget_reached: 'the trial spending limit',
  }
  const grouped = new Map<string, number>()
  for (const row of rows ?? []) {
    const label = `${Object.hasOwn(kinds, row.kind) ? kinds[row.kind] : 'paid request'}|${limits[row.reason]}`
    grouped.set(label, (grouped.get(label) ?? 0) + row.count)
  }
  if (!grouped.size) return ''
  const items = [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => {
    const [kind, limit] = key.split('|')
    const label = count === 1 ? kind : kind + (/ch$/.test(kind) ? 'es' : 's')
    return `${count} ${label} refused by ${limit}`
  })
  return ` Recorded paid-step refusals: ${items.join('; ')}.`
}
