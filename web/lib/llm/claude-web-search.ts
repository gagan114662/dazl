import { LLM_TIMEOUT_MS } from './provider.ts'
import { CLAUDE_SEARCH_MODEL, CLAUDE_SEARCH_MAX_USES, CLAUDE_SEARCH_MAX_OUTPUT, USD_PER_SEARCH, MICROS, ClaudeSearchError, claudeSearchEstimate, type ClaudeSearchEstimate, type ClaudeSearchUsageDiagnostic, type ClaudeUsageSnapshot, type ClaudeUsageCounter } from './claude-web-search-estimate.ts'
export { CLAUDE_SEARCH_MODEL, CLAUDE_SEARCH_MAX_USES, CLAUDE_SEARCH_MAX_OUTPUT, CLAUDE_SEARCH_ASSUMED_INPUT_PER_SEARCH, ClaudeSearchError, claudeSearchEstimate, type ClaudeSearchEstimate, type ClaudeSearchFailure } from './claude-web-search-estimate.ts'

const CLAUDE_SEARCH_TIMEOUT_MS = Math.min(150_000, LLM_TIMEOUT_MS)
const MESSAGE = 'https://api.anthropic.com/v1/messages'
const MAX_PROMPT_BYTES = 24_000
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : []
export interface ClaudeSearchUsage {
  inputTokens: number; outputTokens: number; cacheReadTokens: number
  cacheWrite5mTokens: number; cacheWrite1hTokens: number; searches: number; usd: number
}

type Absent = 'absent' | 'null'
const absent = (p: Record<string, unknown>, field: string): Absent | undefined =>
  !Object.hasOwn(p, field) ? 'absent' : p[field] === null ? 'null' : undefined
const projectedObject = (p: Record<string, unknown>, field: string): 'object' | Absent | 'malformed' =>
  absent(p, field) ?? (p[field] !== null && typeof p[field] === 'object' && !Array.isArray(p[field]) ? 'object' : 'malformed')
const projectedCount = (p: Record<string, unknown>, field: string, bound: number): ClaudeUsageCounter => {
  const state = absent(p, field), v = p[field]
  return state ?? (count(v) ? v <= bound ? v : 'outside_diagnostic_bound' : 'malformed')
}
function projectedEnum<const T extends string>(p: Record<string, unknown>, field: string, options: readonly T[]): T | Absent | 'malformed' | 'unrecognized' {
  const state = absent(p, field), v = p[field]
  return state ?? (typeof v === 'string' ? options.find(option => option === v) ?? 'unrecognized' : 'malformed')
}

// This never serializes the upstream object. Fixed keys, bounded nonnegative integers, and compiled-in enums only.
// Projection bounds limit diagnostics only: they are not spend estimates or Anthropic usage limits.
function rejectedUsage(response: unknown, rejection: ClaudeSearchUsageDiagnostic): ClaudeUsageSnapshot {
  const root = obj(response), u = obj(root.usage), c = obj(u.cache_creation), t = obj(u.server_tool_use)
  const tokenBound = 10_000_000, toolBound = 1_000
  const other = Object.entries(t).filter(([name]) => name !== 'web_search_requests' && name !== 'web_fetch_requests')
  return {
    rejection, usage: projectedObject(root, 'usage'),
    model: projectedEnum(root, 'model', [CLAUDE_SEARCH_MODEL, 'claude-sonnet-4-5']),
    inference_geo: projectedEnum(u, 'inference_geo', ['global', 'us']),
    speed: projectedEnum(u, 'speed', ['standard', 'fast']),
    service_tier: projectedEnum(u, 'service_tier', ['standard', 'priority', 'batch']),
    input_tokens: projectedCount(u, 'input_tokens', tokenBound),
    output_tokens: projectedCount(u, 'output_tokens', tokenBound),
    cache_read_input_tokens: projectedCount(u, 'cache_read_input_tokens', tokenBound),
    cache_creation_input_tokens: projectedCount(u, 'cache_creation_input_tokens', tokenBound),
    cache_creation: projectedObject(u, 'cache_creation'),
    ephemeral_5m_input_tokens: projectedCount(c, 'ephemeral_5m_input_tokens', tokenBound),
    ephemeral_1h_input_tokens: projectedCount(c, 'ephemeral_1h_input_tokens', tokenBound),
    server_tool_use: projectedObject(u, 'server_tool_use'),
    web_search_requests: projectedCount(t, 'web_search_requests', toolBound),
    web_fetch_requests: projectedCount(t, 'web_fetch_requests', toolBound),
    other_tool_counts: !other.length ? 'none' : other.every(([, value]) => value === 0) ? 'zero_only' : 'nonzero_or_invalid',
  }
}

