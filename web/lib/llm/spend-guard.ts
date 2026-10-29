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
  // The refusal reason this guard throws when a reservation does not fit (default 'over_limit'). A free-trial scan's guard
  // says 'trial_budget', so the runner can stop that scan with its partial results (lib/billing/trial-budget.ts).
  label = 'over_limit'
  // Set once a reservation was refused: a caller that swallowed the refusal can still tell the run was cut short.
  refused = false
  // Saves the NEW total before the reservation counts and before the paid call is allowed (a job guard saves it to the job
  // row). It must throw if the save did not take effect (storage error, or this attempt no longer owns the job). Then the
  // reservation is refused, the in-memory total is unchanged and no provider call is made: a reservation that exists only in
  // memory would be lost on a restart and spent again.
  persist?: (reservedUsd: number) => void
  constructor(limitUsd: number, alreadyReservedUsd = 0) { this.limitUsd = limitUsd; this.reservedUsd = Number.isFinite(alreadyReservedUsd) && alreadyReservedUsd > 0 ? alreadyReservedUsd : 0 }
  private cost(model: string | undefined, promptBytes: number, maxOut: number): number {
    const p = model ? PRICES_USD_PER_M[model] : undefined
    if (!p) throw new SpendRefused('model_unpriced')
    return ((promptBytes + INPUT_MARGIN_TOKENS) * p.in + maxOut * p.out) / 1e6
  }
  check(model: string | undefined, promptBytes: number, maxOut: number): void {
    this.checkUsd(this.cost(model, promptBytes, maxOut))
  }
  checkUsd(usd: number): void {
    if (!(this.reservedUsd + usd <= this.limitUsd)) { this.refused = true; throw new SpendRefused(this.label) }
  }
  reserve(model: string | undefined, promptBytes: number, maxOut: number): void {
    this.reserveUsd(this.cost(model, promptBytes, maxOut))
  }
  // A paid step priced in dollars up front (a search-provider call, a research call's worst case).
  reserveUsd(usd: number): void {
    this.checkUsd(usd)
    const next = this.reservedUsd + usd
    if (this.persist) {
      try { this.persist(next) } catch (e) { throw new SpendRefused(e instanceof SpendRefused ? e.reason : 'reservation_not_saved') }
    }
    this.reservedUsd = next; this.calls++
  }
  // After a paid call whose real cost is known: move the reservation to it (delta < 0 releases what it did not use). Money
  // already spent is recorded even past the limit; then the guard counts as refused and every later reservation fails.
  settle(deltaUsd: number): void {
    if (!Number.isFinite(deltaUsd) || deltaUsd === 0) return
    const next = Math.max(0, this.reservedUsd + deltaUsd)
    if (this.persist) this.persist(next)
    this.reservedUsd = next
    if (next > this.limitUsd) this.refused = true
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

// A flat dollar amount on every guard, all-or-nothing as reserveAll.
export function reserveAllUsd(guards: SpendGuard[], usd: number): void {
  for (const g of guards) g.checkUsd(usd)
  for (const g of [...guards].sort((a, b) => Number(!!b.persist) - Number(!!a.persist))) g.reserveUsd(usd)
}

// Anthropic's listed price for the web search tool: $10 per 1,000 searches (https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool).
export const WEB_SEARCH_USD = 10 / 1000
// What a research call cost, from the usage the vendor returned; null when it did not say or the model has no listed price.
export function researchCostUsd(usage: { model?: string; input_tokens?: number; output_tokens?: number; web_search_requests?: number } | undefined, model: string | undefined): number | null {
  const m = usage?.model ?? model
  const p = m ? PRICES_USD_PER_M[m] : undefined
  if (!p || usage?.input_tokens === undefined || usage.output_tokens === undefined) return null
  return (usage.input_tokens * p.in + usage.output_tokens * p.out) / 1e6 + (usage.web_search_requests ?? 0) * WEB_SEARCH_USD
}

export function reserveAll(guards: SpendGuard[], model: string | undefined, promptBytes: number, maxOut: number): void {
  // check every guard before committing to any, so a refusal leaves no partial reservation. Guards that must SAVE their
  // reservation (a job guard) go first: if saving fails nothing has been reserved on any other guard.
  for (const g of guards) g.check(model, promptBytes, maxOut)
  for (const g of [...guards].sort((a, b) => Number(!!b.persist) - Number(!!a.persist))) g.reserve(model, promptBytes, maxOut)
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

// research: when given, a research call is allowed: it reserves `reserveUsd` (a worst case: search results come back as
// billed input, so no prompt-based bound exists), then settles to the cost the vendor reported, or keeps the reserve when
// it reported none. Without it, research is refused as before (a run with its own max_usd).
export function guardProvider(p: Provider, gs: SpendGuard | SpendGuard[], count?: TokenCounter, research?: { reserveUsd: number }): Provider {
  const g = Array.isArray(gs) ? gs : [gs]
  const inputTokens = async (k: string, prompt: string, f?: typeof fetch) => {
    if (!count) return Buffer.byteLength(prompt)
    const m = (() => { try { return p.configuredModel?.() } catch { return undefined } })()
    if (!m) throw new SpendRefused('model_unpriced')
    return Math.ceil((await count(k, m, prompt, f)) * COUNT_FACTOR)
  }
  const model = () => { try { return p.configuredModel?.() } catch { return undefined } }
  const out: Provider = {
    research: research
      ? async (k, prompt, f) => {
        reserveAllUsd(g, research.reserveUsd)
        const r = await p.research(k, prompt, f)
        const actual = researchCostUsd(r.usage, model())
        if (actual !== null) for (const x of g) x.settle(actual - research.reserveUsd)
        return r
      }
      : async () => { throw new SpendRefused('research_unbounded') },
    ...(p.configuredModel ? { configuredModel: () => p.configuredModel!() } : {}),
  }
  if (p.complete) out.complete = async (k, prompt, f, max = 10) => { reserveAll(g, model(), await inputTokens(k, prompt, f), max); return p.complete!(k, prompt, f, max) }
  if (p.completeDetailed) out.completeDetailed = async (k, prompt, f, max = 10) => { reserveAll(g, model(), await inputTokens(k, prompt, f), max); return p.completeDetailed!(k, prompt, f, max) }
  return out
}
