import { randomBytes } from 'node:crypto'
import type { CompletionUsage, DetailedCompletion, Provider } from './provider.ts'
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
// After a paid call was made: its cost could not be recorded (the settle did not save). Never a SpendRefused: the call
// happened and may be billed, so a caller must not treat it as "nothing was spent" (release a claim, retry for free).
// Every guard of the call counts as refused, so no later call goes through it.
export class SpendAccountingFailed extends Error {
  constructor(cause: unknown) { super(`spend_accounting_failed:${cause instanceof Error ? cause.message.slice(0, 120) : 'unknown'}`) }
}

// A served model id with a release date (claude-sonnet-4-5-20250929) is priced as its listed alias; anything else must
// match exactly. Unlisted: null.
export function priceOf(model: string | null | undefined): { in: number; out: number } | null {
  if (!model) return null
  return PRICES_USD_PER_M[model] ?? PRICES_USD_PER_M[model.replace(/-\d{8}$/, '')] ?? null
}
// Cache pricing as multiples of the input price (https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching):
// reads 0.1x; writes 1.25x for the 5-minute cache and 2x for the 1-hour cache. The usage dazl keeps does not say which,
// so writes are priced at 2x, the higher of the two (an upper bound, by choice).
export const CACHE_WRITE_FACTOR = 2
export const CACHE_READ_FACTOR = 0.1
export type CompletionCost = { usd: number } | { unknown: 'no_usage' | 'unpriced_model' | 'invalid_usage' }
// What a completion cost from what the vendor reported: the SERVED model's price, input and output tokens, cache writes
// and cache reads (Anthropic's input_tokens excludes both). No usage at all: 'no_usage'; a usage report with no priced
// served model or without valid input/output counts: unknown.
export function completionCost(servedModel: string | null | undefined, usage: CompletionUsage | undefined): CompletionCost {
  if (!usage) return { unknown: 'no_usage' }
  const price = priceOf(servedModel)
  if (!price) return { unknown: 'unpriced_model' }
  const ok = (v: number | undefined, required: boolean) => v === undefined ? !required : Number.isFinite(v) && v >= 0
  if (!ok(usage.input_tokens, true) || !ok(usage.output_tokens, true) || !ok(usage.cache_creation_input_tokens, false) || !ok(usage.cache_read_input_tokens, false)) return { unknown: 'invalid_usage' }
  const usd = (usage.input_tokens! * price.in + usage.output_tokens! * price.out
    + (usage.cache_creation_input_tokens ?? 0) * price.in * CACHE_WRITE_FACTOR + (usage.cache_read_input_tokens ?? 0) * price.in * CACHE_READ_FACTOR) / 1e6
  return { usd }
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
  // A call whose cost is unknown: the rest of the limit counts as spent.
  exhaust(): void { if (this.reservedUsd < this.limitUsd) this.settle(this.limitUsd - this.reservedUsd); this.refused = true }
}

