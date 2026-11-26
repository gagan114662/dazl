// The estimate for a scan REQUEST body: the same validation POST /api/scan applies to the budget and mode, the same payer
// decision (own key vs shared trial), and the same caps, so the estimate shown and the run that follows cannot disagree.
// Read-only: nothing is queued, counted or reserved.
import { cleanText } from '../validate.ts'
import { icpLoss, MAX_QUERY, normalizeIcp, type IcpLoss } from './icp.ts'
import { companyFirstDiscoveryEnabled } from '../company-first/product-discovery.ts'
import { normalizeScanBudget } from './run-budget.ts'
import { estimateRun, type RunEstimate } from './price-estimate.ts'
import { isFirst5NativeSearchRequest, isManualNativeTargetRequest, QA_NATIVE_WEB_SEARCH_OWN_KEY_MESSAGE, QA_SPEND_MAX_USD, isFirst5RequestMode, qaClaudeOnlyBudget, strictLocalTopologySupported } from './qa-provider-policy.ts'
import { HARD_CAP_USD, scanCapConfig, scanModelPrice } from './spend-cap.ts'
import { anthropicProvider, openaiProvider } from '../llm/provider.ts'
import { accountLimits, ownerLimits, PENDING_STALE_S, periodOf, scanPoolRows } from '../llm/spend-pool.ts'
import type { Db } from '../db/client.ts'
import { usableVendor } from '../paid-vendors.ts'
import { trialCaps, trialQaExemptAccount, trialTinyfishPrices } from '../billing/trial-budget.ts'
import { salesHiringRequired } from './sales-hiring-required.ts'
import { firstPlayPeopleCap, peopleSearchEnabled } from '../people/people-search.ts'
import { effectiveFirstPlayLeadCaps, firstPlayLeadCaps } from '../people/first-play-cap.ts'
import { limits as tinyfishLimits, tinyfishEnabled } from '../search/tinyfish.ts'