// Published standard direct API Sonnet 4.5 prices: in/out $3/$15 per M; cache read/5m/1h $0.30/$3.75/$6 per M.
type UsageCheck = { usage: ClaudeSearchUsage } | { diagnostic: ClaudeSearchUsageDiagnostic }
function checkUsage(response: unknown, fixedUncachedSearch = false): UsageCheck {
  const root = obj(response), u = obj(root.usage), cached = obj(u.cache_creation), tools = obj(u.server_tool_use)
  if (!Object.keys(u).length) return { diagnostic: 'usage_envelope' }
  if (root.model !== CLAUDE_SEARCH_MODEL) return { diagnostic: 'usage_model' }
  // First-party direct pricing is independent of geography for this exact pre-4.6 snapshot.
  // This is a response check only, never a change to the request's geo or workspace routing.
  // https://platform.claude.com/docs/en/about-claude/pricing#data-residency-pricing
  const geo = u.inference_geo
  const pre46TransportLabel = fixedUncachedSearch && root.model === 'claude-sonnet-4-5-20250929' &&
    typeof geo === 'string'
  if (geo != null && geo !== 'global' && geo !== 'us' && !pre46TransportLabel) return { diagnostic: 'usage_geo' }
  if (u.speed != null && u.speed !== 'standard') return { diagnostic: 'usage_speed' }
  if (u.service_tier != null && u.service_tier !== 'standard') return { diagnostic: 'usage_tier' }
  const { input_tokens: input, output_tokens: output } = u
  const { web_search_requests: searches } = tools
  if (!count(input)) return { diagnostic: 'usage_input_count' }
  if (!count(output)) return { diagnostic: 'usage_output_count' }
  if (!count(searches)) return { diagnostic: 'usage_search_count' }
  if (Object.entries(tools).some(([key, value]) => key !== 'web_search_requests' && value !== 0)) return { diagnostic: 'usage_other_tool' }
  let { cache_read_input_tokens: read, cache_creation_input_tokens: written } = u
  // Anthropic's direct Web Search example omits cache counters, and Messages marks those counters
  // nullable. Reads/writes require a cache breakpoint. This one-message request has no cache opt-in,
  // thinking, history or continuation, unlike the generic parser. No contradictory cache evidence
  // is accepted, and the three required paid counters have already been explicitly validated.
  // https://platform.claude.com/docs/en/api/messages/create
  // https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
  // https://platform.claude.com/docs/en/build-with-claude/prompt-caching
  const zeroOrUnstated = (v: unknown) => v == null || v === 0
  const zeroSplit = u.cache_creation == null ||
    (cached.ephemeral_5m_input_tokens === 0 && cached.ephemeral_1h_input_tokens === 0 && Object.keys(cached).length === 2)
  if (fixedUncachedSearch && root.type === 'message' && root.role === 'assistant' && Array.isArray(root.content) &&
      zeroOrUnstated(read) && zeroOrUnstated(written) && zeroSplit) {
    read = 0
    written = 0
  }
  if (!count(read) || !count(written)) return { diagnostic: 'usage_cache_totals' }
  const write5m = cached.ephemeral_5m_input_tokens ?? (written === 0 ? 0 : null)
  const write1h = cached.ephemeral_1h_input_tokens ?? (written === 0 ? 0 : null)
  if (!count(write5m) || !count(write1h) || write5m + write1h !== written) return { diagnostic: 'usage_cache_split' }
  const usd = (input * 3 + output * 15 + read * 0.30 + write5m * 3.75 + write1h * 6) / MICROS + searches * USD_PER_SEARCH
  if (!Number.isFinite(usd)) return { diagnostic: 'usage_cost' }
  return { usage: { inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWrite5mTokens: write5m, cacheWrite1hTokens: write1h, searches, usd } }
}

// Default parser has no evidence about what the caller sent; only the dedicated transport enables the no-cache shape.
export function parseClaudeSearchUsage(response: unknown): ClaudeSearchUsage | null {
  const checked = checkUsage(response)
  return 'usage' in checked ? checked.usage : null
}

export interface ClaudeSearchHold {
  settle(actualUsd: number, usage: ClaudeSearchUsage): Promise<void> | void
  uncertain(): Promise<void> | void
  rejected(status: number): Promise<void> | void
}
export interface ClaudeSearchResult {
  outcome: 'ok' | 'partial' | 'unavailable'
  citedUrls: string[]
  stop: 'end_turn' | 'pause_turn' | 'max_tokens' | 'other'
  usage: ClaudeSearchUsage
  estimate: ClaudeSearchEstimate
}

