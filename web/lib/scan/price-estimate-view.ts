import { completionCost, priceOf } from '../llm/spend-pricing.ts'

export interface Range { min: number; max: number }
export interface EstimateRow {
  id: string; label: string; provider: string
  kind: 'model' | 'search' | 'fetch' | 'enrichment' | 'free' | 'unbounded'
  unit: string                       // what one unit is: "1M input tokens", "search", "credit"
  unit_usd: string                   // shown as written ("$3.00 in / $15.00 out per 1M tokens", "free allowance", "not priced")
  units: Range                       // expected units for this run
  usd: Range | null                  // null: this row cannot be priced (counted in `unpriced`)
  capped: boolean                    // counted against max_usd by the spend guard
  note: string
}
export interface Verdict { ok: boolean; reason: 'over_budget' | 'budget_unknown' | 'accounting_unsettled' | 'model_unpriced' | 'trial_unavailable' | null; message: string; change: string[]; warning: string | null; trial_refusal?: string | null }
export interface RunEstimate {
  rows: EstimateRow[]; total: Range; unpriced: string[]; assumptions: string[]
  payer: 'you' | 'trial'; cap: { max_usd: number | null; reserved_usd: number; remaining_usd: number | null; binding: 'run' | 'daily' | 'monthly' | null; run_max_usd?: number | null; capped_total: Range; month_cap_usd: number | null; month_reserved_usd: number; unknown: boolean }
  verdict: Verdict; ack: string
  // A trial account's remaining dollar allowance (lib/billing/trial-budget.ts trialAllowanceLeft). Display only: deliberately NOT part of `ack`, so the
  // confirmation of an estimate never goes stale because a read changed it, and POST /api/scan (which does not read it) never answers estimate_changed.
  trial_allowance?: { left_usd: number; total_usd: number } | null
  // #1319: a free-trial scan's own per-scan ceiling (trialReserveUsd, e.g. $0.30 from #680). Display only, NOT part of `ack` (the ack already covers it as cap.trial).
  trial_scan_cap_usd?: number | null
  trial_exempt?: boolean
  // #1157: this account's web search allowance left today (lib/search/tinyfish.ts tenantAllowanceLeft). Display only, like
  // trial_allowance: not part of `ack`, never a block (the run's own gate refuses at the cap); `low` shows a warning before confirm.
  search_allowance?: { left: number; daily: number; low: boolean } | null
}
export const formatEstimateUsd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`

// #1319: what a CUSTOMER sees in the "What this run will use" box. The estimate itself (rows, unit_usd with the model id,
// the never-run research fallback, env var hints) stays as-is for the ack, the saved job estimate, logs and admin; this
// view only rewrites the copy: no env var names, no model ids, no internal never-run rows, and a trial's total clamped to
// the trial's per-scan cap (the run stops there), with the line saying so.
export interface CustomerRow { id: string; label: string; provider: string; unit_usd: string; note: string; usd: Range | null; capped: boolean }
export interface CustomerView { rows: CustomerRow[]; total: Range; /** the cap line's model range (capLine), clamped like total */ capped_total: Range; trial_cap_line: string | null; assumptions: string[] }
const ENV_NAME = /\bDAZL_[A-Z0-9_]+\b/
export function customerCopy(text: string): string {
  // The model id the row names: "... per 1M tokens (claude-sonnet-4-5)" and "o3-mystery: no listed price"
  return text.replace(/(per 1M tokens) \(.*\)$/, '$1').replace(/^.*: no listed price$/, 'no listed price')
}
export function customerView(est: Pick<RunEstimate, 'rows' | 'total' | 'assumptions' | 'payer' | 'trial_exempt'> & { cap?: Pick<RunEstimate['cap'], 'capped_total'>; trial_scan_cap_usd?: number | null }): CustomerView {
  const cap = trialScanCap(est)
  const rows: CustomerRow[] = est.rows.filter(r => r.id !== 'fallback_research').map(r => {
    const included = ENV_NAME.test(r.unit_usd) || /^free allowance/.test(r.unit_usd)
    return {
      id: r.id, label: r.label, usd: r.usd && clampToCap(r.usd, cap), capped: r.capped,
      provider: r.kind === 'model' ? 'AI research' : r.kind === 'search' || r.kind === 'fetch' ? 'Web search' : r.provider,
      unit_usd: included ? 'included' : r.kind === 'model' ? customerCopy(r.unit_usd) : r.unit_usd.replace(ENV_NAME, 'operator setting'),
      note: r.note.replace(ENV_NAME, 'operator setting'),
    }
  })
  const total = clampToCap(est.total, cap)
  const assumptions = est.assumptions
    .filter(a => !/research fallback/i.test(a))
    .map(a => a.startsWith('Model: ') && a.includes('. Tokens per call') ? `AI research: t${a.slice(a.indexOf('. Tokens per call') + 3)}` : a)
    .filter(a => !ENV_NAME.test(a))
  return { rows, total, capped_total: clampToCap(est.cap?.capped_total ?? est.total, cap), trial_cap_line: est.trial_exempt ? null : trialCapLine(cap), assumptions }
}
// #1319: a free-trial scan's per-scan cap, when the estimate carries a usable one (own-key runs never have one). Shared by
// the cost box before the run and the run page after it, so neither shows a dollar amount above the cap.
export function trialScanCap(est: { payer?: string; trial_scan_cap_usd?: number | null }): number | null {
  const c = est.trial_scan_cap_usd
  return est.payer === 'trial' && typeof c === 'number' && Number.isFinite(c) && c > 0 ? c : null
}
export const clampToCap = (r: Range, cap: number | null): Range => cap === null ? r : { min: Math.min(r.min, cap), max: Math.min(r.max, cap) }
export const trialCapLine = (cap: number | null): string | null => cap === null ? null : `Free trial scans stop at ${formatEstimateUsd(cap)}.`

// After the run: what was actually recorded next to the estimate. Only recorded facts: the tokens the provider reported
// (priced at the listed price) and the searches the run attempted. Unknown stays null; it is never shown as zero.
export interface ActualInput { inputTokens: number | null; outputTokens: number | null; tokensComplete: boolean; model?: string | null; searches: number | null; reservedUsd: number | null; requests?: number | null; requestsWithTokens?: number | null; /** model calls a spending limit refused before sending (scan_spend_calls) */ refusedBeforeSending?: number | null; capReservedUsd?: number | null; /** #1517: the job's one recorded cost (job-cost.ts), read once the run ended */ finalUsd?: number | null; /** paid calls in finalUsd that never reported a cost (counted at their reservation); null = unread */ finalHeldSteps?: number | null; servedModels?: string[] | null; cacheWriteTokens?: number | null; cacheReadTokens?: number | null }
export interface ActualVsEstimate { final_usd: number | null; model_usd: number | null; model_usd_complete: boolean; searches: number | null; reserved_usd: number | null; cap_reserved_usd: number | null; estimate: Range; within: 'under' | 'within' | 'over' | 'unknown'; summary: string }
// trialCapUsd (#1319): a free-trial run's per-scan cap; the model estimate it is compared against never reads above it.
export function compareActual(est: Pick<RunEstimate, 'total' | 'rows'>, a: ActualInput, trialCapUsd: number | null = null): ActualVsEstimate {
  // The canonical pricing truth is the settlement path's own (spend-guard.ts): priceOf normalizes dated served ids
  // (claude-sonnet-4-5-20250929 -> claude-sonnet-4-5) and completionCost prices cache tokens at the shared factors. A
  // bare PRICES_USD_PER_M lookup here called a dated, KNOWN model "unlisted" and reported real spend as unknown.
  const served = a.servedModels && a.servedModels.length ? a.servedModels : a.model ? [a.model] : []
  const priceKeys = new Set(served.map(m => { const p = priceOf(m); return p ? `${p.in}/${p.out}` : null }))
  const mixed = priceKeys.size > 1
  const cost = !mixed && a.inputTokens !== null && a.outputTokens !== null
    ? completionCost(a.model ?? served[0] ?? null, { input_tokens: a.inputTokens, output_tokens: a.outputTokens, cache_creation_input_tokens: a.cacheWriteTokens ?? 0, cache_read_input_tokens: a.cacheReadTokens ?? 0 })
    : null
  // #1517 (run af02437c): calls of more than one model cannot be priced from the summed tokens (never at one model's rate), but each call
  // settled its own cost in the per-call ledger. That sum is the actual model cost when the ledger is fully settled (no step held at its reservation).
  const settled: number | null = null   // Qodo #1554: the job's final cost includes search/render/enrichment, so it is never the model cost; it leads the line below as the run's final cost
  const usd = settled ?? (cost && 'usd' in cost ? cost.usd : null)
  // Cache token usage is NOT stored per scan (model-usage.ts): absent cache fields are UNKNOWN, not zero. Without them
  // the computed USD is the recorded-token component only - an at-least amount, never "complete" and never placed
  // inside/against the estimate range. Explicit zeros are a real record; provided values price at the shared factors.
  const cacheRecorded = a.cacheWriteTokens != null && a.cacheReadTokens != null
  const complete = settled !== null || (usd !== null && a.tokensComplete && cacheRecorded)
  const modelEst = clampToCap(est.rows.filter(r => r.kind === 'model').reduce((x, r) => ({ min: x.min + (r.usd?.min ?? 0), max: x.max + (r.usd?.max ?? 0) }), { min: 0, max: 0 }), trialCapUsd)
  const within = !complete || usd === null ? 'unknown' : usd < modelEst.min ? 'under' : usd > modelEst.max ? 'over' : 'within'
  const reqs = a.requests ?? null, reqsWithTokens = a.requestsWithTokens ?? null
  // Recorded usage is never "not recorded": when calls were made and only the USD could not be settled, the summary says
  // what IS known (call count, reported tokens, why no USD) and that the actual cost is unknown - never $0 or free.
  let summary: string
  if (settled !== null) {
    const range = within === 'unknown' ? '' : ` (${within === 'within' ? 'inside the range' : within === 'under' ? 'below the range' : 'above the range'})`
    summary = `Actual model cost ${formatEstimateUsd(settled)}, the sum of each call's settled cost (${served.join(', ')}), against the model-request estimate of ${formatEstimateUsd(modelEst.min)}-${formatEstimateUsd(modelEst.max)}${range}. Not an invoice.`
  }
  else if (usd !== null) {
    const range = within === 'unknown' ? '' : ` (${within === 'within' ? 'inside the range' : within === 'under' ? 'below the range' : 'above the range'})`
    const cacheNote = cacheRecorded ? '' : '; cache token usage was not recorded, so this is the recorded-token component, not the full cost'
    summary = `Actual model cost ${complete ? '' : 'at least '}${formatEstimateUsd(usd)} from the tokens the provider reported${cacheNote}, against the model-request estimate of ${formatEstimateUsd(modelEst.min)}-${formatEstimateUsd(modelEst.max)}${range}. Not an invoice.`
  }
  else if (mixed && reqs !== null && reqs > 0 && a.inputTokens !== null && a.outputTokens !== null) summary = `${reqs} model call${reqs === 1 ? '' : 's'} recorded (${a.inputTokens} input / ${a.outputTokens} output tokens) across more than one served model (${served.join(', ')}); the stored sums cannot be priced as one total - the per-call settled costs are in the spend ledger. The actual cost here is unknown, not $0. The model-request estimate was ${formatEstimateUsd(modelEst.min)}-${formatEstimateUsd(modelEst.max)}.`
  else if (reqs !== null && reqs > 0 && a.inputTokens !== null && a.outputTokens !== null) summary = `${reqs} model call${reqs === 1 ? '' : 's'} recorded (${reqsWithTokens !== null && reqsWithTokens < reqs ? `tokens reported for ${reqsWithTokens}: ` : ''}${a.inputTokens} input / ${a.outputTokens} output tokens), but no USD cost could be settled (${a.model || served.length ? 'the served model has no listed price' : 'no model id was recorded'}) - the actual cost is unknown, not $0. The model-request estimate was ${formatEstimateUsd(modelEst.min)}-${formatEstimateUsd(modelEst.max)}.`
  else if (reqs !== null && reqs > 0) summary = `${reqs} model call${reqs === 1 ? '' : 's'} recorded, but the provider reported no token usage for them, so the actual cost is unknown - not $0. The model-request estimate was ${formatEstimateUsd(modelEst.min)}-${formatEstimateUsd(modelEst.max)}.`
  // #1168: nothing was sent, so nothing was charged: say so, never "unknown" and never "recorded"
  else if ((a.refusedBeforeSending ?? 0) > 0) summary = `No model call was made: ${a.refusedBeforeSending} ${a.refusedBeforeSending === 1 ? 'was' : 'were'} refused by a spending limit before sending, so the model cost is $0. The model-request estimate was ${formatEstimateUsd(modelEst.min)}-${formatEstimateUsd(modelEst.max)}.`
  else summary = `Actual model cost was not recorded (model-request estimate ${formatEstimateUsd(modelEst.min)}-${formatEstimateUsd(modelEst.max)}).`
  // A reservation is a hold from what the code sent, named as itself - never folded into the cost and never an invoice.
  const capRes = a.capReservedUsd ?? null
  // #1517: the run's final cost is the job's one recorded cost (the per-call ledger: each paid call at its reported cost, a
  // call without one at the amount reserved for it) - the same number the job record carries. It leads the line; the
  // token-priced model figure above stays as the breakdown.
  // A paid call that never reported a cost is in it at the amount reserved for it (counted as billed, #1157); the line names
  // how many. When that count cannot be read, no final cost is stated (the reservation sentence below stands instead).
  const final = a.finalUsd ?? null, held = a.finalHeldSteps ?? null
  const heldNote = held !== null && held > 0 ? `, including ${held === 1 ? 'one paid step' : `${held} paid steps`} counted as billed at the amount reserved for ${held === 1 ? 'it' : 'them'}` : ''
  // PM 2026-11-22: a mixed-model run whose ledger is fully settled shows the billed amount and nothing more
  // #1571: a run with nothing recorded per model call (the discovery lane settles one amount for the whole run) has only its final cost
  // to state. The token breakdown sentence against a $0.00-$0.00 estimate said nothing and read as a fault.
  const noBreakdown = (reqs === null || reqs === 0) && usd === null && (a.refusedBeforeSending ?? 0) === 0 && modelEst.max === 0
  if (final !== null && held === 0 && (mixed || noBreakdown)) summary = `Final cost ${formatEstimateUsd(final)}.`
  else if (final !== null && held !== null) summary = `Final cost ${formatEstimateUsd(final)}${heldNote}. ${summary}`
  else if (capRes !== null && capRes > 0) summary += ` Reserved under this run's spend cap: ${formatEstimateUsd(capRes)} (a reservation, not a settled charge).`
  return { final_usd: final !== null && held !== null ? final : null, model_usd: usd, model_usd_complete: complete, searches: a.searches, reserved_usd: a.reservedUsd, cap_reserved_usd: capRes, estimate: clampToCap(est.total, trialCapUsd), within, summary }
}