export type EstimateResult = { ok: true; estimate: RunEstimate } | { ok: false; status: number; error: string; detail?: string; message?: string; loss?: IcpLoss[] }
// What the owner's shared spend pools (tenant_spend_pools, the same store the guard reserves in) have reserved this UTC day and month, so the estimate agrees with the guard.
// A read failure is NOT zero: it is reported as unknown and the estimate refuses to be confirmed.
// A pending-settlement marker that is stale or marked failed means the pool refuses every reservation (unsettled); a
// fresh one is a call in flight, which a run waits for.
async function pools(db: Db, tenantId: string, now = Math.floor(Date.now() / 1000)): Promise<{ day: number; month: number; unknown: boolean; unsettled: boolean }> {
  try {
    const rows = await scanPoolRows(db, tenantId, now), at = (w: 'day' | 'month') => Number(rows.find(r => r.period === periodOf(w, now))?.reserved_usd ?? 0)
    const day = at('day'), month = at('month')
    const unsettled = rows.some(r => r.period.startsWith('p:') && Number(r.updated_at) <= now - PENDING_STALE_S)
    if (!Number.isFinite(day) || !Number.isFinite(month)) return { day: 0, month: 0, unknown: true, unsettled }
    return { day, month, unknown: false, unsettled }
  } catch { return { day: 0, month: 0, unknown: true, unsettled: false } }
}
// The model the tenant's own key would run (the runner's pickVendor choice), for the pre-launch limit check; null with no usable key.
// #1665: the same gate as pickVendor (lib/paid-vendors.ts usableVendor). It read the newest key unchecked, so a workspace with an
// Anthropic key and a newer OpenAI key was estimated against the OpenAI model while the runner used the Anthropic key.
export async function keyedModel(db: Db, tenantId: string, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  const rows = await db.all<{ vendor: string }>(`SELECT vendor FROM tenant_llm_keys WHERE tenant_id = ? ORDER BY created_at DESC${db.kind === 'sqlite' ? ', rowid DESC' : ''}`, [tenantId]).catch(() => [] as { vendor: string }[])
  const r = usableVendor(rows, env)
  return r?.vendor === 'openai' ? openaiProvider.configuredModel!() : r?.vendor === 'anthropic' ? anthropicProvider.configuredModel!() : null
}
export async function estimateForBody(body: unknown, ctx: { db: Db; tenantId: string; hasOwnKey: boolean; /** why this keyless account would be refused a trial run now (the estimate route reads it; POST /api/scan refuses at confirm time on its own) */ trialRefusal?: string | null; trialUsed?: number | null; /** what is left of this trial account's dollar allowance (display only) */ trialAllowance?: { left_usd: number; total_usd: number } | null; enrichmentVendors: string[]; /** the model the run's own key would use (provider.configuredModel()), when known */ model?: string | null }): Promise<EstimateResult> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const first5 = isFirst5RequestMode(b.mode)
  if (b.mode !== undefined && !first5) return { ok: false, status: 400, error: 'unknown_mode' }
  const qaNativeWebSearch = isFirst5NativeSearchRequest(b.mode, b.budget)
  const supplied = 'budget' in b
  if (first5 && supplied && !qaNativeWebSearch) return { ok: false, status: 400, error: 'invalid_budget', detail: 'mode first5 only accepts the explicit Claude Web Search option' }
  const nb = first5 ? normalizeScanBudget({ first5: true, paid_fallback: false, credit_enrichment: false }, true) : normalizeScanBudget(supplied ? b.budget : undefined, supplied)
  if (!nb.ok) return { ok: false, status: 400, error: 'invalid_budget', detail: nb.error }
  const query = cleanText(b.query, MAX_QUERY)
  const companyFirst = companyFirstDiscoveryEnabled({ user_id: ctx.tenantId, funded_by: 'user', query }, process.env.DAZL_COMPANY_FIRST_TENANT_ID)
  const qaClaudeOnly = !companyFirst && qaNativeWebSearch
  if (qaClaudeOnly && !strictLocalTopologySupported(ctx.db.kind)) return { ok: false, status: 503, error: 'qa_isolation_unavailable', message: 'This deployment cannot isolate the Claude-only worker. Nothing was started.' }
  if ((qaNativeWebSearch || companyFirst) && (!ctx.hasOwnKey || ctx.model !== anthropicProvider.configuredModel!())) return { ok: false, status: 409, error: 'qa_search_requires_own_key', message: QA_NATIVE_WEB_SEARCH_OWN_KEY_MESSAGE }
  const qaCap = qaClaudeOnly || companyFirst ? scanCapConfig() : null
  if (qaCap && !qaCap.ok) return { ok: false, status: 503, error: 'spend_config_invalid', detail: 'The scan cap cannot be verified. Nothing was started.' }
  const budget = companyFirst ? { ...nb.budget, paid_fallback: false as const, credit_enrichment: false as const,
    max_usd: Math.min(nb.budget?.max_usd ?? QA_SPEND_MAX_USD, QA_SPEND_MAX_USD, qaCap?.capUsd ?? 0) }
    : qaClaudeOnly ? { ...JSON.parse(qaClaudeOnlyBudget(nb.value, qaNativeWebSearch)), max_usd: Math.min(nb.budget?.max_usd ?? Infinity, qaCap?.capUsd ?? 0) } : nb.budget
  if (qaClaudeOnly && query.length < 3) return { ok: false, status: 400, error: 'invalid_mode', detail: 'Claude-only first play requires a search query.' }
  // #917: the same refusal POST /api/scan applies, so a profile is never priced and confirmed only to be refused at run time.
  const lost = b.icp && typeof b.icp === 'object' ? icpLoss(b.icp) : []
  if (lost.length) return { ok: false, status: 400, error: 'profile_lossy', message: 'Part of this profile would be cut or ignored. Fix the listed fields - nothing was dropped silently.', loss: lost }
  const icp = b.icp === undefined || b.icp === null ? null : normalizeIcp(b.icp)
  if (isManualNativeTargetRequest(b.mode, b.budget) && (!icp || 'reviewed' in b || 'research_decisions' in b)) {
    return { ok: false, status: 400, error: 'invalid_target_review', message: 'Confirm the target for this search separately from saved research decisions. Nothing started.' }
  }
  const pool = await pools(ctx.db, ctx.tenantId)
  // The model the run will really call, so the rows, the total, the verdict and the confirmation price THAT model (#851): an
  // own key's configured model (keyedModel), or for a trial run the operator's Anthropic key (lib/scan/trial.ts operatorKey is
  // Anthropic-only). An own key whose model could not be read is unknown, never silently the default model.
  const own = ctx.hasOwnKey ? (typeof ctx.model === 'string' && ctx.model.trim() ? ctx.model : null) : null
  const anthropicModel = anthropicProvider.configuredModel!()
  // Every model call of a run under a limit goes through a guard that prices it: the run's max_usd, the owner's day/month
  // pool, and ALWAYS for a trial run (runner.ts: the trial's reserve is the job guard's limit).
  // An account the operator named has its own day/month pool guard (and the other window at the deployment default, #847).
  // Every other account's caps (#846/#847) are reserved at the transport (runner.ts runWithScanSpend: accountLimits(owner)). #1319: the
  // estimate shows the SAME day/month caps for every account, read from the same source (accountLimits), so the screen's numbers are
  // the ones that stop a run.
  const named = ownerLimits(ctx.tenantId), caps = accountLimits(ctx.tenantId)
  // #1319: the job guard's per-scan cap (spend-cap.ts effectiveCapUsd). An unreadable cap refuses every paid call of the run, so nothing is priced.
  const scanCap = scanCapConfig()
  if (!scanCap.ok) return { ok: false, status: 503, error: 'spend_config_invalid', detail: 'The scan cap cannot be verified. Nothing was started.' }
  const limited = !ctx.hasOwnKey || budget?.max_usd != null || named !== null
  // The same test the runner applies (runner.ts discoverLaneEnabled and its room check): an ordinary request on an Anthropic key, or a
  // free-trial run whose reserve covers one; a request that set its own limit under a full run gets the smaller budget.
  const trialReserve = ctx.hasOwnKey ? null : trialCaps()?.reserveUsd ?? null
  const trialExempt = !ctx.hasOwnKey && await trialQaExemptAccount(ctx.db, ctx.tenantId).catch(() => false)
  const laneOn = process.env.DAZL_DISCOVER_LANE !== '0' && typeof query === 'string' && query.trim().length >= 3 && (ctx.hasOwnKey ? /^claude/i.test(own ?? '') : (trialReserve ?? 0) >= 0.3)
  const laneRoom = Math.min(trialReserve ?? Infinity, typeof budget?.max_usd === 'number' ? budget.max_usd : Infinity)
  const discoverLane = !laneOn || laneRoom < 0.3 ? null : laneRoom < 0.75 ? 'tiny' as const : laneRoom < 1.5 ? 'small' as const : 'full' as const
  const estimate = estimateRun({
    discoverLane,
    budget, qaClaudeOnly, qaNativeWebSearch, companyFirst, payer: ctx.hasOwnKey ? 'you' : 'trial', enrichmentVendors: ctx.enrichmentVendors,
    model: ctx.hasOwnKey ? own ?? undefined : anthropicModel, modelUnknown: ctx.hasOwnKey && own === null, limited, pricedAlternative: anthropicModel, priceModel: scanModelPrice,
    hiringRequest: salesHiringRequired(query, icp ? JSON.stringify(icp) : null),
    // #1037: the people step the run itself will take (runner.ts: off when people search cannot run, else the first-play cap).
    firstPlayPeopleSearches: peopleSearchEnabled() ? firstPlayPeopleCap() : 0,
    trialTinyfishSearchUsd: ctx.hasOwnKey ? null : (trialCaps() ? trialTinyfishPrices()?.searchUsd : null) ?? null,
    trialTinyfishFetchUsd: ctx.hasOwnKey ? null : (trialCaps() ? trialTinyfishPrices()?.fetchUsd : null) ?? null,
    firstPlayLead: tinyfishEnabled() ? effectiveFirstPlayLeadCaps(firstPlayLeadCaps(), tinyfishLimits()) : { searches: 0, fetches: 0 },
    reservedUsd: pool.day, reservedMonthUsd: pool.month, poolUnknown: pool.unknown, poolUnsettled: pool.unsettled,
    trialReserveUsd: trialReserve, trialExempt,
    trialRefusal: ctx.hasOwnKey ? null : ctx.trialRefusal ?? null, trialUsed: ctx.hasOwnKey ? null : ctx.trialUsed ?? null, trialAllowance: ctx.hasOwnKey ? null : ctx.trialAllowance ?? null,
    ownerCapUsd: caps.day, ownerMonthCapUsd: caps.month, ownerNamed: named !== null, scanCapUsd: Math.min(scanCap.capUsd, HARD_CAP_USD),
  })
  // model_unpriced (a limited run whose model its guard cannot price) is decided inside estimateRun, so the confirmation covers it.
  return { ok: true, estimate }
}
