import { discoveryEstimate } from '../discover/pricing.ts'
// Price estimate for one scan, shown BEFORE anything paid runs, and the actual-vs-estimate read after it. Pure: no database,
// no network, no provider call. The idea (a menu of what a run will use, each with a unit price and a projected total the
// user confirms) follows other lead agents' pre-run cost gates; the numbers here are dazl's own.
//
// What it is: a RANGE built from named assumptions (shown with the estimate), the listed price of the model the run will really
// call (EstimateInput.priceModel: the server passes spend-cap.ts scanModelPrice, the table the hard scan cap reserves at), and the
// per-scan caps the runner really enforces (DEFAULT_TINYFISH counts, PEOPLE_SEARCHES_MAX). What it is not: a bill, a quote or a
// ceiling. The ONLY hard dollar ceiling is the run budget's max_usd (a reservation limit on model requests), so the verdict
// uses that and nothing else: the estimate and the cap agree because the capped rows are priced exactly as the guard prices them.
import { PRICES_USD_PER_M, INPUT_MARGIN_TOKENS, priceOf } from '../llm/spend-pricing.ts'
import { formatEstimateUsd as money, type EstimateRow, type Range, type RunEstimate, type Verdict } from './price-estimate-view.ts'

export { capLine, clampToCap, compareActual, customerCopy, customerView, estimatePayerLine, searchAllowanceLine, trialCapLine, trialScanCap } from './price-estimate-view.ts'
export type { ActualInput, ActualVsEstimate, CustomerRow, CustomerView, EstimateRow, Range, RunEstimate, Verdict } from './price-estimate-view.ts'
import { ADAPTIVE_FETCHES, ADAPTIVE_SEARCHES, adaptiveDiscoveryOn, DEFAULT_TINYFISH, PEOPLE_SEARCHES_MAX, SITE_SEARCHES_PER_SCAN } from './run-budget.ts'
import { FIRST_PLAY_MAX, firstPlayLeadCaps } from '../people/first-play-cap.ts'
import type { RunBudget } from './runner.ts'
import { createHash } from 'node:crypto'
import { trialCopy } from '../trial-copy.ts'
import { paidVendorOn } from '../paid-vendors.ts'
import { CLAUDE_COMPANY_FIRST_ASSUMED_INPUT_PER_SEARCH, CLAUDE_COMPANY_FIRST_MAX_CALLS, claudeSearchEstimate } from '../llm/claude-web-search-estimate.ts'

