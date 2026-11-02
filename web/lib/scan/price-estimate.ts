// Price estimate for one scan, shown BEFORE anything paid runs, and the actual-vs-estimate read after it. Pure: no database,
// no network, no provider call. The idea (a menu of what a run will use, each with a unit price and a projected total the
// user confirms) follows other lead agents' pre-run cost gates; the numbers here are dazl's own.
//
// What it is: a RANGE built from named assumptions (shown with the estimate), the listed model price (PRICES_USD_PER_M) and the
// per-scan caps the runner really enforces (DEFAULT_TINYFISH counts, PEOPLE_SEARCHES_MAX). What it is not: a bill, a quote or a
// ceiling. The ONLY hard dollar ceiling is the run budget's max_usd (a reservation limit on model requests), so the verdict
// uses that and nothing else: the estimate and the cap agree because the capped rows are priced exactly as the guard prices them.
import { PRICES_USD_PER_M, INPUT_MARGIN_TOKENS } from '../llm/spend-guard.ts'
import { DEFAULT_TINYFISH, PEOPLE_SEARCHES_MAX } from './run-budget.ts'
import type { RunBudget } from './runner.ts'
import { createHash } from 'node:crypto'

export const DEFAULT_MODEL = 'claude-sonnet-4-5'
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
export interface Verdict { ok: boolean; reason: 'over_budget' | 'budget_unknown' | 'accounting_unsettled' | null; message: string; change: string[]; warning: string | null }
export interface RunEstimate {
  rows: EstimateRow[]; total: Range; unpriced: string[]; assumptions: string[]
  payer: 'you' | 'trial'; cap: { max_usd: number | null; reserved_usd: number; remaining_usd: number | null; binding: 'daily' | 'monthly' | null; capped_total: Range; month_cap_usd: number | null; month_reserved_usd: number; unknown: boolean }
  verdict: Verdict; ack: string
}
export interface EstimateInput {
  budget: RunBudget | null
  payer: 'you' | 'trial'
  model?: string                     // exact model id the run will use
  enrichmentVendors?: string[]       // bring-your-own enrichment keys the account saved ('apollo', 'pdl')
  hiringRequest?: boolean            // the buyer-fit company-page check runs for hiring requests
  reservedUsd?: number               // already reserved against the same owner pool
  ownerCapUsd?: number | null        // the operator's cap for this owner (DAZL_RUN_MAX_USD_USERS); the tighter of it and budget.max_usd applies
  ownerMonthCapUsd?: number | null   // the operator's monthly cap for this owner (DAZL_OWNER_MONTH_MAX_USD_USERS); the room left is the tighter of the day's and the month's
  reservedMonthUsd?: number          // already reserved against the owner's monthly pool
  poolUnknown?: boolean              // the shared pool could not be read: the reserved amounts above are NOT known (never treated as zero)
  // An earlier paid call of this owner was never accounted (its pending-settlement marker is stale or marked failed,
  // lib/llm/spend-pool.ts): the pool refuses every reservation until an operator clears it, so the run cannot start.
  poolUnsettled?: boolean
  env?: Record<string, string | undefined>
}

