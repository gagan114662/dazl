import type { Provider } from './provider.ts'
import type { SharedPool } from './spend-pool.ts'

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
  private cost(model: string | undefined, promptBytes: number, maxOut: number): number { return callCostUsd(model, promptBytes, maxOut) }
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

// The owner's workspace pool, held in the shared store (lib/llm/spend-pool.ts): every job, retry, restart and instance of
// that owner draws on the same day/month limits. Local checks only price the call (an unpriced model still refuses);
// the limit itself is checked atomically in the store when the reservation is made.
export class PooledGuard extends SpendGuard {
  readonly pool: SharedPool
  constructor(pool: SharedPool) { super(Infinity); this.pool = pool }
  override checkUsd(usd: number): void { if (this.refused || !(Number.isFinite(usd) && usd >= 0)) { this.refused = true; throw new SpendRefused(this.label) } }
  override reserveUsd(): void { throw new Error('a pooled guard reserves through reserveAll / reserveAllUsd') }
  // Returns the time the reservation was made at, from the pool's own clock; that time travels with the reservation
  // (Reservation below), so its settle or release lands in exactly the windows it was reserved in.
  async reserveShared(usd: number): Promise<number> {
    const at = this.pool.now()
    try { await this.pool.reserve(usd, at) } catch (e) { this.refused = true; throw e instanceof SpendRefused ? (e.reason === 'over_limit' ? new SpendRefused(this.label) : e) : new SpendRefused('reservation_not_saved') }
    this.reservedUsd += usd; this.calls++
    return at
  }
  // The local total moves only after the store settled (one transaction: all or nothing), so a failed settle leaves it
  // where it was and a retry moves it once.
  async settleShared(deltaUsd: number, reportedUsd: number | null, at: number): Promise<void> {
    await this.pool.settle(deltaUsd, reportedUsd, at)
    this.reservedUsd = Math.max(0, this.reservedUsd + (Number.isFinite(deltaUsd) ? deltaUsd : 0))
  }
}

// One all-or-nothing reservation: its amount, the guards it was made on and, for each shared pool, the time it was
// reserved at. A settle or a rollback moves exactly this reservation, never another outstanding one, whatever order calls
// complete in, and only once.
//   done / settlement: a settle that fails partway (a store or persist error) leaves the guards it already moved in
//   `done` and its amounts in `settlement`; a retry with the same amounts moves only the rest. settled = every guard done.
export interface Reservation {
  usd: number
  guards: SpendGuard[]
  at: Map<PooledGuard, number>
  done: Set<SpendGuard>
  settlement: { deltaUsd: number; reportedUsd: number | null } | null
  settled: boolean
}
const pooled = (g: SpendGuard): g is PooledGuard => g instanceof PooledGuard

// A flat dollar amount on every guard, all-or-nothing. Order: shared pools first (atomic in the store, may refuse), then
// guards that save their reservation (a job guard), then in-memory ones. A refusal at any step releases what the earlier
// steps reserved, so no partial reservation is left anywhere.
export async function reserveAllUsd(guards: SpendGuard[], usd: number): Promise<Reservation> {
  for (const g of guards) g.checkUsd(usd)
  const r: Reservation = { usd, guards: [...guards], at: new Map(), done: new Set(), settlement: null, settled: false }
  try {
    for (const p of guards.filter(pooled)) r.at.set(p, await p.reserveShared(usd))
    for (const g of guards.filter(g => !pooled(g)).sort((a, b) => Number(!!b.persist) - Number(!!a.persist))) g.reserveUsd(usd)
  } catch (e) {
    // Release exactly what this reservation took, at the times it took it. Best effort: a failed release over-counts,
    // never under.
    for (const [p, at] of r.at) await p.settleShared(-usd, null, at).catch(() => {})
    throw e
  }
  return r
}
// After a paid call: move this reservation by delta on every guard it was made on; reportedUsd is the vendor's own
// figure, when it gave one. Everything is checked before anything changes: the guards must be exactly the reservation's
// (any order), the amounts finite (reportedUsd null or >= 0), and a retry must carry the first attempt's amounts. A
// refused settle has no effect. Each guard moves at most once; a failure partway is retried by calling again.
export async function settleAll(guards: SpendGuard[], deltaUsd: number, reportedUsd: number | null, r: Reservation): Promise<void> {
  if (r.settled) throw new Error('reservation already settled')
  if (guards.length !== r.guards.length || new Set(guards).size !== guards.length || !guards.every(g => r.guards.includes(g))) {
    throw new Error('settle refused: not the guards this reservation was made on')
  }
  if (!Number.isFinite(deltaUsd) || (reportedUsd !== null && !(Number.isFinite(reportedUsd) && reportedUsd >= 0))) throw new Error('settle refused: invalid settle amount')
  if (r.settlement && (r.settlement.deltaUsd !== deltaUsd || r.settlement.reportedUsd !== reportedUsd)) throw new Error('settle refused: a retry with different amounts')
  r.settlement = { deltaUsd, reportedUsd }
  // Order of the reservation; each guard is marked done only after it moved, so an error leaves exactly the rest to retry.
  for (const g of r.guards) {
    if (r.done.has(g)) continue
    if (pooled(g)) await g.settleShared(deltaUsd, reportedUsd, r.at.get(g)!)
    else g.settle(deltaUsd)
    r.done.add(g)
  }
  r.settled = true
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

export async function reserveAll(guards: SpendGuard[], model: string | undefined, promptBytes: number, maxOut: number): Promise<Reservation> {
  // Every guard prices the call first (an unpriced model refuses), then the same amount is reserved all-or-nothing.
  for (const g of guards) g.check(model, promptBytes, maxOut)
  return reserveAllUsd(guards, callCostUsd(model, promptBytes, maxOut))
}
export function callCostUsd(model: string | undefined, promptBytes: number, maxOut: number): number {
  const p = model ? PRICES_USD_PER_M[model] : undefined
  if (!p) throw new SpendRefused('model_unpriced')
  return ((promptBytes + INPUT_MARGIN_TOKENS) * p.in + maxOut * p.out) / 1e6
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
        const held = await reserveAllUsd(g, research.reserveUsd)
        const r = await p.research(k, prompt, f)
        const actual = researchCostUsd(r.usage, model())
        if (actual !== null) await settleAll(g, actual - research.reserveUsd, actual, held)
        return r
      }
      : async () => { throw new SpendRefused('research_unbounded') },
    ...(p.configuredModel ? { configuredModel: () => p.configuredModel!() } : {}),
  }
  if (p.complete) out.complete = async (k, prompt, f, max = 10) => { await reserveAll(g, model(), await inputTokens(k, prompt, f), max); return p.complete!(k, prompt, f, max) }
  if (p.completeDetailed) out.completeDetailed = async (k, prompt, f, max = 10) => { await reserveAll(g, model(), await inputTokens(k, prompt, f), max); return p.completeDetailed!(k, prompt, f, max) }
  return out
}