export const DEFAULT_MODEL = 'claude-sonnet-4-5'
// Shown (and confirmed) when a payer's own key exists but which model it runs could not be read: priced as unknown, never as
// the default model (#851).
export const UNKNOWN_MODEL = 'unknown model (could not be read)'
// A spending limit's guards (the run's max_usd, the owner's day/month pool and the trial's reserve: SpendGuard and PooledGuard)
// price a call with spend-guard.ts callCostUsd, an EXACT lookup in PRICES_USD_PER_M. Any other model id, including a dated id
// of a listed model, is refused at the first call, so a limited run cannot reserve for it.
export const limitReservable = (model: string): boolean => Object.prototype.hasOwnProperty.call(PRICES_USD_PER_M, model)
// The trial refusals that stop a run for this account now (trialRefusal in lib/billing/trial-budget.ts). FREE_TRIAL_SCANS mirrors TRIAL_SCANS_PER_ACCOUNT
// (pinned by test/trial-interrupted-attempt.test.ts): this module is imported by the browser, so it cannot import the server-side trial module.
const TRIAL_BLOCKS = new Set(['attempts_cap', 'account_total_cap', 'global_daily_cap', 'domain_used', 'google_required'])
export const FREE_TRIAL_SCANS = 3
export interface EstimateInput {
  budget: RunBudget | null
  // The run goes through the Claude discovery lane (lib/scan/runner.ts runDiscoverLane): one priced step replaces the older pipeline's rows.
  discoverLane?: 'full' | 'small' | 'tiny' | null
  companyFirst?: boolean
  qaClaudeOnly?: boolean
  qaNativeWebSearch?: boolean
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
  // #1037 item 1: a trial pays the first-play lead fallback's page reads from its reserve at this price (runner.ts trialCharges).
  trialTinyfishFetchUsd?: number | null
  // #1037 item 1: the first-play lead fallback's caps as the server runs them (estimate-request passes effectiveFirstPlayLeadCaps);
  // omitted (a browser preview): firstPlayLeadCaps(env), the code maximum, never understated.
  firstPlayLead?: { searches: number; fetches: number }
  hiringRequest?: boolean            // the buyer-fit company-page check runs for hiring requests
  reservedUsd?: number               // already reserved against the same owner pool
  ownerCapUsd?: number | null        // the operator's cap for this owner (DAZL_RUN_MAX_USD_USERS); the tighter of it and budget.max_usd applies
  // #1319: whether the operator named this account (ownerLimits). Every account's day/month caps are shown (ownerCapUsd /
  // ownerMonthCapUsd), but only a run limit, a named account or a trial switches its own paid enrichment off (runner.ts creditEnrichment).
  // Omitted (direct callers): any cap passed counts as named, as before.
  ownerNamed?: boolean
  // #1319: the job guard's own per-scan cap (spend-cap.ts effectiveCapUsd without max_usd: min(scan cap, hard cap)). The run's limit is
  // min(max_usd, this), whether or not the request set a max_usd. Omitted (direct callers): max_usd alone.
  scanCapUsd?: number | null
  ownerMonthCapUsd?: number | null   // the operator's monthly cap for this owner (DAZL_OWNER_MONTH_MAX_USD_USERS); the room left is the tighter of the day's and the month's
  reservedMonthUsd?: number          // already reserved against the owner's monthly pool
  poolUnknown?: boolean              // the shared pool could not be read: the reserved amounts above are NOT known (never treated as zero)
  // An earlier paid call of this owner was never accounted (its pending-settlement marker is stale or marked failed,
  // lib/llm/spend-pool.ts): the pool refuses every reservation until an operator clears it, so the run cannot start.
  poolUnsettled?: boolean
  // A free-trial scan's own per-scan ceiling (DAZL_TRIAL_SCAN_RESERVE_USD: the job guard's limit, runner.ts). Only a trial payer with a positive
  // finite number uses it; anything else is ignored, never an invented ceiling.
  trialReserveUsd?: number | null
  trialExempt?: boolean
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
const num = (v: string | undefined): number | null => { const n = Number(v); return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null }
const listedPrice = (model: string) => (Object.prototype.hasOwnProperty.call(PRICES_USD_PER_M, model) ? PRICES_USD_PER_M[model] : null)
const modelCost = (p: { in: number; out: number } | null, calls: number, inK: number, outK: number): number | null => {
  // Same formula the spend guard reserves: (input tokens + fixed margin) x input price + output tokens x output price.
  return p ? calls * ((inK * 1000 + INPUT_MARGIN_TOKENS) * p.in + outK * 1000 * p.out) / 1e6 : null
}

// (4)A: the most one buyer-fit call may cost (the estimate's own buyer_fit row, worst case), reserved before finish for the post-finish call.
export function buyerFitWorstCaseUsd(model: string): number {
  const r = CALLS.find(c => c.id === 'buyer_fit')!
  const p = priceOf(model)
  if (!p) throw new Error('model_unpriced')
  return ((r.inK.max * 1000 + INPUT_MARGIN_TOKENS) * p.in + r.outK.max * 1000 * p.out) / 1e6
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
  // #381: the adaptive round (one more search round when round one verified nothing) can run on this scan: its searches,
  // pages and extraction call are in the maxima (its verifier's judge calls are counted as the judge row counts round one's)
  const adaptive = !b?.first5 && i.payer !== 'trial' && b?.paid_fallback !== false && adaptiveDiscoveryOn(env)
  for (const c of CALLS) {
    const off = (c.optional === 'judge' && b?.judge === false) || (c.optional === 'hiring' && !i.hiringRequest)
    const calls = off ? { min: 0, max: 0 } : c.id === 'extraction' && adaptive ? { min: c.calls.min, max: c.calls.max + 1 } : c.calls
    const lo = modelCost(p, calls.min, c.inK.min, c.outK.min), hi = modelCost(p, calls.max, c.inK.max, c.outK.max)
    rows.push({ id: c.id, label: c.label, provider: 'AI model', kind: 'model', unit: '1M tokens', unit_usd: modelUnit, units: calls, usd: lo === null || hi === null ? null : { min: lo, max: hi }, capped, note: off ? (c.optional === 'judge' ? 'Off: you skipped the judge' : 'Not a hiring request') : `${calls.min === calls.max ? calls.max : `${calls.min}-${calls.max}`} call(s), ${c.inK.min}-${c.inK.max}k tokens in, ${c.outK.min}-${c.outK.max}k out each` })
  }
  const native = (i.companyFirst === true || (i.qaClaudeOnly === true && i.qaNativeWebSearch === true)) && i.payer === 'you'
  if (native) {
    // Pre-play menu estimate only. The real reservation counts the exact submitted prompt before the paid call.
    const search = claudeSearchEstimate(8_000, i.companyFirst ? 'company_first' : undefined)
    const calls = i.companyFirst ? CLAUDE_COMPANY_FIRST_MAX_CALLS : 1
    rows.push({
      id: 'anthropic_native_web_search', label: 'Claude Web Search', provider: 'Anthropic', kind: 'search',
      unit: 'search', unit_usd: '$0.01 per search plus model tokens', units: { min: 0, max: search.maxSearches * calls },
      usd: { min: 0, max: search.estimatedUsd * calls }, capped,
      note: i.companyFirst
        ? `Company-first discovery makes up to ${calls} guarded AI search call(s), at most ${search.maxSearches} searches per call. Includes ${CLAUDE_COMPANY_FIRST_ASSUMED_INPUT_PER_SEARCH.toLocaleString('en-US')} assumed result input tokens per search plus an estimated prompt and capped output. Actual billed search-result input can exceed this soft estimate.`
        : 'Optional, one AI search call with at most two searches. Includes 25,000 assumed input tokens per search, an estimated prompt and up to 3,000 output tokens. Actual billed search-result input can exceed this soft estimate.',
    })
  }
  // #379: the fallback's search-result tokens cannot be bounded, so it now never runs - refused on every run,
  // with or without a cap, exactly like a guarded provider already refused it.
  rows.push({ id: 'fallback_research', label: 'Web-search research fallback', provider: 'AI model web search', kind: 'unbounded', unit: 'research call', unit_usd: 'not priced: search-result tokens are not bounded', units: { min: 0, max: 0 }, usd: { min: 0, max: 0 }, capped: false,
    note: 'Never run: its cost cannot be bounded or estimated, so every run refuses it' })
  const tfSearch = num(env.DAZL_PRICE_TINYFISH_SEARCH_USD), tfFetch = num(env.DAZL_PRICE_TINYFISH_FETCH_USD)
  const fp = i.firstPlayPeopleSearches
  const firstPlayPeople = typeof fp === 'number' && Number.isSafeInteger(fp) && fp >= 0 ? Math.min(fp, FIRST_PLAY_MAX) : FIRST_PLAY_MAX
  if (i.qaClaudeOnly || i.companyFirst) {
    rows.push({ id: 'qa_public_sources', label: native ? 'Free public sources' : 'Public sources only', provider: 'Public sources', kind: 'free', unit: 'source read', unit_usd: 'free', units: { min: 0, max: 0 }, usd: { min: 0, max: 0 }, capped: false, note: (i.companyFirst ? 'Company-first: no' : 'Claude-only play: no') + ' TinyFish, paid renderer, credit enrichment, or mailbox verifier' })
  } else if (b?.first5) {
    // #1037: leads come from free sources only, but the run then looks up who to contact with capped TinyFish people searches.
    rows.push({ id: 'sources_free', label: 'Free sources for the leads (first-scan mode)', provider: 'GDELT, job boards, SEC, site crawl', kind: 'free', unit: 'source read', unit_usd: 'free', units: { min: 0, max: 0 }, usd: { min: 0, max: 0 }, capped: false, note: 'Leads come from free sources first' })
    // #1037 item 1: when free news cannot serve the play, a capped TinyFish lead search runs instead (runner.ts, firstPlayLeadCaps):
    // at most this many searches and page reads, paid from the free-trial reserve at the trial price for a trial.
    const lead = i.firstPlayLead ?? firstPlayLeadCaps(env)
    if (lead.searches > 0) {
      const trialS = i.payer === 'trial' && typeof i.trialTinyfishSearchUsd === 'number' && Number.isFinite(i.trialTinyfishSearchUsd) && i.trialTinyfishSearchUsd >= 0 ? i.trialTinyfishSearchUsd : null
      const trialF = trialS !== null && typeof i.trialTinyfishFetchUsd === 'number' && Number.isFinite(i.trialTinyfishFetchUsd) && i.trialTinyfishFetchUsd >= 0 ? i.trialTinyfishFetchUsd : null
      const su = trialS ?? tfSearch, fu = trialF ?? tfFetch
      rows.push({ id: 'first_play_lead_search', label: 'Lead search fallback (only when free news cannot serve the play)', provider: 'TinyFish', kind: 'search', unit: 'search', unit_usd: trialS !== null ? `${money(trialS)} from the free-trial reserve` : tfSearch === null ? 'free allowance (set DAZL_PRICE_TINYFISH_SEARCH_USD if you pay per search)' : money(tfSearch), units: { min: 0, max: lead.searches }, usd: { min: 0, max: (su ?? 0) * lead.searches + (fu ?? 0) * lead.fetches }, capped: false, note: `Only when free news cannot serve the play: at most ${lead.searches} TinyFish searches and ${lead.fetches} page reads (a count cap, not a dollar cap)${trialS !== null ? '; paid from the free-trial reserve and never from its last 25%, so fewer may run' : ''}` })
    }
    // A trial pays these from its own reserve at the trial price (runner.ts trialPeoplePrepaid), never into the reserve's last 25%.
    const trialPrice = i.payer === 'trial' && typeof i.trialTinyfishSearchUsd === 'number' && Number.isFinite(i.trialTinyfishSearchUsd) && i.trialTinyfishSearchUsd >= 0 ? i.trialTinyfishSearchUsd : null
    const unit = trialPrice ?? tfSearch
    if (firstPlayPeople > 0) rows.push({ id: 'people_search', label: 'People search (who to contact)', provider: 'TinyFish', kind: 'search', unit: 'search', unit_usd: trialPrice !== null ? `${money(trialPrice)} from the free-trial reserve` : tfSearch === null ? 'free allowance (set DAZL_PRICE_TINYFISH_SEARCH_USD if you pay per search)' : money(tfSearch), units: { min: 0, max: firstPlayPeople }, usd: { min: 0, max: unit === null ? 0 : unit * firstPlayPeople }, capped: false, note: `After the scan, at most ${firstPlayPeople} searches, one per lead that names nobody yet, ready leads first (a count cap, not a dollar cap)${trialPrice !== null ? '; paid from the free-trial reserve and never from its last 25%, so fewer may run' : ''}` })
  } else {
    // A free-trial scan's people step runs at the first-play cap, not the ordinary scan's (runner.ts firstPlay), and is paid from the
    // trial reserve at the trial price (runner.ts trialPeoplePrepaid); the lead searches keep the operator's price.
    const people = i.payer === 'trial' ? firstPlayPeople : PEOPLE_SEARCHES_MAX
    const trialPeoplePrice = i.payer === 'trial' && typeof i.trialTinyfishSearchUsd === 'number' && Number.isFinite(i.trialTinyfishSearchUsd) && i.trialTinyfishSearchUsd >= 0 ? i.trialTinyfishSearchUsd : null
    const searches = DEFAULT_TINYFISH.searchesPerScan + (adaptive ? ADAPTIVE_SEARCHES : 0), fetches = DEFAULT_TINYFISH.fetchesPerScan + (adaptive ? ADAPTIVE_FETCHES : 0)
    const extra = adaptive ? `; plus at most ${ADAPTIVE_SEARCHES} searches and ${ADAPTIVE_FETCHES} pages in one more round, only when the first round verifies no lead` : ''
    // #1036 4b: the company-website searches after the scan (runner.ts siteFinderFor). A MAXIMUM: this branch is never a first play,
    // and a trial or a run with paid steps off gets none; a scheduled play run and a deployment without TinyFish also make none,
    // which the estimate cannot see, so there it overstates (never understates).
    const site = i.payer !== 'trial' && b?.paid_fallback !== false && env.SITECRAWL_ENABLED !== '0' ? SITE_SEARCHES_PER_SCAN : 0
    const searchMax = (tfSearch ?? 0) * (searches + site) + (trialPeoplePrice ?? tfSearch ?? 0) * people
    const price = (u: number | null, n: number): Range | null => (u === null ? { min: 0, max: 0 } : { min: 0, max: u * n })
    rows.push({ id: 'tinyfish_search', label: 'Web search', provider: 'TinyFish', kind: 'search', unit: 'search', unit_usd: tfSearch === null ? 'free allowance (set DAZL_PRICE_TINYFISH_SEARCH_USD if you pay per search)' : money(tfSearch), units: { min: 1, max: searches + people + site }, usd: { min: 0, max: searchMax }, capped: false, note: `At most ${DEFAULT_TINYFISH.searchesPerScan} searches plus ${people} people searches per scan (a count cap, not a dollar cap)${extra}${site ? `; plus at most ${site} company-website searches, one for each lead whose source page links no website` : ''}${trialPeoplePrice !== null ? `; the people searches are paid from the free-trial reserve at ${money(trialPeoplePrice)} each` : ''}` })
    rows.push({ id: 'tinyfish_fetch', label: 'Page fetch', provider: 'TinyFish', kind: 'fetch', unit: 'page', unit_usd: tfFetch === null ? 'free allowance (set DAZL_PRICE_TINYFISH_FETCH_USD if you pay per page)' : money(tfFetch), units: { min: 1, max: fetches }, usd: price(tfFetch, fetches), capped: false, note: `At most ${DEFAULT_TINYFISH.fetchesPerScan} pages per scan (a count cap, not a dollar cap)${extra}` })
  }
  const runLimited = i.ownerNamed === undefined ? capped : typeof b?.max_usd === 'number' || i.ownerNamed
  const enrichOff = runLimited || i.payer === 'trial' || b?.credit_enrichment === false || b?.first5
  for (const v of ['apollo', 'pdl']) {
    // Refs #1099: a saved key the paid-vendor policy keeps off makes no call, so it has no row in the estimate
    const have = (i.enrichmentVendors ?? []).includes(v) && paidVendorOn(v as 'apollo' | 'pdl', env)
    if (!have) continue
    const u = num(env[`DAZL_PRICE_${v.toUpperCase()}_CREDIT_USD`]), n = enrichOff ? 0 : 8
    rows.push({ id: `${v}_credits`, label: v === 'apollo' ? 'Apollo enrichment' : 'People Data Labs enrichment', provider: v === 'apollo' ? 'Apollo' : 'People Data Labs', kind: 'enrichment', unit: 'credit', unit_usd: u === null ? 'your own plan; per-credit price not set' : money(u), units: { min: 0, max: n }, usd: enrichOff ? { min: 0, max: 0 } : u === null ? null : { min: 0, max: u * n }, capped: false, note: enrichOff ? 'Off: this run turns bring-your-own enrichment off' : 'Up to 8 companies, on your own credits' })
  }
  if (i.discoverLane) rows.splice(0, rows.length, discoveryEstimate(i.discoverLane, capped))
  const unpriced = rows.filter(r => r.usd === null).map(r => r.label)
  const sum = (rs: EstimateRow[]): Range => ({ min: rs.reduce((a, r) => a + (r.usd?.min ?? 0), 0), max: rs.reduce((a, r) => a + (r.usd?.max ?? 0), 0) })
  const total = sum(rows), cappedTotal = sum(rows.filter(r => r.capped))
  const reserved = Math.max(0, i.reservedUsd ?? 0), monthReserved = Math.max(0, i.reservedMonthUsd ?? 0)
  // The room left is the TIGHTER of what the day's limit and the month's limit allow; the label names the one that binds.
  // The run's own max_usd is a PER-RUN ceiling (its job guard counts only this run's reservations), so today's pooled
  // reservations come off the owner's day cap only, never off max_usd (case-1 runs were blocked once the day's earlier
  // runs exceeded one run's max_usd while the day cap still had room).
  const runMax = Math.min(typeof b?.max_usd === 'number' ? b.max_usd : Infinity, typeof i.scanCapUsd === 'number' ? i.scanCapUsd : Infinity), ownerDay = i.ownerCapUsd ?? null
  // #1319: with no day cap known here, the run's limit is its own room: the day's reservations never come off it
  const dayLeft = ownerDay !== null ? Math.min(runMax, ownerDay - reserved) : runMax, monthLeft = monthCap === null ? Infinity : monthCap - monthReserved
  const monthBinds = monthLeft < dayLeft
  // #1319: the run's own limit binds when it, not the day's room, sets dayLeft (or there is no day cap); the label names it
  // ("this run's limit"), never "daily"
  const runBinds = !monthBinds && Number.isFinite(runMax) && (ownerDay === null || runMax < ownerDay - reserved)
  const remaining = capped && !unknown ? Math.max(0, Math.min(dayLeft, monthLeft)) : null   // unknown reserved amounts -> unknown remaining, never 0
  const binding: 'run' | 'daily' | 'monthly' | null = remaining === null ? null : monthBinds ? 'monthly' : runBinds ? 'run' : 'daily'
  const dayCapShown = ownerDay ?? Infinity, shownLimit = monthBinds ? (monthCap as number) : runBinds ? runMax : dayCapShown
  // a run limit under a day cap is never charged the day's reservations (dayLeft above)
  // #1319: a max_usd can only lower the per-scan cap; when the per-scan cap itself binds the person has no limit to raise
  const personBinds = runBinds && typeof b?.max_usd === 'number' && b.max_usd <= runMax
  const shownReserved = monthBinds ? monthReserved : runBinds ? 0 : reserved, limitWord = monthBinds ? 'monthly limit' : runBinds && !personBinds ? 'per-scan limit' : 'limit'
  const trialCeil = i.payer === 'trial' && typeof i.trialReserveUsd === 'number' && Number.isFinite(i.trialReserveUsd) && i.trialReserveUsd > 0 ? i.trialReserveUsd : null
  const trialExempt = i.payer === 'trial' && i.trialExempt === true
  const scanStop = (usd: number) => trialExempt ? 'this scan has a spending limit' : `the free trial stops each scan at ${money(usd)}`
  const scanLimit = (usd: number) => trialExempt ? 'the per-scan spending limit' : `the trial's ${money(usd)} limit per scan`
  const change: string[] = []
  let ok = true, reason: Verdict['reason'] = null, message = 'Within your limit.', warning: string | null = null, trialRefusalWhy: string | null = null
  const trialWhy = i.payer === 'trial' && typeof i.trialRefusal === 'string' && TRIAL_BLOCKS.has(i.trialRefusal) ? i.trialRefusal : null
  if (trialWhy) {
    // attempts_cap means all of them are used; any other reason states the account's real count (0 when unknown/fresh), never "3 of 3".
    const used = trialWhy === 'attempts_cap' ? FREE_TRIAL_SCANS : Math.min(FREE_TRIAL_SCANS, Math.max(0, Math.trunc(Number(i.trialUsed) || 0)))
    const c = trialCopy({ funded: false, remaining: FREE_TRIAL_SCANS - used, cap: FREE_TRIAL_SCANS, blocked: trialWhy, exempt: trialExempt })
    ok = false; reason = 'trial_unavailable'; trialRefusalWhy = trialWhy
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
        ? `Blocked: the model requests alone are expected to cost at least ${money(cappedTotal.min)} but ${scanStop(eff)}.`
        : `Blocked: the model requests alone are expected to cost at least ${money(cappedTotal.min)} but only ${money(remaining)} of your ${money(shownLimit)} ${limitWord} is left${shownReserved > 0 ? ` (${money(shownReserved)} already reserved)` : ''}.`
      // #1319: only this run's limit is the person's to raise, and a raise is offered only when every other ceiling of the run (the per-scan
      // cap a max_usd can only lower, the free trial's stop, the day's and the month's room) covers the cost. Otherwise the ceiling that
      // stops the run is named: the account windows with when they reset, the per-scan cap, or the trial's stop.
      const need = cappedTotal.min + shownReserved
      const scanCeil = typeof i.scanCapUsd === 'number' ? i.scanCapUsd : Infinity, trialRoom = trialCeil ?? Infinity
      const dayRoom = ownerDay !== null ? ownerDay - reserved : Infinity, dayLine = `Your daily limit (${money(ownerDay ?? 0)}) has ${money(Math.max(0, dayRoom))} left today; it resets at 00:00 UTC.`
      const monthLine = `Your monthly limit (${money(monthCap ?? 0)}) has ${money(Math.max(0, monthLeft))} left this month; it resets on the 1st at 00:00 UTC.`
      if (trialBinds) { /* the free trial's own per-scan stop: nothing the person can raise (the message names it) */ }
      else if (monthBinds) change.push(monthLine)
      else if (!runBinds && ownerDay !== null) change.push(dayLine)
      else if (runBinds) {
        if (cappedTotal.min > dayRoom) change.push(dayLine)
        else if (cappedTotal.min > monthLeft) change.push(monthLine)
        else if (cappedTotal.min > trialRoom) change.push(trialExempt ? 'This scan has a spending limit.' : `The free trial stops each scan at ${money(trialRoom)}.`)
        else if (!personBinds || need > scanCeil) change.push(`Each scan is capped at ${money(Number.isFinite(scanCeil) ? scanCeil : runMax)}.`)
        else if (!native) change.push(`Raise the dollar limit to at least ${money(need)} (about ${money(cappedTotal.max + shownReserved)} covers the worst case).`)
      }
      const judge = rows.find(r => r.id === 'judge')
      if (judge?.usd && judge.usd.min > 0) change.push(`Skip the verification judge (saves about ${money(judge.usd.min)}-${money(judge.usd.max)}).`)
      change.push('Narrow the request so fewer candidates need extracting and grading.')
    } else if (cappedTotal.max > eff) {
      if (trialBinds) message = trialExempt ? 'This scan has a spending limit.' : `The free trial stops each scan at ${money(eff)}, whatever your own limit says.`
      warning = trialBinds
        ? `The worst case (${money(cappedTotal.max)}) is above ${scanLimit(eff)}, so the scan may stop early as a budget stop. That is a stop, not zero results.`
        : `The worst case (${money(cappedTotal.max)}) is above the ${money(remaining)} left, so the run may stop early as a budget stop. That is a stop, not zero results.`
    } else message = trialBinds ? `Within your limit: even the worst case (${money(cappedTotal.max)}) fits ${trialExempt ? scanLimit(eff) : `the free trial's ${money(eff)} limit per scan`}.` : `Within your limit: even the worst case (${money(cappedTotal.max)}) fits the ${money(remaining)} left.`
  } else if (trialCeil !== null) {
    // The trial's per-scan ceiling is real: every model call is reserved against it and refused past it.
    message = trialExempt ? 'This scan may stop early if it reaches its spending limit.' : `The free trial stops each scan at ${money(trialCeil)}, whatever the estimate shows. A scan that would pass that stops early as a budget stop, which is not "nothing found".`
    if (total.max > trialCeil) warning = `The worst case (${money(total.max)}) is above ${scanLimit(trialCeil)}, so the scan may stop early as a budget stop. That is a stop, not zero results.`
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
    const whose = i.payer === 'trial' ? "The free trial's model" : "The workspace model"
    message = model === UNKNOWN_MODEL
      ? `${i.payer === 'trial' ? "The free trial's model" : 'The workspace model'} could not be read right now, so a run under a spending limit cannot be priced and would not reserve. Nothing was started or charged.`
      : scanUnpriced
        ? `${whose} (${model}) has no listed price, so the per-scan spend cap every run has would stop it at its first model call, with or without a spending limit. Nothing was started or charged.`
        : `${whose} (${model}) has no listed price the spending limit can reserve against yet, so a run under a spending limit would stop at its first model call.${p ? ' The model rows above use its list price for this estimate only.' : ''} Nothing was started or charged.`
    if (i.payer === 'trial') change.push('This is a dazl configuration problem, not your request: try again later.')
    else {
      if (model === UNKNOWN_MODEL) change.push('Try again in a moment.')
      if (!scanUnpriced) change.push('Run without a spending limit (remove max_usd; a workspace daily/monthly limit also applies if set)')
      // The alternative must be priceable by every guard the run would still meet: the limit's table and the scan cap's.
      const alt = i.pricedAlternative
      if (alt && alt !== model && limitReservable(alt) && (i.priceModel ?? listedPrice)(alt) !== null) change.push(`${scanUnpriced ? 'Use' : 'Or use'} the priced Claude model (${alt})`)
      if (scanUnpriced) change.push('This is a dazl model configuration problem, not your request: try again later.')
    }
  }
  if (native && ok) {
    message = warning ? 'The run may stop early at the current estimated-spend limit.' : 'The estimated cost fits the current limit.'
    warning = [warning?.replace('The worst case', 'The high estimate'), 'The budget stops new requests based on estimated reservations. Anthropic’s actual search-result token charges may exceed the estimate; this is not a hard billing limit.'].filter(Boolean).join(' ')
  }
  const assumptions = [
    `Model: ${model}. Tokens per call are ranges chosen by dazl (typical to worst case), priced exactly as the spend guard prices a reservation.`,
    'Search and fetch counts are the per-scan caps the runner enforces; units used are usually lower.',
    ...(native ? [
      'Claude Web Search uses an estimated 8,000 initial prompt tokens in this preview. The actual pre-call reservation prices a count of the submitted prompt, a margin, capped output, and the tool fees plus estimated search-result tokens.',
      'Only the listed Claude Web Search path is included; the generic web-search research fallback remains disabled.',
    ] : ['The web-search research fallback and any provider retries cannot be bounded and are not in the total.']),
    native ? 'This is a soft estimate, not a quote, a bill, or a hard billing limit.' : trialCeil !== null && !trialExempt ? `This is an estimate, not a quote or a bill. Only a dollar limit (when set) and the free trial's ${money(trialCeil)} limit per scan stop a run, and only for the model requests dazl sends.` : 'This is an estimate, not a quote or a bill. Only the dollar limit (when set) stops a run, and only for the model requests dazl sends.',
    // #1095: a refused trial run is not paid by anyone: never claim the trial pays for it
    ...(i.payer === 'trial' && !trialWhy ? [trialExempt ? 'This run is paid by dazl, not billed to you.' : 'This run is paid by the shared free trial, not billed to you; the trial allows 3 scans per account.'] : []),
    ...(unpriced.length ? [`Not priced, so not in the total: ${unpriced.join(', ')}.`] : []),
  ]
  // #1319: a trial's guard stops each scan at the trial reserve (runner.ts guardMax): that is the run's limit on screen
  const runShown = Math.min(runMax, trialCeil ?? Infinity), trialRun = trialCeil !== null && remaining !== null && trialCeil < remaining
  const cap = { max_usd: Number.isFinite(dayCapShown) ? dayCapShown : null, reserved_usd: reserved, remaining_usd: trialRun ? trialCeil : remaining, binding: trialRun ? 'run' as const : binding, run_max_usd: Number.isFinite(runShown) ? runShown : null, capped_total: cappedTotal, month_cap_usd: monthCap, month_reserved_usd: monthReserved, unknown }
  const verdict = { ok, reason, message, change, warning, ...(trialRefusalWhy ? { trial_refusal: trialRefusalWhy } : {}) }
  // The confirmation covers everything the person was shown and agreed to: WHO PAYS (own key vs the shared trial), every row (what it is, its units, price, whether the cap bounds it, and its
  // note: on/off), the totals, the unpriced list, and the cap with the reserved and remaining room, plus the verdict with its warning and what to change. If any of it differs when the run is
  // submitted - the payer switched, other runs reserved more of the limit, a new warning appeared - the old confirmation no longer matches and the person must confirm again.
  const r4 = (n: number | null) => (n === null ? null : Math.round(n * 1e4) / 1e4)
  const ack = createHash('sha256').update(JSON.stringify({
    payer: i.payer, model,
    rows: rows.map(r => [r.id, r.kind, r.capped, r.units, r.unit_usd, r.usd && { min: r4(r.usd.min), max: r4(r.usd.max) }, r.note]),
    total: { min: r4(total.min), max: r4(total.max) }, unpriced,
    cap: { max: cap.max_usd, run: r4(cap.run_max_usd), binding: cap.binding, reserved: r4(cap.reserved_usd), remaining: r4(cap.remaining_usd), month: cap.month_cap_usd, month_reserved: r4(cap.month_reserved_usd), unknown: cap.unknown, capped_total: { min: r4(cappedTotal.min), max: r4(cappedTotal.max) }, ...(trialCeil !== null ? { trial: r4(trialCeil) } : {}) },
    verdict,
  })).digest('hex').slice(0, 16)
  // Never beside a trial refusal: "$1.00 left" next to "your company already had its free trial" (or "$0.40 left" next to "all 3 free scans used") contradicts the block.
  const a = i.payer === 'trial' && !trialWhy && !trialExempt ? i.trialAllowance : null
  const trial_allowance = a && Number.isFinite(a.left_usd) && Number.isFinite(a.total_usd) && a.total_usd > 0 && a.left_usd >= 0 && a.left_usd <= a.total_usd ? { left_usd: a.left_usd, total_usd: a.total_usd } : null
  return { rows, total, unpriced, assumptions, payer: i.payer, cap, verdict, ack, ...(trial_allowance ? { trial_allowance } : {}), ...(trialCeil !== null ? { trial_scan_cap_usd: trialCeil } : {}), ...(trialExempt ? { trial_exempt: true } : {}) }
}
