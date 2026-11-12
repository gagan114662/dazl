// Price estimate for one scan, shown BEFORE anything paid runs, and the actual-vs-estimate read after it. Pure: no database,
// no network, no provider call. The idea (a menu of what a run will use, each with a unit price and a projected total the
// user confirms) follows other lead agents' pre-run cost gates; the numbers here are dazl's own.
//
// What it is: a RANGE built from named assumptions (shown with the estimate), the listed price of the model the run will really
// call (EstimateInput.priceModel: the server passes spend-cap.ts scanModelPrice, the table the hard scan cap reserves at), and the
// per-scan caps the runner really enforces (DEFAULT_TINYFISH counts, PEOPLE_SEARCHES_MAX). What it is not: a bill, a quote or a
// ceiling. The ONLY hard dollar ceiling is the run budget's max_usd (a reservation limit on model requests), so the verdict
// uses that and nothing else: the estimate and the cap agree because the capped rows are priced exactly as the guard prices them.
import { PRICES_USD_PER_M, INPUT_MARGIN_TOKENS, completionCost, priceOf } from '../llm/spend-guard.ts'
import { DEFAULT_TINYFISH, PEOPLE_SEARCHES_MAX } from './run-budget.ts'
import { FIRST_PLAY_MAX } from '../people/first-play-cap.ts'
import type { RunBudget } from './runner.ts'
import { createHash } from 'node:crypto'
import { trialCopy } from '../trial-copy.ts'