// Typical and worst-case token sizes per model call, in thousands. ASSUMPTIONS, printed with every estimate.
const CALLS: { id: string; label: string; calls: Range; inK: Range; outK: Range; optional?: 'judge' | 'hiring' }[] = [
  { id: 'search_query_writing', label: 'Search query writing', calls: { min: 1, max: 1 }, inK: { min: 1.5, max: 3 }, outK: { min: 0.4, max: 1 } },
  { id: 'extraction', label: 'Candidate extraction', calls: { min: 1, max: 3 }, inK: { min: 8, max: 30 }, outK: { min: 1.5, max: 4 } },
  { id: 'scoring', label: 'Fit grading', calls: { min: 1, max: 1 }, inK: { min: 4, max: 12 }, outK: { min: 1, max: 3 } },
  { id: 'buyer_fit', label: 'Hiring check on company pages', calls: { min: 0, max: 1 }, inK: { min: 2, max: 6 }, outK: { min: 0.5, max: 1 }, optional: 'hiring' },
  { id: 'judge', label: 'Verification judge', calls: { min: 0, max: 1 }, inK: { min: 4, max: 10 }, outK: { min: 0.5, max: 1.5 }, optional: 'judge' },
]
const money = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`
const num = (v: string | undefined): number | null => { const n = Number(v); return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null }
const modelCost = (model: string, calls: number, inK: number, outK: number): number | null => {
  const p = PRICES_USD_PER_M[model]
  // Same formula the spend guard reserves: (input tokens + fixed margin) x input price + output tokens x output price.
  return p ? calls * ((inK * 1000 + INPUT_MARGIN_TOKENS) * p.in + outK * 1000 * p.out) / 1e6 : null
}

export function estimateRun(i: EstimateInput): RunEstimate {
  const env = i.env ?? process.env, b = i.budget, model = i.model ?? DEFAULT_MODEL
  const limit = Math.min(typeof b?.max_usd === 'number' ? b.max_usd : Infinity, i.ownerCapUsd ?? Infinity)
  const monthCap = typeof i.ownerMonthCapUsd === 'number' && i.ownerMonthCapUsd > 0 ? i.ownerMonthCapUsd : null
  const capped = Number.isFinite(limit) || monthCap !== null
  const unknown = i.poolUnknown === true
  const rows: EstimateRow[] = []
  const p = PRICES_USD_PER_M[model]
  const modelUnit = p ? `$${p.in.toFixed(2)} in / $${p.out.toFixed(2)} out per 1M tokens (${model})` : `${model}: no listed price`
  for (const c of CALLS) {
    const off = (c.optional === 'judge' && b?.judge === false) || (c.optional === 'hiring' && !i.hiringRequest)
    const calls = off ? { min: 0, max: 0 } : c.calls
    const lo = modelCost(model, calls.min, c.inK.min, c.outK.min), hi = modelCost(model, calls.max, c.inK.max, c.outK.max)
    rows.push({ id: c.id, label: c.label, provider: 'AI model', kind: 'model', unit: '1M tokens', unit_usd: modelUnit, units: calls, usd: lo === null || hi === null ? null : { min: lo, max: hi }, capped, note: off ? (c.optional === 'judge' ? 'Off: you skipped the judge' : 'Not a hiring request') : `${calls.min === calls.max ? calls.max : `${calls.min}-${calls.max}`} call(s), ${c.inK.min}-${c.inK.max}k tokens in, ${c.outK.min}-${c.outK.max}k out each` })
  }
  // #379: the fallback's search-result tokens cannot be bounded, so it now never runs - refused on every run,
  // with or without a cap, exactly like a guarded provider already refused it.
  rows.push({ id: 'fallback_research', label: 'Web-search research fallback', provider: 'AI model web search', kind: 'unbounded', unit: 'research call', unit_usd: 'not priced: search-result tokens are not bounded', units: { min: 0, max: 0 }, usd: { min: 0, max: 0 }, capped: false,
    note: 'Never run: its cost cannot be bounded or estimated, so every run refuses it' })
  const tfSearch = num(env.DAZL_PRICE_TINYFISH_SEARCH_USD), tfFetch = num(env.DAZL_PRICE_TINYFISH_FETCH_USD)
  if (b?.first5) rows.push({ id: 'sources_free', label: 'Free sources only (first-scan mode)', provider: 'GDELT, job boards, SEC, site crawl', kind: 'free', unit: 'source read', unit_usd: 'free', units: { min: 0, max: 0 }, usd: { min: 0, max: 0 }, capped: false, note: 'No TinyFish search or fetch in this mode' })
  else {
    const price = (u: number | null, n: number): Range | null => (u === null ? { min: 0, max: 0 } : { min: 0, max: u * n })
    rows.push({ id: 'tinyfish_search', label: 'Web search', provider: 'TinyFish', kind: 'search', unit: 'search', unit_usd: tfSearch === null ? 'free allowance (set DAZL_PRICE_TINYFISH_SEARCH_USD if you pay per search)' : money(tfSearch), units: { min: 1, max: DEFAULT_TINYFISH.searchesPerScan + PEOPLE_SEARCHES_MAX }, usd: price(tfSearch, DEFAULT_TINYFISH.searchesPerScan + PEOPLE_SEARCHES_MAX), capped: false, note: `At most ${DEFAULT_TINYFISH.searchesPerScan} searches plus ${PEOPLE_SEARCHES_MAX} people searches per scan (a count cap, not a dollar cap)` })
    rows.push({ id: 'tinyfish_fetch', label: 'Page fetch', provider: 'TinyFish', kind: 'fetch', unit: 'page', unit_usd: tfFetch === null ? 'free allowance (set DAZL_PRICE_TINYFISH_FETCH_USD if you pay per page)' : money(tfFetch), units: { min: 1, max: DEFAULT_TINYFISH.fetchesPerScan }, usd: price(tfFetch, DEFAULT_TINYFISH.fetchesPerScan), capped: false, note: `At most ${DEFAULT_TINYFISH.fetchesPerScan} pages per scan (a count cap, not a dollar cap)` })
  }
  const enrichOff = capped || i.payer === 'trial' || b?.credit_enrichment === false || b?.first5
  for (const v of ['apollo', 'pdl']) {
    const have = (i.enrichmentVendors ?? []).includes(v)
    if (!have) continue
    const u = num(env[`DAZL_PRICE_${v.toUpperCase()}_CREDIT_USD`]), n = enrichOff ? 0 : 8
    rows.push({ id: `${v}_credits`, label: v === 'apollo' ? 'Apollo enrichment' : 'People Data Labs enrichment', provider: v === 'apollo' ? 'Apollo' : 'People Data Labs', kind: 'enrichment', unit: 'credit', unit_usd: u === null ? 'your own plan; per-credit price not set' : money(u), units: { min: 0, max: n }, usd: enrichOff ? { min: 0, max: 0 } : u === null ? null : { min: 0, max: u * n }, capped: false, note: enrichOff ? 'Off: this run turns bring-your-own enrichment off' : 'Up to 8 companies, on your own credits' })
  }
  const unpriced = rows.filter(r => r.usd === null).map(r => r.label)
  const sum = (rs: EstimateRow[]): Range => ({ min: rs.reduce((a, r) => a + (r.usd?.min ?? 0), 0), max: rs.reduce((a, r) => a + (r.usd?.max ?? 0), 0) })
  const total = sum(rows), cappedTotal = sum(rows.filter(r => r.capped))
  const reserved = Math.max(0, i.reservedUsd ?? 0), monthReserved = Math.max(0, i.reservedMonthUsd ?? 0)
  // The room left is the TIGHTER of what the day's limit and the month's limit allow; the label names the one that binds.
  const dayLeft = Number.isFinite(limit) ? limit - reserved : Infinity, monthLeft = monthCap === null ? Infinity : monthCap - monthReserved
  const monthBinds = monthLeft < dayLeft
  const remaining = capped && !unknown ? Math.max(0, Math.min(dayLeft, monthLeft)) : null   // unknown reserved amounts -> unknown remaining, never 0
  const binding: 'daily' | 'monthly' | null = remaining === null ? null : monthBinds ? 'monthly' : 'daily'
  const shownLimit = monthBinds ? (monthCap as number) : limit, shownReserved = monthBinds ? monthReserved : reserved, limitWord = monthBinds ? 'monthly limit' : 'limit'
  const change: string[] = []
  let ok = true, reason: Verdict['reason'] = null, message = 'Within your limit.', warning: string | null = null
  if (i.poolUnsettled) {
    // The same rule the pool enforces: no reservation while an earlier call's cost is unaccounted.
    ok = false; reason = 'accounting_unsettled'
    message = 'Blocked: the cost of an earlier paid request could not be recorded, so paid requests are paused until it is reviewed. Nothing was started or reserved.'
    change.push('Ask the operator to review the unrecorded request; the run can start once it is cleared.')
  } else if (capped && unknown) {
    // The reserved amount is unknown, so the room left is unknown: refuse to confirm. It is never read as zero reserved.
    ok = false; reason = 'budget_unknown'
    message = 'Blocked: your shared spend limit could not be read right now, so what is left of it is unknown. Nothing was started or reserved. Try again in a moment.'
    change.push('Try again shortly; the estimate cannot be confirmed until your remaining limit can be read.')
  } else if (capped && remaining !== null) {
    if (cappedTotal.min > remaining) {
      ok = false; reason = 'over_budget'
      message = `Blocked: the model requests alone are expected to cost at least ${money(cappedTotal.min)} but only ${money(remaining)} of your ${money(shownLimit)} ${limitWord} is left${shownReserved > 0 ? ` (${money(shownReserved)} already reserved)` : ''}.`
      change.push(`Raise the ${monthBinds ? 'monthly ' : ''}dollar limit to at least ${money(cappedTotal.min + shownReserved)} (about ${money(cappedTotal.max + shownReserved)} covers the worst case).`)
      const judge = rows.find(r => r.id === 'judge')
      if (judge?.usd && judge.usd.min > 0) change.push(`Skip the verification judge (saves about ${money(judge.usd.min)}-${money(judge.usd.max)}).`)
      change.push('Narrow the request so fewer candidates need extracting and grading.')
    } else if (cappedTotal.max > remaining) warning = `The worst case (${money(cappedTotal.max)}) is above the ${money(remaining)} left, so the run may stop early as a budget stop. That is a stop, not zero results.`
    else message = `Within your limit: even the worst case (${money(cappedTotal.max)}) fits the ${money(remaining)} left.`
  } else message = 'No dollar limit is set, so nothing here is a ceiling. Set one to make the run stop at an amount.'
  const assumptions = [
    `Model: ${model}. Tokens per call are ranges chosen by dazl (typical to worst case), priced exactly as the spend guard prices a reservation.`,
    'Search and fetch counts are the per-scan caps the runner enforces; units used are usually lower.',
    'The web-search research fallback and any provider retries cannot be bounded and are not in the total.',
    'This is an estimate, not a quote or a bill. Only the dollar limit (when set) stops a run, and only for the model requests dazl sends.',
    ...(i.payer === 'trial' ? ['This run is paid by the shared free trial, not billed to you; the trial allows 3 scans per account.'] : []),
    ...(unpriced.length ? [`Not priced, so not in the total: ${unpriced.join(', ')}.`] : []),
  ]
  const cap = { max_usd: Number.isFinite(limit) ? limit : null, reserved_usd: reserved, remaining_usd: remaining, binding, capped_total: cappedTotal, month_cap_usd: monthCap, month_reserved_usd: monthReserved, unknown }
  const verdict = { ok, reason, message, change, warning }
  // The confirmation covers everything the person was shown and agreed to: WHO PAYS (own key vs the shared trial), every row (what it is, its units, price, whether the cap bounds it, and its
  // note: on/off), the totals, the unpriced list, and the cap with the reserved and remaining room, plus the verdict with its warning and what to change. If any of it differs when the run is
  // submitted - the payer switched, other runs reserved more of the limit, a new warning appeared - the old confirmation no longer matches and the person must confirm again.
  const r4 = (n: number | null) => (n === null ? null : Math.round(n * 1e4) / 1e4)
  const ack = createHash('sha256').update(JSON.stringify({
    payer: i.payer, model,
    rows: rows.map(r => [r.id, r.kind, r.capped, r.units, r.unit_usd, r.usd && { min: r4(r.usd.min), max: r4(r.usd.max) }, r.note]),
    total: { min: r4(total.min), max: r4(total.max) }, unpriced,
    cap: { max: cap.max_usd, reserved: r4(cap.reserved_usd), remaining: r4(cap.remaining_usd), month: cap.month_cap_usd, month_reserved: r4(cap.month_reserved_usd), unknown: cap.unknown, capped_total: { min: r4(cappedTotal.min), max: r4(cappedTotal.max) } },
    verdict,
  })).digest('hex').slice(0, 16)
  return { rows, total, unpriced, assumptions, payer: i.payer, cap, verdict, ack }
}

// After the run: what was actually recorded next to the estimate. Only recorded facts: the tokens the provider reported
// (priced at the listed price) and the searches the run attempted. Unknown stays null; it is never shown as zero.
export interface ActualInput { inputTokens: number | null; outputTokens: number | null; tokensComplete: boolean; model?: string | null; searches: number | null; reservedUsd: number | null }
export interface ActualVsEstimate { model_usd: number | null; model_usd_complete: boolean; searches: number | null; reserved_usd: number | null; estimate: Range; within: 'under' | 'within' | 'over' | 'unknown'; summary: string }
export function compareActual(est: Pick<RunEstimate, 'total' | 'rows'>, a: ActualInput): ActualVsEstimate {
  const p = a.model ? PRICES_USD_PER_M[a.model] : undefined
  const usd = p && a.inputTokens !== null && a.outputTokens !== null ? (a.inputTokens * p.in + a.outputTokens * p.out) / 1e6 : null
  const modelEst = est.rows.filter(r => r.kind === 'model').reduce((x, r) => ({ min: x.min + (r.usd?.min ?? 0), max: x.max + (r.usd?.max ?? 0) }), { min: 0, max: 0 })
  const within = usd === null ? 'unknown' : usd < modelEst.min ? 'under' : usd > modelEst.max ? 'over' : 'within'
  const summary = usd === null ? `Actual model cost was not recorded (estimate ${money(modelEst.min)}-${money(modelEst.max)}).`
    : `Actual model cost ${a.tokensComplete ? '' : 'at least '}${money(usd)} from the tokens the provider reported, against an estimate of ${money(modelEst.min)}-${money(modelEst.max)} (${within === 'within' ? 'inside the range' : within === 'under' ? 'below the range' : 'above the range'}). Not an invoice.`
  return { model_usd: usd, model_usd_complete: usd !== null && a.tokensComplete, searches: a.searches, reserved_usd: a.reservedUsd, estimate: est.total, within, summary }
}

// The one line under the menu that states the limits and what is left. Unreadable budget is "remaining unknown" (never $0.00); the daily and monthly limits are labelled,
// each with its own reserved amount, and the amount left says which of them binds.
const cur = (n: number) => `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`
export function capLine(cap: RunEstimate['cap'], capped: Range): string | null {
  if (cap.max_usd == null && cap.month_cap_usd == null) return null
  const parts: string[] = []
  if (cap.max_usd != null) parts.push(`Daily limit: ${cur(cap.max_usd)}${cap.unknown ? '' : cap.reserved_usd > 0 ? ` (${cur(cap.reserved_usd)} already reserved today)` : ''}`)
  if (cap.month_cap_usd != null) parts.push(`Monthly limit: ${cur(cap.month_cap_usd)}${cap.unknown ? '' : cap.month_reserved_usd > 0 ? ` (${cur(cap.month_reserved_usd)} already reserved this month)` : ''}`)
  const left = cap.unknown || cap.remaining_usd === null ? 'Remaining: unknown (your shared spend could not be read)' : `${cur(cap.remaining_usd)} left${cap.binding ? ` (${cap.binding} limit binds)` : ''}`
  return `${parts.join('; ')}; ${left}. Model requests expected: ${capped.min === capped.max ? cur(capped.min) : `${cur(capped.min)} - ${cur(capped.max)}`}.`
}