// The owner's workspace pool, held in the shared store (lib/llm/spend-pool.ts): every job, retry, restart and instance of
// that owner draws on the same day/month limits. Local checks only price the call (an unpriced model still refuses);
// the limit itself is checked atomically in the store when the reservation is made.
export class PooledGuard extends SpendGuard {
  readonly pool: SharedPool
  // trackPending: each reservation also writes a pending-settlement marker in the store, removed by its settle (see
  // SharedPool.reserve). A call whose accounting never lands leaves it, and the owner's later reservations are refused.
  readonly trackPending: boolean
  constructor(pool: SharedPool, opts: { trackPending?: boolean } = {}) { super(Infinity); this.pool = pool; this.trackPending = opts.trackPending === true }
  override checkUsd(usd: number): void { if (this.refused || !(Number.isFinite(usd) && usd >= 0)) { this.refused = true; throw new SpendRefused(this.label) } }
  override reserveUsd(): void { throw new Error('a pooled guard reserves through reserveAll / reserveAllUsd') }
  // Returns the time the reservation was made at, from the pool's own clock; that time travels with the reservation
  // (Reservation below), so its settle or release lands in exactly the windows it was reserved in.
  async reserveShared(usd: number, pendingId?: string): Promise<number> {
    const at = this.pool.now()
    try { await this.pool.reserve(usd, at, pendingId) } catch (e) { this.refused = true; throw e instanceof SpendRefused ? (e.reason === 'over_limit' ? new SpendRefused(this.label) : e) : new SpendRefused('reservation_not_saved') }
    this.reservedUsd += usd; this.calls++
    return at
  }
  // A call whose cost is unknown: its shortest window counts as spent, in the store (durable; SharedPool.exhaust).
  async exhaustShared(at: number, pendingId?: string): Promise<void> { await this.pool.exhaust(at, pendingId); this.refused = true }
  // The local total moves only after the store settled (one transaction: all or nothing), so a failed settle leaves it
  // where it was and a retry moves it once.
  async settleShared(deltaUsd: number, reportedUsd: number | null, at: number, pendingId?: string): Promise<void> {
    await this.pool.settle(deltaUsd, reportedUsd, at, pendingId)
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
  // The pending-settlement marker each tracking pool wrote for this reservation (PooledGuard.trackPending).
  pending: Map<PooledGuard, string>
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
  const r: Reservation = { usd, guards: [...guards], at: new Map(), pending: new Map(), done: new Set(), settlement: null, settled: false }
  try {
    for (const p of guards.filter(pooled)) {
      const id = p.trackPending ? randomBytes(5).toString('hex') : undefined
      r.at.set(p, await p.reserveShared(usd, id))
      if (id) r.pending.set(p, id)
    }
    for (const g of guards.filter(g => !pooled(g)).sort((a, b) => Number(!!b.persist) - Number(!!a.persist))) g.reserveUsd(usd)
  } catch (e) {
    // Release exactly what this reservation took, at the times it took it. Best effort: a failed release over-counts,
    // never under.
    for (const [p, at] of r.at) await p.settleShared(-usd, null, at, r.pending.get(p)).catch(() => {})
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
    if (pooled(g)) await g.settleShared(deltaUsd, reportedUsd, r.at.get(g)!, r.pending.get(g))
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
// settle: when true, a completion is settled to what the vendor reported after the call (completionCost): the reservation
// moves to the actual cost, an overrun past the limit is recorded and refuses every later reservation, no usage keeps the
// full reservation and refuses later calls through these guards, and an unknown cost (unpriced served model, invalid
// counts) counts the rest of the limit as spent (for a pool: its shortest window). complete() then goes through completeDetailed so its usage is seen too.
// If that accounting cannot be saved (retried once), the call's result is withheld and SpendAccountingFailed is thrown.
// Without it, completions keep their worst-case reservation (the scan runner today).
export function guardProvider(p: Provider, gs: SpendGuard | SpendGuard[], count?: TokenCounter, research?: { reserveUsd: number }, settle = false): Provider {
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
  // A call that throws keeps its reservation (the vendor may have billed it); in settle mode its pending marker is
  // cleared, and if even that cannot be saved the marker stays and refuses later reservations (fail closed).
  const run = async <T>(k: string, prompt: string, f: typeof fetch | undefined, max: number, call: () => Promise<T>, detail: (r: T) => DetailedCompletion): Promise<T> => {
    const held = await reserveAll(g, model(), await inputTokens(k, prompt, f), max)
    if (!settle) return call()
    let r: T
    try { r = await call() } catch (e) { await settleAll(g, 0, null, held).catch(() => {}); throw e }
    await settleCompletion(g, held, detail(r))
    return r
  }
  if (p.complete) out.complete = (k, prompt, f, max = 10) => run(k, prompt, f, max, () => p.complete!(k, prompt, f, max), text => ({ text, model: null }))
  if (p.completeDetailed) out.completeDetailed = (k, prompt, f, max = 10) => run(k, prompt, f, max, () => p.completeDetailed!(k, prompt, f, max), d => d)
  // complete() is completeDetailed().text in the real providers: going through it keeps the usage to settle.
  if (settle && out.completeDetailed) out.complete = async (k, prompt, f, max) => (await out.completeDetailed!(k, prompt, f, max)).text
  return out
}

async function settleCompletion(g: SpendGuard[], held: Reservation, d: DetailedCompletion): Promise<void> {
  const cost = completionCost(d.model, d.usage)
  const record = async () => {
    if ('usd' in cost) { if (!held.settled) await settleAll(g, cost.usd - held.usd, cost.usd, held) }
    else if (cost.unknown === 'no_usage') { if (!held.settled) await settleAll(g, 0, null, held) } // the reservation stands; only its marker goes
    else for (const x of g) { if (x instanceof PooledGuard) await x.exhaustShared(held.at.get(x)!, held.pending.get(x)); else x.exhaust() }
  }
  try { await record() } catch {
    try { await record() } catch (e) { for (const x of g) x.refused = true; throw new SpendAccountingFailed(e) }
  }
  // No usage: nothing says what the call really used, so no later call goes through these guards.
  if ('unknown' in cost && cost.unknown === 'no_usage') for (const x of g) x.refused = true
}
