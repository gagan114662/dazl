import { LLM_TIMEOUT_MS } from './provider.ts'
import { CLAUDE_SEARCH_MODEL, CLAUDE_SEARCH_MAX_USES, CLAUDE_SEARCH_MAX_OUTPUT, USD_PER_SEARCH, MICROS, ClaudeSearchError, claudeSearchEstimate, type ClaudeSearchEstimate } from './claude-web-search-estimate.ts'
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

// Published standard direct API Sonnet 4.5 prices: in/out $3/$15 per M; cache read/5m/1h $0.30/$3.75/$6 per M.
// Return null rather than assuming absent billing fields cost zero. A missing cache write split is only safe if its reported total is 0.
export function parseClaudeSearchUsage(response: unknown): ClaudeSearchUsage | null {
  const root = obj(response), u = obj(root.usage), cached = obj(u.cache_creation), tools = obj(u.server_tool_use)
  if (root.model !== CLAUDE_SEARCH_MODEL || (u.inference_geo != null && u.inference_geo !== 'global') ||
      (u.speed != null && u.speed !== 'standard') || (u.service_tier != null && u.service_tier !== 'standard')) return null
  const { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: written } = u
  const { web_search_requests: searches } = tools
  if (!count(input) || !count(output) || !count(read) || !count(written) || !count(searches)) return null
  if (Object.entries(tools).some(([key, value]) => key !== 'web_search_requests' && value !== 0)) return null
  const write5m = cached.ephemeral_5m_input_tokens ?? (written === 0 ? 0 : null)
  const write1h = cached.ephemeral_1h_input_tokens ?? (written === 0 ? 0 : null)
  if (!count(write5m) || !count(write1h) || write5m + write1h !== written) return null
  const usd = (input * 3 + output * 15 + read * 0.30 + write5m * 3.75 + write1h * 6) / MICROS + searches * USD_PER_SEARCH
  if (!Number.isFinite(usd)) return null
  return { inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWrite5mTokens: write5m, cacheWrite1hTokens: write1h, searches, usd }
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
  try {
    r = await fetchImpl(MESSAGE, {
      method: 'POST', headers, body: JSON.stringify({ ...countPayload, tools, max_tokens: CLAUDE_SEARCH_MAX_OUTPUT }),
      signal: AbortSignal.timeout(CLAUDE_SEARCH_TIMEOUT_MS), redirect: 'error',
    })
  } catch {
    await hold.uncertain()
    throw new ClaudeSearchError('request_uncertain')
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
    throw new ClaudeSearchError('request_uncertain')
  }
  let json: unknown
  try {
    if (!r.ok) throw new ClaudeSearchError('request_uncertain')
    json = await r.json()
  } catch {
    await hold.uncertain()
    throw new ClaudeSearchError('request_uncertain')
  }
  const usage = parseClaudeSearchUsage(json)
  if (!usage) { await hold.uncertain(); throw new ClaudeSearchError('usage_uncertain') }
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