export const DEFAULT_MODEL = 'claude-sonnet-4-5'
// Shown (and confirmed) when a payer's own key exists but which model it runs could not be read: priced as unknown, never as
// the default model (#851).
export const UNKNOWN_MODEL = 'unknown model (could not be read)'
// A spending limit's guards (the run's max_usd, the owner's day/month pool and the trial's reserve: SpendGuard and PooledGuard)
// price a call with spend-guard.ts callCostUsd, an EXACT lookup in PRICES_USD_PER_M. Any other model id, including a dated id
// of a listed model, is refused at the first call, so a limited run cannot reserve for it.
export const limitReservable = (model: string): boolean => Object.prototype.hasOwnProperty.call(PRICES_USD_PER_M, model)
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
// The trial refusals that stop a run for this account now (trialRefusal in lib/billing/trial-budget.ts). FREE_TRIAL_SCANS mirrors TRIAL_SCANS_PER_ACCOUNT
// (pinned by test/trial-interrupted-attempt.test.ts): this module is imported by the browser, so it cannot import the server-side trial module.
const TRIAL_BLOCKS = new Set(['attempts_cap', 'account_total_cap', 'global_daily_cap', 'domain_used', 'google_required'])
export const FREE_TRIAL_SCANS = 3
export interface Verdict { ok: boolean; reason: 'over_budget' | 'budget_unknown' | 'accounting_unsettled' | 'model_unpriced' | 'trial_unavailable' | null; message: string; change: string[]; warning: string | null }
export interface RunEstimate {
  rows: EstimateRow[]; total: Range; unpriced: string[]; assumptions: string[]
  payer: 'you' | 'trial'; cap: { max_usd: number | null; reserved_usd: number; remaining_usd: number | null; binding: 'daily' | 'monthly' | null; capped_total: Range; month_cap_usd: number | null; month_reserved_usd: number; unknown: boolean }
  verdict: Verdict; ack: string
  // A trial account's remaining dollar allowance (lib/billing/trial-budget.ts trialAllowanceLeft). Display only: deliberately NOT part of `ack`, so the
  // confirmation of an estimate never goes stale because a read changed it, and POST /api/scan (which does not read it) never answers estimate_changed.
  trial_allowance?: { left_usd: number; total_usd: number } | null
}
export interface EstimateInput {
  budget: RunBudget | null
  payer: 'you' | 'trial'
  model?: string                     // exact model id the run will use (the payer's key's configured model); omitted: DEFAULT_MODEL
  modelUnknown?: boolean             // the payer's key exists but its model could not be read: every model row is unpriced (#851)
  // A spending-limit guard will price every model call (the run's max_usd, the owner's day/month pool, or a trial's reserve).
  // Default: the limits this estimate itself knows about (max_usd, ownerCapUsd, ownerMonthCapUsd).
  limited?: boolean
  pricedAlternative?: string | null  // a model a limited run CAN reserve for (the Anthropic key's model), offered when this one cannot
  // The listed price of a model id. The server passes spend-cap.ts scanModelPrice (the scan path's table, incl. gpt-4.1 and dated
  // ids); it is injected because this module is also imported by a client component, which must not bundle the spend-cap store.
  // Default: the shared table, exact id only.
  priceModel?: (model: string) => { in: number; out: number } | null
  enrichmentVendors?: string[]       // bring-your-own enrichment keys the account saved ('apollo', 'pdl')
  // #1037: the post-scan people searches (who to contact) a first play (first5) or free-trial scan may make: the server passes
  // firstPlayPeopleCap() when people search can run, else 0. Omitted: the code maximum (FIRST_PLAY_MAX), never understated.
  firstPlayPeopleSearches?: number
  // A free-trial scan pays each people search from its trial reserve at this price (DAZL_TRIAL_TINYFISH_SEARCH_USD, trialCaps()).
  trialTinyfishSearchUsd?: number | null
  hiringRequest?: boolean            // the buyer-fit company-page check runs for hiring requests
  reservedUsd?: number               // already reserved against the same owner pool
  ownerCapUsd?: number | null        // the operator's cap for this owner (DAZL_RUN_MAX_USD_USERS); the tighter of it and budget.max_usd applies
  ownerMonthCapUsd?: number | null   // the operator's monthly cap for this owner (DAZL_OWNER_MONTH_MAX_USD_USERS); the room left is the tighter of the day's and the month's
  reservedMonthUsd?: number          // already reserved against the owner's monthly pool
  poolUnknown?: boolean              // the shared pool could not be read: the reserved amounts above are NOT known (never treated as zero)
  // An earlier paid call of this owner was never accounted (its pending-settlement marker is stale or marked failed,
  // lib/llm/spend-pool.ts): the pool refuses every reservation until an operator clears it, so the run cannot start.
  poolUnsettled?: boolean
  // A free-trial scan's own per-scan ceiling (DAZL_TRIAL_SCAN_RESERVE_USD: the job guard's limit, runner.ts). Only a trial payer with a positive
  // finite number uses it; anything else is ignored, never an invented ceiling.
  trialReserveUsd?: number | null
  // Why POST /api/scan would refuse this trial account right now (lib/billing/trial-budget.ts trialRefusal), so the screen refuses up front
  // instead of offering a Run button that does nothing. Only trial payers use it; not_configured and unknown reasons never block here.
  trialRefusal?: string | null
  // The account's free scans actually used (for the blocked screen's copy: a full day or a spent allowance says the real count, never "3 of 3").
  trialUsed?: number | null
  // The account's remaining trial dollar allowance, display only (RunEstimate.trial_allowance). Only a trial payer shows it; garbage is ignored.
  trialAllowance?: { left_usd: number; total_usd: number } | null
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
const listedPrice = (model: string) => (Object.prototype.hasOwnProperty.call(PRICES_USD_PER_M, model) ? PRICES_USD_PER_M[model] : null)
const modelCost = (p: { in: number; out: number } | null, calls: number, inK: number, outK: number): number | null => {
  // Same formula the spend guard reserves: (input tokens + fixed margin) x input price + output tokens x output price.
  return p ? calls * ((inK * 1000 + INPUT_MARGIN_TOKENS) * p.in + outK * 1000 * p.out) / 1e6 : null
}

export function estimateRun(i: EstimateInput): RunEstimate {
  // The model the run will really call (#851): never silently the default when the caller named one. A blank or non-string
  // id is unknown, and unknown prices nothing.
  const named = i.model === undefined ? DEFAULT_MODEL : typeof i.model === 'string' && i.model.trim() ? i.model : null
  const env = i.env ?? process.env, b = i.budget, model = i.modelUnknown === true || named === null ? UNKNOWN_MODEL : named
  const limit = Math.min(typeof b?.max_usd === 'number' ? b.max_usd : Infinity, i.ownerCapUsd ?? Infinity)
  const monthCap = typeof i.ownerMonthCapUsd === 'number' && i.ownerMonthCapUsd > 0 ? i.ownerMonthCapUsd : null
  const capped = Number.isFinite(limit) || monthCap !== null
  const unknown = i.poolUnknown === true
  const rows: EstimateRow[] = []
  const p = model === UNKNOWN_MODEL ? null : (i.priceModel ?? listedPrice)(model)
  const modelUnit = p ? `$${p.in.toFixed(2)} in / $${p.out.toFixed(2)} out per 1M tokens (${model})` : `${model}: no listed price`
  for (const c of CALLS) {
    const off = (c.optional === 'judge' && b?.judge === false) || (c.optional === 'hiring' && !i.hiringRequest)
    const calls = off ? { min: 0, max: 0 } : c.calls
    const lo = modelCost(p, calls.min, c.inK.min, c.outK.min), hi = modelCost(p, calls.max, c.inK.max, c.outK.max)
    rows.push({ id: c.id, label: c.label, provider: 'AI model', kind: 'model', unit: '1M tokens', unit_usd: modelUnit, units: calls, usd: lo === null || hi === null ? null : { min: lo, max: hi }, capped, note: off ? (c.optional === 'judge' ? 'Off: you skipped the judge' : 'Not a hiring request') : `${calls.min === calls.max ? calls.max : `${calls.min}-${calls.max}`} call(s), ${c.inK.min}-${c.inK.max}k tokens in, ${c.outK.min}-${c.outK.max}k out each` })
  }
  // #379: the fallback's search-result tokens cannot be bounded, so it now never runs - refused on every run,
  // with or without a cap, exactly like a guarded provider already refused it.
  rows.push({ id: 'fallback_research', label: 'Web-search research fallback', provider: 'AI model web search', kind: 'unbounded', unit: 'research call', unit_usd: 'not priced: search-result tokens are not bounded', units: { min: 0, max: 0 }, usd: { min: 0, max: 0 }, capped: false,
    note: 'Never run: its cost cannot be bounded or estimated, so every run refuses it' })
  const tfSearch = num(env.DAZL_PRICE_TINYFISH_SEARCH_USD), tfFetch = num(env.DAZL_PRICE_TINYFISH_FETCH_USD)
  const fp = i.firstPlayPeopleSearches
  const firstPlayPeople = typeof fp === 'number' && Number.isSafeInteger(fp) && fp >= 0 ? Math.min(fp, FIRST_PLAY_MAX) : FIRST_PLAY_MAX
  if (b?.first5) {
    // #1037: leads come from free sources only, but the run then looks up who to contact with capped TinyFish people searches.
    rows.push({ id: 'sources_free', label: 'Free sources for the leads (first-scan mode)', provider: 'GDELT, job boards, SEC, site crawl', kind: 'free', unit: 'source read', unit_usd: 'free', units: { min: 0, max: 0 }, usd: { min: 0, max: 0 }, capped: false, note: 'No TinyFish lead search or page fetch in this mode' })
    // A trial pays these from its own reserve at the trial price (runner.ts trialPeoplePrepaid), never into the reserve's last 25%.
    const trialPrice = i.payer === 'trial' && typeof i.trialTinyfishSearchUsd === 'number' && Number.isFinite(i.trialTinyfishSearchUsd) && i.trialTinyfishSearchUsd >= 0 ? i.trialTinyfishSearchUsd : null
    const unit = trialPrice ?? tfSearch
    if (firstPlayPeople > 0) rows.push({ id: 'people_search', label: 'People search (who to contact)', provider: 'TinyFish', kind: 'search', unit: 'search', unit_usd: trialPrice !== null ? `${money(trialPrice)} from the free-trial reserve` : tfSearch === null ? 'free allowance (set DAZL_PRICE_TINYFISH_SEARCH_USD if you pay per search)' : money(tfSearch), units: { min: 0, max: firstPlayPeople }, usd: { min: 0, max: unit === null ? 0 : unit * firstPlayPeople }, capped: false, note: `After the scan, at most ${firstPlayPeople} searches, one per ready lead that names nobody yet (a count cap, not a dollar cap)${trialPrice !== null ? '; paid from the free-trial reserve and never from its last 25%, so fewer may run' : ''}` })
  } else {
    // A free-trial scan's people step runs at the first-play cap, not the ordinary scan's (runner.ts firstPlay).
    const people = i.payer === 'trial' ? firstPlayPeople : PEOPLE_SEARCHES_MAX
    const price = (u: number | null, n: number): Range | null => (u === null ? { min: 0, max: 0 } : { min: 0, max: u * n })
    rows.push({ id: 'tinyfish_search', label: 'Web search', provider: 'TinyFish', kind: 'search', unit: 'search', unit_usd: tfSearch === null ? 'free allowance (set DAZL_PRICE_TINYFISH_SEARCH_USD if you pay per search)' : money(tfSearch), units: { min: 1, max: DEFAULT_TINYFISH.searchesPerScan + people }, usd: price(tfSearch, DEFAULT_TINYFISH.searchesPerScan + people), capped: false, note: `At most ${DEFAULT_TINYFISH.searchesPerScan} searches plus ${people} people searches per scan (a count cap, not a dollar cap)` })
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
  const trialCeil = i.payer === 'trial' && typeof i.trialReserveUsd === 'number' && Number.isFinite(i.trialReserveUsd) && i.trialReserveUsd > 0 ? i.trialReserveUsd : null
  const change: string[] = []
  let ok = true, reason: Verdict['reason'] = null, message = 'Within your limit.', warning: string | null = null
  const trialWhy = i.payer === 'trial' && typeof i.trialRefusal === 'string' && TRIAL_BLOCKS.has(i.trialRefusal) ? i.trialRefusal : null
  if (trialWhy) {
    // attempts_cap means all of them are used; any other reason states the account's real count (0 when unknown/fresh), never "3 of 3".
    const used = trialWhy === 'attempts_cap' ? FREE_TRIAL_SCANS : Math.min(FREE_TRIAL_SCANS, Math.max(0, Math.trunc(Number(i.trialUsed) || 0)))
    const c = trialCopy({ funded: false, remaining: FREE_TRIAL_SCANS - used, cap: FREE_TRIAL_SCANS, blocked: trialWhy })
    ok = false; reason = 'trial_unavailable'
    message = `Blocked: ${c.text} Nothing was started or reserved.`
    change.push(c.next.label + '.')
  } else if (i.poolUnsettled) {
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
    // A trial scan's own per-scan reserve (runner.ts: guardMax = min(trial reserve, the run's max_usd)) can be tighter than the room left: then IT is the ceiling the person confirms against.
    const eff = trialCeil !== null && trialCeil < remaining ? trialCeil : remaining, trialBinds = eff !== remaining
    if (cappedTotal.min > eff) {
      ok = false; reason = 'over_budget'
      message = trialBinds
        ? `Blocked: the model requests alone are expected to cost at least ${money(cappedTotal.min)} but the free trial stops each scan at ${money(eff)}.`
        : `Blocked: the model requests alone are expected to cost at least ${money(cappedTotal.min)} but only ${money(remaining)} of your ${money(shownLimit)} ${limitWord} is left${shownReserved > 0 ? ` (${money(shownReserved)} already reserved)` : ''}.`
      change.push(`Raise the ${monthBinds ? 'monthly ' : ''}dollar limit to at least ${money(cappedTotal.min + shownReserved)} (about ${money(cappedTotal.max + shownReserved)} covers the worst case).`)
      const judge = rows.find(r => r.id === 'judge')
      if (judge?.usd && judge.usd.min > 0) change.push(`Skip the verification judge (saves about ${money(judge.usd.min)}-${money(judge.usd.max)}).`)
      change.push('Narrow the request so fewer candidates need extracting and grading.')
    } else if (cappedTotal.max > eff) {
      if (trialBinds) message = `The free trial stops each scan at ${money(eff)}, whatever your own limit says.`
      warning = trialBinds
        ? `The worst case (${money(cappedTotal.max)}) is above the trial's ${money(eff)} limit per scan, so the scan may stop early as a budget stop. That is a stop, not zero results.`
        : `The worst case (${money(cappedTotal.max)}) is above the ${money(remaining)} left, so the run may stop early as a budget stop. That is a stop, not zero results.`
    } else message = trialBinds ? `Within your limit: even the worst case (${money(cappedTotal.max)}) fits the free trial's ${money(eff)} limit per scan.` : `Within your limit: even the worst case (${money(cappedTotal.max)}) fits the ${money(remaining)} left.`
  } else if (trialCeil !== null) {
    // The trial's per-scan ceiling is real: every model call is reserved against it and refused past it.
    message = `The free trial stops each scan at ${money(trialCeil)}, whatever the estimate shows. A scan that would pass that stops early as a budget stop, which is not "nothing found".`
    if (total.max > trialCeil) warning = `The worst case (${money(total.max)}) is above the trial's ${money(trialCeil)} limit per scan, so the scan may stop early as a budget stop. That is a stop, not zero results.`
  } else message = 'No dollar limit is set, so nothing here is a ceiling. Set one to make the run stop at an amount.'
  // A run under a spending limit only reserves for a model the limit's guard can price (limitReservable); any other model is
  // refused at its first call (model_unpriced). Say so BEFORE launch, and put that verdict inside the confirmation (ack) below.
  // EVERY run, limited or not, also runs inside the per-scan spend cap (runner.ts runWithScanSpend), which reserves each model
  // call at i.priceModel's price (spend-cap.ts modelCostUsd -> scanModelPrice) and refuses an id it cannot price. So when the
  // caller supplied that table and it has no price for a named model, the run would stop at its first model call with or
  // without a limit: refuse that too, and never advise removing the limit (it cannot help). An unreadable model
  // (UNKNOWN_MODEL) is not refused without a limit: the model the run really calls may be priced.
  const scanUnpriced = i.priceModel !== undefined && p === null && model !== UNKNOWN_MODEL
  if (ok && (scanUnpriced || ((i.limited ?? capped) && !limitReservable(model)))) {
    ok = false; reason = 'model_unpriced'; warning = null; change.length = 0
    const whose = i.payer === 'trial' ? "The free trial's model" : "Your key's model"
    message = model === UNKNOWN_MODEL
      ? `${i.payer === 'trial' ? "The free trial's model" : 'The model your key runs'} could not be read right now, so a run under a spending limit cannot be priced and would not reserve. Nothing was started or charged.`
      : scanUnpriced
        ? `${whose} (${model}) has no listed price, so the per-scan spend cap every run has would stop it at its first model call, with or without a spending limit. Nothing was started or charged.`
        : `${whose} (${model}) has no listed price the spending limit can reserve against yet, so a run under a spending limit would stop at its first model call.${p ? ' The model rows above use its list price for this estimate only.' : ''} Nothing was started or charged.`
    if (i.payer === 'trial') change.push('This is a dazl configuration problem, not your request: try again later, or add your own AI key in Settings.')
    else {
      if (model === UNKNOWN_MODEL) change.push('Try again in a moment.')
      if (!scanUnpriced) change.push('Run without a spending limit (remove max_usd; a workspace daily/monthly limit also applies if set)')
      // The alternative must be priceable by every guard the run would still meet: the limit's table and the scan cap's.
      const alt = i.pricedAlternative
      if (alt && alt !== model && limitReservable(alt) && (i.priceModel ?? listedPrice)(alt) !== null) change.push(`${scanUnpriced ? 'Use' : 'Or use'} an Anthropic key (${alt} is priced)`)
      if (scanUnpriced) change.push('This is a dazl model configuration problem, not your request: try again later.')
    }
  }
  const assumptions = [
    `Model: ${model}. Tokens per call are ranges chosen by dazl (typical to worst case), priced exactly as the spend guard prices a reservation.`,
    'Search and fetch counts are the per-scan caps the runner enforces; units used are usually lower.',
    'The web-search research fallback and any provider retries cannot be bounded and are not in the total.',
    trialCeil !== null ? `This is an estimate, not a quote or a bill. Only a dollar limit (when set) and the free trial's ${money(trialCeil)} limit per scan stop a run, and only for the model requests dazl sends.` : 'This is an estimate, not a quote or a bill. Only the dollar limit (when set) stops a run, and only for the model requests dazl sends.',
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
    cap: { max: cap.max_usd, reserved: r4(cap.reserved_usd), remaining: r4(cap.remaining_usd), month: cap.month_cap_usd, month_reserved: r4(cap.month_reserved_usd), unknown: cap.unknown, capped_total: { min: r4(cappedTotal.min), max: r4(cappedTotal.max) }, ...(trialCeil !== null ? { trial: r4(trialCeil) } : {}) },
    verdict,
  })).digest('hex').slice(0, 16)
  // Never beside a trial refusal: "$1.00 left" next to "your company already had its free trial" (or "$0.40 left" next to "all 3 free scans used") contradicts the block.
  const a = i.payer === 'trial' && !trialWhy ? i.trialAllowance : null
  const trial_allowance = a && Number.isFinite(a.left_usd) && Number.isFinite(a.total_usd) && a.total_usd > 0 && a.left_usd >= 0 && a.left_usd <= a.total_usd ? { left_usd: a.left_usd, total_usd: a.total_usd } : null
  return { rows, total, unpriced, assumptions, payer: i.payer, cap, verdict, ack, ...(trial_allowance ? { trial_allowance } : {}) }
}

