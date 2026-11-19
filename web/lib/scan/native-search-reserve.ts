import { PooledGuard, reserveAllUsd, settleAll, SpendAccountingFailed, SpendRefused, type SpendGuard } from '../llm/spend-guard.ts'
import { reserveScanSpend, spendAttemptUncertain } from './spend-cap.ts'

export const NATIVE_SEARCH_ESTIMATED_CEILING_USD = 3.50

// Native search is deliberately a separate soft-estimate lane. All existing reservation caps are kept, including
// the stricter statutory/configured job cap and the owner's day/month windows; no estimate is a provider billing limit.
export async function reserveNativeSearch(guards: SpendGuard[], usd: number, checkOwned: () => void) {
  if (!Number.isFinite(usd) || usd <= 0 || !guards.length) throw new SpendRefused('cost_invalid')
  if (usd > NATIVE_SEARCH_ESTIMATED_CEILING_USD) throw new SpendRefused('over_limit')
  checkOwned()
  const g = guards.map(x => {
    if (!(x instanceof PooledGuard) || x.trackPending) return x
    const tracked = new PooledGuard(x.pool, { trackPending: true })
    tracked.label = x.label
    return tracked
  })
  const held = await reserveAllUsd(g, usd)
  let transport
  try {
    checkOwned()
    transport = await reserveScanSpend('llm.anthropic.web_search', () => usd)
    if (!transport) throw new SpendRefused('no_spend_context')
  } catch (e) {
    try { await settleAll(g, -usd, 0, held) } catch {
      try { await settleAll(g, -usd, 0, held) } catch (failure) { throw new SpendAccountingFailed(failure) }
    }
    throw e
  }
  const stop = async () => {
    transport.uncertain()
    for (const x of guards) x.refused = true
    for (const [x, pending] of held.pending) await x.pool.markFailed(pending)
  }
  let finished = false
  const once = async (fn: () => Promise<void>) => {
    if (finished) return
    finished = true
    try { await fn() } catch (e) { await stop().catch(() => {}); throw new SpendAccountingFailed(e) }
  }
  return {
    async settle(actualUsd: number | null) {
      return once(async () => {
        if (actualUsd === null || !Number.isFinite(actualUsd) || actualUsd < 0) { await stop(); return }
        await transport.settle(actualUsd)
        await settleAll(g, actualUsd - usd, actualUsd, held)
        if (spendAttemptUncertain()) throw new SpendAccountingFailed(new Error('native search settlement unavailable'))
      })
    },
    async rejected(status: number) {
      return once(async () => {
        // Only the provider's authenticated, pre-generation rate-limit envelope takes the zero-usage path.
        // Other known refusals keep the estimate without blocking a later independent attempt.
        const actual = status === 429 ? 0 : null
        await transport.settle(actual)
        if (spendAttemptUncertain()) throw new SpendAccountingFailed(new Error('native search rejection settlement unavailable'))
        transport.rejected(status)
        await settleAll(g, actual === 0 ? -usd : 0, actual, held)
      })
    },
    async uncertain() { return once(stop) },
  }
}