// The one line under the menu that states the limits and what is left. Unreadable budget is "remaining unknown" (never $0.00); the daily and monthly limits are labelled,
// each with its own reserved amount, and the amount left says which of them binds.
const cur = (n: number) => `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`
export function capLine(cap: RunEstimate['cap'], capped: Range): string | null {
  if (cap.max_usd == null && cap.month_cap_usd == null && cap.run_max_usd == null) return null
  const parts: string[] = []
  if (cap.run_max_usd != null) parts.push(`This run's limit: ${cur(cap.run_max_usd)}`)
  if (cap.max_usd != null) parts.push(`Daily limit: ${cur(cap.max_usd)}${cap.unknown ? '' : cap.reserved_usd > 0 ? ` (${cur(cap.reserved_usd)} already reserved today)` : ''}`)
  if (cap.month_cap_usd != null) parts.push(`Monthly limit: ${cur(cap.month_cap_usd)}${cap.unknown ? '' : cap.month_reserved_usd > 0 ? ` (${cur(cap.month_reserved_usd)} already reserved this month)` : ''}`)
  const left = cap.unknown || cap.remaining_usd === null ? 'Remaining: unknown (your shared spend could not be read)' : `${cur(cap.remaining_usd)} left${cap.binding ? ` (${cap.binding === 'run' ? "this run's" : cap.binding} limit binds)` : ''}`
  return `${parts.join('; ')}; ${left}. Model requests expected: ${capped.min === capped.max ? cur(capped.min) : `${cur(capped.min)} - ${cur(capped.max)}`}.`
}

// #1095: who pays, as the cost panel's first line. A run the free trial refused is paid by no one, so it claims no payer
// (the refusal notice below it says why and what to do); otherwise the shared trial or the account's own keys.
export function estimatePayerLine(est: Pick<RunEstimate, 'payer' | 'verdict'>): string | null {
  if (!est.verdict.ok && est.verdict.reason === 'trial_unavailable') return null
  return est.payer === 'trial' ? 'Paid by the shared free trial, not billed to you.' : 'Usage depends on your workspace plan.'
}

// #1157: shown BEFORE confirm when this account has little web search left today, so a run the allowance would stop is not started blind
export const searchAllowanceLine = (a: { left: number; daily: number }) => a.left === 0
  ? `Your web search allowance for today is used up (${a.daily} a day). This run would search only the free news source and is likely to find nothing. It resets at 00:00 UTC.`
  : `Only ${a.left} of your ${a.daily} web searches and page reads are left today, about one run. This run may stop early when they run out; the allowance resets at 00:00 UTC.`