// After the run: what was actually recorded next to the estimate. Only recorded facts: the tokens the provider reported
// (priced at the listed price) and the searches the run attempted. Unknown stays null; it is never shown as zero.
export interface ActualInput { inputTokens: number | null; outputTokens: number | null; tokensComplete: boolean; model?: string | null; searches: number | null; reservedUsd: number | null; requests?: number | null; requestsWithTokens?: number | null; capReservedUsd?: number | null; servedModels?: string[] | null; cacheWriteTokens?: number | null; cacheReadTokens?: number | null }
export interface ActualVsEstimate { model_usd: number | null; model_usd_complete: boolean; searches: number | null; reserved_usd: number | null; cap_reserved_usd: number | null; estimate: Range; within: 'under' | 'within' | 'over' | 'unknown'; summary: string }
export function compareActual(est: Pick<RunEstimate, 'total' | 'rows'>, a: ActualInput): ActualVsEstimate {
  // The canonical pricing truth is the settlement path's own (spend-guard.ts): priceOf normalizes dated served ids
  // (claude-sonnet-4-5-20250929 -> claude-sonnet-4-5) and completionCost prices cache tokens at the shared factors. A
  // bare PRICES_USD_PER_M lookup here called a dated, KNOWN model "unlisted" and reported real spend as unknown.
  const served = a.servedModels && a.servedModels.length ? a.servedModels : a.model ? [a.model] : []
  const priceKeys = new Set(served.map(m => { const p = priceOf(m); return p ? `${p.in}/${p.out}` : null }))
  const mixed = priceKeys.size > 1
  const cost = !mixed && a.inputTokens !== null && a.outputTokens !== null
    ? completionCost(a.model ?? served[0] ?? null, { input_tokens: a.inputTokens, output_tokens: a.outputTokens, cache_creation_input_tokens: a.cacheWriteTokens ?? 0, cache_read_input_tokens: a.cacheReadTokens ?? 0 })
    : null
  const usd = cost && 'usd' in cost ? cost.usd : null
  // Cache token usage is NOT stored per scan (model-usage.ts): absent cache fields are UNKNOWN, not zero. Without them
  // the computed USD is the recorded-token component only - an at-least amount, never "complete" and never placed
  // inside/against the estimate range. Explicit zeros are a real record; provided values price at the shared factors.
  const cacheRecorded = a.cacheWriteTokens != null && a.cacheReadTokens != null
  const complete = usd !== null && a.tokensComplete && cacheRecorded
  const modelEst = est.rows.filter(r => r.kind === 'model').reduce((x, r) => ({ min: x.min + (r.usd?.min ?? 0), max: x.max + (r.usd?.max ?? 0) }), { min: 0, max: 0 })
  const within = !complete ? 'unknown' : usd < modelEst.min ? 'under' : usd > modelEst.max ? 'over' : 'within'
  const reqs = a.requests ?? null, reqsWithTokens = a.requestsWithTokens ?? null
  // Recorded usage is never "not recorded": when calls were made and only the USD could not be settled, the summary says
  // what IS known (call count, reported tokens, why no USD) and that the actual cost is unknown - never $0 or free.
  let summary: string
  if (usd !== null) {
    const range = within === 'unknown' ? '' : ` (${within === 'within' ? 'inside the range' : within === 'under' ? 'below the range' : 'above the range'})`
    const cacheNote = cacheRecorded ? '' : '; cache token usage was not recorded, so this is the recorded-token component, not the full cost'
    summary = `Actual model cost ${complete ? '' : 'at least '}${money(usd)} from the tokens the provider reported${cacheNote}, against an estimate of ${money(modelEst.min)}-${money(modelEst.max)}${range}. Not an invoice.`
  }
  else if (mixed && reqs !== null && reqs > 0 && a.inputTokens !== null && a.outputTokens !== null) summary = `${reqs} model call${reqs === 1 ? '' : 's'} recorded (${a.inputTokens} input / ${a.outputTokens} output tokens) across more than one served model (${served.join(', ')}); the stored sums cannot be priced as one total - the per-call settled costs are in the spend ledger. The actual cost here is unknown, not $0. Estimate was ${money(modelEst.min)}-${money(modelEst.max)}.`
  else if (reqs !== null && reqs > 0 && a.inputTokens !== null && a.outputTokens !== null) summary = `${reqs} model call${reqs === 1 ? '' : 's'} recorded (${reqsWithTokens !== null && reqsWithTokens < reqs ? `tokens reported for ${reqsWithTokens}: ` : ''}${a.inputTokens} input / ${a.outputTokens} output tokens), but no USD cost could be settled (${a.model || served.length ? 'the served model has no listed price' : 'no model id was recorded'}) - the actual cost is unknown, not $0. Estimate was ${money(modelEst.min)}-${money(modelEst.max)}.`
  else if (reqs !== null && reqs > 0) summary = `${reqs} model call${reqs === 1 ? '' : 's'} recorded, but the provider reported no token usage for them, so the actual cost is unknown - not $0. Estimate was ${money(modelEst.min)}-${money(modelEst.max)}.`
  else summary = `Actual model cost was not recorded (estimate ${money(modelEst.min)}-${money(modelEst.max)}).`
  // A reservation is a hold from what the code sent, named as itself - never folded into the cost and never an invoice.
  const capRes = a.capReservedUsd ?? null
  if (capRes !== null && capRes > 0) summary += ` Reserved under this run's spend cap: ${money(capRes)} (a reservation, not a settled charge).`
  return { model_usd: usd, model_usd_complete: complete, searches: a.searches, reserved_usd: a.reservedUsd, cap_reserved_usd: capRes, estimate: est.total, within, summary }
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
