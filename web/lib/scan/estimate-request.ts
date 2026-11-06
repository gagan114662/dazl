// The estimate for a scan REQUEST body: the same validation POST /api/scan applies to the budget and mode, the same payer
// decision (own key vs shared trial), and the same caps, so the estimate shown and the run that follows cannot disagree.
// Read-only: nothing is queued, counted or reserved.
import { cleanText } from '../validate.ts'
import { MAX_QUERY, normalizeIcp } from './icp.ts'
import { normalizeScanBudget } from './run-budget.ts'
import { estimateRun, type RunEstimate } from './price-estimate.ts'
import { ownerMaxUsd } from './runner.ts'
import { anthropicProvider, openaiProvider } from '../llm/provider.ts'
import { priceOf } from '../llm/spend-guard.ts'
import { ownerLimits, ownerSetting, PENDING_STALE_S, periodOf, poolRows } from '../llm/spend-pool.ts'
import type { Db } from '../db/client.ts'
import { salesHiringRequired } from './sales-hiring-required.ts'

export type EstimateResult = { ok: true; estimate: RunEstimate } | { ok: false; status: number; error: string; detail?: string }
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
export async function estimateForBody(body: unknown, ctx: { db: Db; tenantId: string; hasOwnKey: boolean; enrichmentVendors: string[]; /** the model the run's own key would use (provider.configuredModel()), when known */ model?: string | null }): Promise<EstimateResult> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const first5 = b.mode === 'first5'
  if (b.mode !== undefined && b.mode !== 'first5') return { ok: false, status: 400, error: 'unknown_mode' }
  const supplied = 'budget' in b
  if (first5 && supplied) return { ok: false, status: 400, error: 'invalid_budget', detail: 'mode first5 takes no budget' }
  const nb = first5 ? normalizeScanBudget({ first5: true, paid_fallback: false, credit_enrichment: false }, true) : normalizeScanBudget(supplied ? b.budget : undefined, supplied)
  if (!nb.ok) return { ok: false, status: 400, error: 'invalid_budget', detail: nb.error }
  const query = cleanText(b.query, MAX_QUERY)
  const icp = b.icp === undefined || b.icp === null ? null : normalizeIcp(b.icp)
  const pool = await pools(ctx.db, ctx.tenantId)
  const estimate = estimateRun({
    budget: nb.budget, payer: ctx.hasOwnKey ? 'you' : 'trial', enrichmentVendors: ctx.enrichmentVendors,
    hiringRequest: salesHiringRequired(query, icp ? JSON.stringify(icp) : null),
    reservedUsd: pool.day, reservedMonthUsd: pool.month, poolUnknown: pool.unknown, poolUnsettled: pool.unsettled,
    ownerCapUsd: ownerMaxUsd(ctx.tenantId), ownerMonthCapUsd: ownerSetting('DAZL_OWNER_MONTH_MAX_USD_USERS', ctx.tenantId, process.env),
  })
  // A run under a spending limit (this run's max_usd, or the owner's day/month pool) only reserves for a model with a listed price; any other model
  // is refused at its first call (model_unpriced). Say so BEFORE launch, instead of letting the run start and stop.
  const limited = nb.budget?.max_usd != null || ownerLimits(ctx.tenantId) !== null
  if (ctx.hasOwnKey && limited && ctx.model && !priceOf(ctx.model)) {
    estimate.verdict = {
      ok: false, reason: 'model_unpriced', warning: null,
      message: `Your key's model (${ctx.model}) has no listed price in dazl yet, so a run under a spending limit cannot reserve for it and would stop at its first model call. Nothing was started or charged.`,
      change: ['Run without a spending limit (remove max_usd; a workspace daily/monthly limit also applies if set)', 'Or use an Anthropic key (claude-sonnet-4-5 is priced)'],
    }
  }
  return { ok: true, estimate }
}
