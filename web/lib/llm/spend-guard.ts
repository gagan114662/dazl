import type { Provider } from './provider.ts'

// A run-scoped spend guard. It RESERVES the worst case of every paid call before the call is made and refuses a call
// that would pass the limit. It is a bound from what the code sends and allows, not a bill:
//  - input is bounded by the prompt's UTF-8 byte length (a token is never less than one byte of text for these
//    tokenizers' purposes here: treated as an upper bound, stated as an assumption, not measured), plus a fixed margin;
//  - output is bounded by the max_tokens the call passes;
//  - only models with a known price are allowed; an unknown or unreadable model refuses everything;
//  - the web-search research call is refused: its search-result tokens are not bounded by anything dazl sends.
// Prices are USD per million tokens from the vendor's published page, keyed by the exact model id.
export const PRICES_USD_PER_M: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-5': { in: 3, out: 15 }, // https://docs.anthropic.com/en/docs/about-claude/pricing
}
export const INPUT_MARGIN_TOKENS = 1000

export class SpendRefused extends Error {
  reason: string
  constructor(reason: string) { super(`spend_refused:${reason}`); this.reason = reason }
}

export class SpendGuard {
  reservedUsd = 0
  calls = 0
  limitUsd: number
  constructor(limitUsd: number) { this.limitUsd = limitUsd }
  reserve(model: string | undefined, promptBytes: number, maxOut: number): void {
    const p = model ? PRICES_USD_PER_M[model] : undefined
    if (!p) throw new SpendRefused('model_unpriced')
    const cost = ((promptBytes + INPUT_MARGIN_TOKENS) * p.in + maxOut * p.out) / 1e6
    if (!(this.reservedUsd + cost <= this.limitUsd)) throw new SpendRefused('over_limit')
    this.reservedUsd += cost; this.calls++
  }
}

export function guardProvider(p: Provider, g: SpendGuard): Provider {
  const model = () => { try { return p.configuredModel?.() } catch { return undefined } }
  const out: Provider = {
    research: async () => { throw new SpendRefused('research_unbounded') },
    ...(p.configuredModel ? { configuredModel: () => p.configuredModel!() } : {}),
  }
  if (p.complete) out.complete = async (k, prompt, f, max = 10) => { g.reserve(model(), Buffer.byteLength(prompt), max); return p.complete!(k, prompt, f, max) }
  if (p.completeDetailed) out.completeDetailed = async (k, prompt, f, max = 10) => { g.reserve(model(), Buffer.byteLength(prompt), max); return p.completeDetailed!(k, prompt, f, max) }
  return out
}
