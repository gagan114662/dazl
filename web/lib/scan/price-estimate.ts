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
  // #1157: this account's web search allowance left today (lib/search/tinyfish.ts tenantAllowanceLeft). Display only, like
  // trial_allowance: not part of `ack`, never a block (the run's own gate refuses at the cap); `low` shows a warning before confirm.
  search_allowance?: { left: number; daily: number; low: boolean } | null
}
export interface EstimateInput {
  budget: RunBudget | null
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
        ? `Company-first discovery makes up to ${calls} guarded Anthropic Sonnet call(s), at most ${search.maxSearches} searches per call. Includes ${CLAUDE_COMPANY_FIRST_ASSUMED_INPUT_PER_SEARCH.toLocaleString('en-US')} assumed result input tokens per search plus an estimated prompt and capped output. Actual billed search-result input can exceed this soft estimate.`
        : 'Optional, one Anthropic Sonnet call with at most two searches. Includes 25,000 assumed input tokens per search, an estimated prompt and up to 3,000 output tokens. Actual billed search-result input can exceed this soft estimate.',
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
  const change: string[] = []
  let ok = true, reason: Verdict['reason'] = null, message = 'Within your limit.', warning: string | null = null, trialRefusalWhy: string | null = null
  const trialWhy = i.payer === 'trial' && typeof i.trialRefusal === 'string' && TRIAL_BLOCKS.has(i.trialRefusal) ? i.trialRefusal : null
  if (trialWhy) {
    // attempts_cap means all of them are used; any other reason states the account's real count (0 when unknown/fresh), never "3 of 3".
    const used = trialWhy === 'attempts_cap' ? FREE_TRIAL_SCANS : Math.min(FREE_TRIAL_SCANS, Math.max(0, Math.trunc(Number(i.trialUsed) || 0)))
    const c = trialCopy({ funded: false, remaining: FREE_TRIAL_SCANS - used, cap: FREE_TRIAL_SCANS, blocked: trialWhy })
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
        ? `Blocked: the model requests alone are expected to cost at least ${money(cappedTotal.min)} but the free trial stops each scan at ${money(eff)}.`
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
        else if (cappedTotal.min > trialRoom) change.push(`The free trial stops each scan at ${money(trialRoom)}.`)
        else if (!personBinds || need > scanCeil) change.push(`Each scan is capped at ${money(Number.isFinite(scanCeil) ? scanCeil : runMax)}.`)
        else if (!native) change.push(`Raise the dollar limit to at least ${money(need)} (about ${money(cappedTotal.max + shownReserved)} covers the worst case).`)
      }
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
    native ? 'This is a soft estimate, not a quote, a bill, or a hard billing limit.' : trialCeil !== null ? `This is an estimate, not a quote or a bill. Only a dollar limit (when set) and the free trial's ${money(trialCeil)} limit per scan stop a run, and only for the model requests dazl sends.` : 'This is an estimate, not a quote or a bill. Only the dollar limit (when set) stops a run, and only for the model requests dazl sends.',
    // #1095: a refused trial run is not paid by anyone: never claim the trial pays for it
    ...(i.payer === 'trial' && !trialWhy ? ['This run is paid by the shared free trial, not billed to you; the trial allows 3 scans per account.'] : []),
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
  const a = i.payer === 'trial' && !trialWhy ? i.trialAllowance : null
  const trial_allowance = a && Number.isFinite(a.left_usd) && Number.isFinite(a.total_usd) && a.total_usd > 0 && a.left_usd >= 0 && a.left_usd <= a.total_usd ? { left_usd: a.left_usd, total_usd: a.total_usd } : null
  return { rows, total, unpriced, assumptions, payer: i.payer, cap, verdict, ack, ...(trial_allowance ? { trial_allowance } : {}), ...(trialCeil !== null ? { trial_scan_cap_usd: trialCeil } : {}) }
}

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
export function customerView(est: Pick<RunEstimate, 'rows' | 'total' | 'assumptions' | 'payer'> & { cap?: Pick<RunEstimate['cap'], 'capped_total'>; trial_scan_cap_usd?: number | null }): CustomerView {
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
  return { rows, total, capped_total: clampToCap(est.cap?.capped_total ?? est.total, cap), trial_cap_line: trialCapLine(cap), assumptions }
}
// #1319: a free-trial scan's per-scan cap, when the estimate carries a usable one (own-key runs never have one). Shared by
// the cost box before the run and the run page after it, so neither shows a dollar amount above the cap.
export function trialScanCap(est: { payer?: string; trial_scan_cap_usd?: number | null }): number | null {
  const c = est.trial_scan_cap_usd
  return est.payer === 'trial' && typeof c === 'number' && Number.isFinite(c) && c > 0 ? c : null
}
export const clampToCap = (r: Range, cap: number | null): Range => cap === null ? r : { min: Math.min(r.min, cap), max: Math.min(r.max, cap) }
export const trialCapLine = (cap: number | null): string | null => cap === null ? null : `Free trial scans stop at ${money(cap)}.`

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
  let noFigure = false   // PM 2026-11-22: the model cost cannot be priced - the line shows the final cost or nothing, never a hedge
  if (settled !== null) {
    const range = within === 'unknown' ? '' : ` (${within === 'within' ? 'inside the range' : within === 'under' ? 'below the range' : 'above the range'})`
    summary = `Actual model cost ${money(settled)}, the sum of each call's settled cost (${served.join(', ')}), against the model-request estimate of ${money(modelEst.min)}-${money(modelEst.max)}${range}. Not an invoice.`
  }
  else if (usd !== null) {
    const range = within === 'unknown' ? '' : ` (${within === 'within' ? 'inside the range' : within === 'under' ? 'below the range' : 'above the range'})`
    const cacheNote = cacheRecorded ? '' : '; cache token usage was not recorded, so this is the recorded-token component, not the full cost'
    summary = `Actual model cost ${complete ? '' : 'at least '}${money(usd)} from the tokens the provider reported${cacheNote}, against the model-request estimate of ${money(modelEst.min)}-${money(modelEst.max)}${range}. Not an invoice.`
  }
  else if (mixed && reqs !== null && reqs > 0 && a.inputTokens !== null && a.outputTokens !== null) { noFigure = true; summary = `${reqs} model call${reqs === 1 ? '' : 's'} recorded (${a.inputTokens} input / ${a.outputTokens} output tokens) across more than one served model (${served.join(', ')}); the stored sums cannot be priced as one total - the per-call settled costs are in the spend ledger. The actual cost here is unknown, not $0. The model-request estimate was ${money(modelEst.min)}-${money(modelEst.max)}.` }
  else if (reqs !== null && reqs > 0 && a.inputTokens !== null && a.outputTokens !== null) { noFigure = true; summary = `${reqs} model call${reqs === 1 ? '' : 's'} recorded (${reqsWithTokens !== null && reqsWithTokens < reqs ? `tokens reported for ${reqsWithTokens}: ` : ''}${a.inputTokens} input / ${a.outputTokens} output tokens), but no USD cost could be settled (${a.model || served.length ? 'the served model has no listed price' : 'no model id was recorded'}) - the actual cost is unknown, not $0. The model-request estimate was ${money(modelEst.min)}-${money(modelEst.max)}.` }
  else if (reqs !== null && reqs > 0) { noFigure = true; summary = `${reqs} model call${reqs === 1 ? '' : 's'} recorded, but the provider reported no token usage for them, so the actual cost is unknown - not $0. The model-request estimate was ${money(modelEst.min)}-${money(modelEst.max)}.` }
  // #1168: nothing was sent, so nothing was charged: say so, never "unknown" and never "recorded"
  else if ((a.refusedBeforeSending ?? 0) > 0) summary = `No model call was made: ${a.refusedBeforeSending} ${a.refusedBeforeSending === 1 ? 'was' : 'were'} refused by a spending limit before sending, so the model cost is $0. The model-request estimate was ${money(modelEst.min)}-${money(modelEst.max)}.`
  else summary = `Actual model cost was not recorded (model-request estimate ${money(modelEst.min)}-${money(modelEst.max)}).`
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
  if (noFigure) summary = final !== null ? `Final cost ${money(final)}.` : ''
  else if (mixed && final !== null && held === 0) summary = `Final cost ${money(final)}.`
  else if (final !== null && held !== null) summary = `Final cost ${money(final)}${heldNote}. ${summary}`
  else if (capRes !== null && capRes > 0) summary += ` Reserved under this run's spend cap: ${money(capRes)} (a reservation, not a settled charge).`
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
  return est.payer === 'trial' ? 'Paid by the shared free trial, not billed to you.' : 'Billed to your own keys and plans.'
}

// #1157: shown BEFORE confirm when this account has little web search left today, so a run the allowance would stop is not started blind
export const searchAllowanceLine = (a: { left: number; daily: number }) => a.left === 0
  ? `Your web search allowance for today is used up (${a.daily} a day). This run would search only the free news source and is likely to find nothing. It resets at 00:00 UTC.`
  : `Only ${a.left} of your ${a.daily} web searches and page reads are left today, about one run. This run may stop early when they run out; the allowance resets at 00:00 UTC.`
