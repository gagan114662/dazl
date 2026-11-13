// The estimate for a scan REQUEST body: the same validation POST /api/scan applies to the budget and mode, the same payer
// decision (own key vs shared trial), and the same caps, so the estimate shown and the run that follows cannot disagree.
// Read-only: nothing is queued, counted or reserved.
import { cleanText } from '../validate.ts'
import { icpLoss, MAX_QUERY, normalizeIcp, type IcpLoss } from './icp.ts'
import { normalizeScanBudget } from './run-budget.ts'
import { estimateRun, type RunEstimate } from './price-estimate.ts'
import { ownerMaxUsd } from './runner.ts'
import { scanModelPrice } from './spend-cap.ts'
import { anthropicProvider, openaiProvider } from '../llm/provider.ts'
import { ownerLimits, ownerSetting, PENDING_STALE_S, periodOf, poolRows } from '../llm/spend-pool.ts'
import type { Db } from '../db/client.ts'
import { trialCaps } from '../billing/trial-budget.ts'
import { salesHiringRequired } from './sales-hiring-required.ts'
import { firstPlayPeopleCap, peopleSearchEnabled } from '../people/people-search.ts'

export type EstimateResult = { ok: true; estimate: RunEstimate } | { ok: false; status: number; error: string; detail?: string; message?: string; loss?: IcpLoss[] }
// What the owner's shared spend pools (tenant_spend_pools, the same store the guard reserves in) have reserved this UTC day and month, so the estimate agrees with the guard.
// A read failure is NOT zero: it is reported as unknown and the estimate refuses to be confirmed.
// A pending-settlement marker that is stale or marked failed means the pool refuses every reservation (unsettled); a
// fresh one is a call in flight, which a run waits for.
async function pools(db: Db, tenantId: string, now = Math.floor(Date.now() / 1000)): Promise<{ day: number; month: number; unknown: boolean; unsettled: boolean }> {
  try {
    const rows = await poolRows(db, tenantId), at = (w: 'day' | 'month') => Number(rows.find(r => r.period === periodOf(w, now))?.reserved_usd ?? 0)
    const day = at('day'), month = at('month')
    const unsettled = rows.some(r => r.period.startsWith('p:') && Number(r.updated_at) <= now - PENDING_STALE_S)
    if (!Number.isFinite(day) || !Number.isFinite(month)) return { day: 0, month: 0, unknown: true, unsettled }
    return { day, month, unknown: false, unsettled }
  } catch { return { day: 0, month: 0, unknown: true, unsettled: false } }
}
// The model the tenant's own newest key would run (the runner's pickVendor choice), for the pre-launch limit check; null with no key.
export async function keyedModel(db: Db, tenantId: string): Promise<string | null> {
  const r = await db.get<{ vendor: string }>('SELECT vendor FROM tenant_llm_keys WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1', [tenantId]).catch(() => undefined)
  return r?.vendor === 'openai' ? openaiProvider.configuredModel!() : r?.vendor === 'anthropic' ? anthropicProvider.configuredModel!() : null
}
export async function estimateForBody(body: unknown, ctx: { db: Db; tenantId: string; hasOwnKey: boolean; /** why this keyless account would be refused a trial run now (the estimate route reads it; POST /api/scan refuses at confirm time on its own) */ trialRefusal?: string | null; trialUsed?: number | null; /** what is left of this trial account's dollar allowance (display only) */ trialAllowance?: { left_usd: number; total_usd: number } | null; enrichmentVendors: string[]; /** the model the run's own key would use (provider.configuredModel()), when known */ model?: string | null }): Promise<EstimateResult> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const first5 = b.mode === 'first5'
  if (b.mode !== undefined && b.mode !== 'first5') return { ok: false, status: 400, error: 'unknown_mode' }
  const supplied = 'budget' in b
  if (first5 && supplied) return { ok: false, status: 400, error: 'invalid_budget', detail: 'mode first5 takes no budget' }
  const nb = first5 ? normalizeScanBudget({ first5: true, paid_fallback: false, credit_enrichment: false }, true) : normalizeScanBudget(supplied ? b.budget : undefined, supplied)
  if (!nb.ok) return { ok: false, status: 400, error: 'invalid_budget', detail: nb.error }
  const query = cleanText(b.query, MAX_QUERY)
  // #917: the same refusal POST /api/scan applies, so a profile is never priced and confirmed only to be refused at run time.
  const lost = b.icp && typeof b.icp === 'object' ? icpLoss(b.icp) : []
  if (lost.length) return { ok: false, status: 400, error: 'profile_lossy', message: 'Part of this profile would be cut or ignored. Fix the listed fields - nothing was dropped silently.', loss: lost }
  const icp = b.icp === undefined || b.icp === null ? null : normalizeIcp(b.icp)
  const pool = await pools(ctx.db, ctx.tenantId)
  // The model the run will really call, so the rows, the total, the verdict and the confirmation price THAT model (#851): an
  // own key's configured model (keyedModel), or for a trial run the operator's Anthropic key (lib/scan/trial.ts operatorKey is
  // Anthropic-only). An own key whose model could not be read is unknown, never silently the default model.
  const own = ctx.hasOwnKey ? (typeof ctx.model === 'string' && ctx.model.trim() ? ctx.model : null) : null
  const anthropicModel = anthropicProvider.configuredModel!()
  // Every model call of a run under a limit goes through a guard that prices it: the run's max_usd, the owner's day/month
  // pool, and ALWAYS for a trial run (runner.ts: the trial's reserve is the job guard's limit).
  const limited = !ctx.hasOwnKey || nb.budget?.max_usd != null || ownerLimits(ctx.tenantId) !== null
  const estimate = estimateRun({
    budget: nb.budget, payer: ctx.hasOwnKey ? 'you' : 'trial', enrichmentVendors: ctx.enrichmentVendors,
    model: ctx.hasOwnKey ? own ?? undefined : anthropicModel, modelUnknown: ctx.hasOwnKey && own === null, limited, pricedAlternative: anthropicModel, priceModel: scanModelPrice,
    hiringRequest: salesHiringRequired(query, icp ? JSON.stringify(icp) : null),
    // #1037: the people step the run itself will take (runner.ts: off when people search cannot run, else the first-play cap).
    firstPlayPeopleSearches: peopleSearchEnabled() ? firstPlayPeopleCap() : 0,
    trialTinyfishSearchUsd: ctx.hasOwnKey ? null : trialCaps()?.tinyfishSearchUsd ?? null,
    trialTinyfishFetchUsd: ctx.hasOwnKey ? null : trialCaps()?.tinyfishFetchUsd ?? null,
    reservedUsd: pool.day, reservedMonthUsd: pool.month, poolUnknown: pool.unknown, poolUnsettled: pool.unsettled,
    trialReserveUsd: ctx.hasOwnKey ? null : trialCaps()?.reserveUsd ?? null,
    trialRefusal: ctx.hasOwnKey ? null : ctx.trialRefusal ?? null, trialUsed: ctx.hasOwnKey ? null : ctx.trialUsed ?? null, trialAllowance: ctx.hasOwnKey ? null : ctx.trialAllowance ?? null,
    ownerCapUsd: ownerMaxUsd(ctx.tenantId), ownerMonthCapUsd: ownerSetting('DAZL_OWNER_MONTH_MAX_USD_USERS', ctx.tenantId, process.env),
  })
  // model_unpriced (a limited run whose model its guard cannot price) is decided inside estimateRun, so the confirmation covers it.
  return { ok: true, estimate }
}