// A caller supplies one reservation spanning every applicable scan/account cap. A reservation failure means zero paid sends.
// Once sent, any unknown billing keeps the hold and returns no candidate URLs. Neither transport nor response starts a second request.
export async function runClaudeWebSearch(
  apiKey: string, prompt: string,
  reserve: (estimate: ClaudeSearchEstimate) => Promise<ClaudeSearchHold | null> | ClaudeSearchHold | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ClaudeSearchResult> {
  if (!apiKey.trim() || !prompt.trim() || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new ClaudeSearchError('invalid_input')
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  const countPayload = { model: CLAUDE_SEARCH_MODEL, messages: [{ role: 'user', content: prompt }] }
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: CLAUDE_SEARCH_MAX_USES }]
  let input: unknown
  try {
    const r = await fetchImpl(MESSAGE + '/count_tokens', { method: 'POST', headers, body: JSON.stringify(countPayload), signal: AbortSignal.timeout(20_000), redirect: 'error' })
    if (r.status === 401 || r.status === 403) throw new ClaudeSearchError('key_rejected')
    if (!r.ok) throw new ClaudeSearchError('count_failed')
    input = obj(await r.json()).input_tokens
  } catch (e) { if (e instanceof ClaudeSearchError) throw e; throw new ClaudeSearchError('count_failed') }
  if (!count(input)) throw new ClaudeSearchError('count_failed')
  const estimate = claudeSearchEstimate(input)
  const hold = await reserve(estimate)
  if (!hold) throw new ClaudeSearchError('reservation_missing')
  let r: Response
  const signal = AbortSignal.timeout(CLAUDE_SEARCH_TIMEOUT_MS)
  try {
    r = await fetchImpl(MESSAGE, {
      // The estimate/parser only support standard rates; the API default can select legacy Priority.
      method: 'POST', headers, body: JSON.stringify({ ...countPayload, tools, max_tokens: CLAUDE_SEARCH_MAX_OUTPUT, service_tier: 'standard_only' }),
      signal, redirect: 'error',
    })
  } catch {
    await hold.uncertain()
    throw new ClaudeSearchError('request_uncertain', signal.aborted ? 'timeout' : 'transport')
  }
  if (r.status === 401 || r.status === 403) {
    // Authentication/permission refusal is known, but that does not mean the vendor billed zero.
    await hold.rejected(r.status)
    throw new ClaudeSearchError('key_rejected')
  }
  if (r.status === 429) {
    // The dedicated, non-streaming Anthropic endpoint documents this as a request rejection.
    // Match its error envelope + request ID, not a proxy's bare status or an in-band tool error.
    let limited = false
    try {
      const body = obj(await r.json()), err = obj(body.error), requestId = r.headers.get('request-id')
      const reason = obj(err.details).error_code
      limited = body.type === 'error' && err.type === 'rate_limit_error' &&
        typeof err.message === 'string' && !!err.message && !('usage' in body) && !('content' in body) &&
        (reason === undefined || reason === 'ramp_limit_exceeded') &&
        !!requestId && /^req_[a-zA-Z0-9]+$/.test(requestId) && body.request_id === requestId
    } catch { /* unreadable error still may have been billed */ }
    if (limited) {
      await hold.rejected(429)
      throw new ClaudeSearchError('rate_limited')
    }
    await hold.uncertain()
    throw new ClaudeSearchError('request_uncertain', 'http_error')
  }
  if (!r.ok) {
    await hold.uncertain()
    throw new ClaudeSearchError('request_uncertain', 'http_error')
  }
  let json: unknown
  try {
    json = await r.json()
  } catch {
    await hold.uncertain()
    throw new ClaudeSearchError('request_uncertain', signal.aborted ? 'timeout' : 'response_unreadable')
  }
  const checked = checkUsage(json, true)
  if ('diagnostic' in checked) { await hold.uncertain(); throw new ClaudeSearchError('usage_uncertain', checked.diagnostic, rejectedUsage(json, checked.diagnostic)) }
  const { usage } = checked
  // Known actual is always settled, even if it exceeded the soft estimate or violated the claimed output/tool limits.
  await hold.settle(usage.usd, usage)
  if (usage.searches > CLAUDE_SEARCH_MAX_USES || usage.outputTokens > CLAUDE_SEARCH_MAX_OUTPUT)
    throw new ClaudeSearchError('provider_limit_violation')
  const root = obj(json), content = arr(root.content)
  const rawStop = root.stop_reason
  const stop = rawStop === 'end_turn' || rawStop === 'pause_turn' || rawStop === 'max_tokens' ? rawStop : 'other'
  let toolError = false
  const urls = new Set<string>()
  for (const block of content.map(obj)) {
    if (block.type !== 'web_search_tool_result') continue
    if (!Array.isArray(block.content)) { toolError = true; continue }
    for (const result of block.content.map(obj)) {
      if (result.type !== 'web_search_result' || typeof result.url !== 'string' || result.url.length > 480 || /\s/.test(result.url)) continue
      try {
        const u = new URL(result.url)
        if (u.protocol === 'https:' && !u.username && !u.password && !u.port && urls.size < 20) urls.add(u.href)
      } catch { /* not a valid absolute evidence URL */ }
    }
  }
  // A real search result must be charged/recorded and subsequently fetched through the app's own public-page guard.
  const citedUrls = usage.searches > 0 ? [...urls] : []
  return { outcome: !citedUrls.length ? 'unavailable' : toolError || stop !== 'end_turn' ? 'partial' : 'ok', citedUrls, stop, usage, estimate }
}
