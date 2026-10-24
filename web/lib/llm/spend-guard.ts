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
  private cost(model: string | undefined, promptBytes: number, maxOut: number): number {
    const p = model ? PRICES_USD_PER_M[model] : undefined
    if (!p) throw new SpendRefused('model_unpriced')
    return ((promptBytes + INPUT_MARGIN_TOKENS) * p.in + maxOut * p.out) / 1e6
  }
  check(model: string | undefined, promptBytes: number, maxOut: number): void {
    if (!(this.reservedUsd + this.cost(model, promptBytes, maxOut) <= this.limitUsd)) throw new SpendRefused('over_limit')
  }
  reserve(model: string | undefined, promptBytes: number, maxOut: number): void {
    this.check(model, promptBytes, maxOut)
    this.reservedUsd += this.cost(model, promptBytes, maxOut); this.calls++
  }
}

// One pool per owner for the life of the process: every job of that owner draws on the same limit, so a second job, a
// retry or a re-claimed attempt cannot spend it again. A process restart starts a new pool, so do not restart during a
// budgeted test.
const pools = new Map<string, SpendGuard>()
export function ownerPool(owner: string, limitUsd: number): SpendGuard {
  const g = pools.get(owner)
  if (g) { g.limitUsd = Math.min(g.limitUsd, limitUsd); return g }
  const n = new SpendGuard(limitUsd); pools.set(owner, n); return n
}
export function resetSpendPools(): void { pools.clear() }

export function reserveAll(guards: SpendGuard[], model: string | undefined, promptBytes: number, maxOut: number): void {
  // check every guard before committing to any, so a refusal leaves no partial reservation
  for (const g of guards) g.check(model, promptBytes, maxOut)
  for (const g of guards) g.reserve(model, promptBytes, maxOut)
}

// Anthropic's free token-count request (https://docs.anthropic.com/en/docs/build-with-claude/token-counting): no inference,
// own rate limit. The page calls the result an estimate that can differ "by a small amount", so the reservation uses
// COUNT_FACTOR on top of it. That factor is a chosen assumption, not a documented bound. Any failure refuses the call.
export const COUNT_FACTOR = 1.2
export type TokenCounter = (apiKey: string, model: string, prompt: string, fetchImpl?: typeof fetch) => Promise<number>
export const anthropicCountTokens: TokenCounter = async (apiKey, model, prompt, fetchImpl = fetch) => {
  let res: Response
  try {
    res = await fetchImpl('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(20_000),
    })
  } catch { throw new SpendRefused('count_failed') }
  if (!res.ok) throw new SpendRefused('count_failed')
  try {
    const n = ((await res.json()) as { input_tokens?: unknown }).input_tokens
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n
  } catch { /* falls through */ }
  throw new SpendRefused('count_failed')
}

export function guardProvider(p: Provider, gs: SpendGuard | SpendGuard[], count?: TokenCounter): Provider {
  const g = Array.isArray(gs) ? gs : [gs]
  const inputTokens = async (k: string, prompt: string, f?: typeof fetch) => {
    if (!count) return Buffer.byteLength(prompt)
    const m = (() => { try { return p.configuredModel?.() } catch { return undefined } })()
    if (!m) throw new SpendRefused('model_unpriced')
    return Math.ceil((await count(k, m, prompt, f)) * COUNT_FACTOR)
  }
  const model = () => { try { return p.configuredModel?.() } catch { return undefined } }
  const out: Provider = {
    research: async () => { throw new SpendRefused('research_unbounded') },
    ...(p.configuredModel ? { configuredModel: () => p.configuredModel!() } : {}),
  }
  if (p.complete) out.complete = async (k, prompt, f, max = 10) => { reserveAll(g, model(), await inputTokens(k, prompt, f), max); return p.complete!(k, prompt, f, max) }
  if (p.completeDetailed) out.completeDetailed = async (k, prompt, f, max = 10) => { reserveAll(g, model(), await inputTokens(k, prompt, f), max); return p.completeDetailed!(k, prompt, f, max) }
  return out
}
