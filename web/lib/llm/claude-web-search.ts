import { LLM_TIMEOUT_MS } from './provider.ts'
import { CLAUDE_SEARCH_MODEL, claudeSearchMaxUses, CLAUDE_SEARCH_MAX_OUTPUT, USD_PER_SEARCH, MICROS, ClaudeSearchError, claudeSearchEstimate, type ClaudeSearchEstimate, type ClaudeSearchUsageDiagnostic, type ClaudeUsageSnapshot, type ClaudeUsageCounter } from './claude-web-search-estimate.ts'
export { CLAUDE_SEARCH_MODEL, CLAUDE_SEARCH_MAX_USES, CLAUDE_SEARCH_MAX_OUTPUT, CLAUDE_SEARCH_ASSUMED_INPUT_PER_SEARCH, CLAUDE_COMPANY_FIRST_ASSUMED_INPUT_PER_SEARCH, CLAUDE_COMPANY_FIRST_MAX_CALLS, CLAUDE_COMPANY_FIRST_MAX_USES, COMPANY_FIRST_MAX_PUBLISHER_READS, claudeSearchMaxUses, ClaudeSearchError, claudeSearchEstimate, type ClaudeSearchEstimate, type ClaudeSearchFailure } from './claude-web-search-estimate.ts'

const CLAUDE_SEARCH_TIMEOUT_MS = Math.min(150_000, LLM_TIMEOUT_MS)
// #1157: the call streams, and a STALL - no bytes from the provider for this long - ends it in seconds. A healthy multi-search call
// keeps sending events (pings, blocks) and runs on up to CLAUDE_SEARCH_TIMEOUT_MS, which still bounds the whole call (the stale-scan
// window's floor in lib/scan/store.ts depends on it). A stalled call was already sent: it is counted as billed (uncertain).
// The window relies on the API's ping events arriving more often than every 20 s while server-side searches run; the docs list
// pings but give no cadence, so the scan's own native-search reports (stop diagnostics) are the place to see a false stall.
export const CLAUDE_SEARCH_STALL_MS = 20_000
const MAX_STREAM_BYTES = 4 * 1024 * 1024
const MESSAGE = 'https://api.anthropic.com/v1/messages'
const MAX_PROMPT_BYTES = 24_000
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : []
export interface ClaudeSearchUsage {
  inputTokens: number; outputTokens: number; cacheReadTokens: number
  cacheWrite5mTokens: number; cacheWrite1hTokens: number; searches: number; usd: number
  inferenceGeoDiagnostic?: 'not_available' | 'unrecognized_price_neutral'
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
  const unknownGeo = geo != null && geo !== 'global' && geo !== 'us'
  if (unknownGeo && !pre46TransportLabel) return { diagnostic: 'usage_geo' }
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
  return { usage: { inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWrite5mTokens: write5m, cacheWrite1hTokens: write1h, searches, usd,
    // The legacy organization usage report documents not_available for models without geo.
    // Preserve it only if actually returned; other labels are not stored or fingerprinted.
    // https://platform.claude.com/docs/en/api/beta/organization/usage_report/retrieve_messages
    ...(unknownGeo ? { inferenceGeoDiagnostic: geo === 'not_available' ? 'not_available' : 'unrecognized_price_neutral' } : {}),
  } }
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
// The pinned direct-search tool's six documented error codes. Unknown provider bytes never escape.
function resultErrorCode(value: unknown) {
  switch (value) {
    case 'too_many_requests': return 'too_many_requests'
    case 'invalid_tool_input': return 'invalid_tool_input'
    case 'max_uses_exceeded': return 'max_uses_exceeded'
    case 'query_too_long': return 'query_too_long'
    case 'request_too_large': return 'request_too_large'
    case 'unavailable': return 'unavailable'
    default: return 'other'
  }
}
export type ClaudeSearchEvidenceDiagnostic = {
  stop: 'end_turn' | 'pause_turn' | 'max_tokens' | 'other'
  result_blocks: number
  non_array_result_blocks: number
  empty_result_blocks: number
  malformed_result_blocks: number
  result_errors: Partial<Record<ReturnType<typeof resultErrorCode>, number>>
  result_entries: number
  safe_urls: number
}
export interface TextCandidate { company: string; website: string | null; jobUrl: string | null }
const str = (v: unknown, max: number) => typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null
// cf_runner extract_json: the <json>...</json> block (else the first [...]); a truncated answer still yields its complete objects.
export function parseTextCandidates(text: string): TextCandidate[] {
  const m = /<json>([\s\S]*?)(?:<\/json>|$)/.exec(text), body = m ? m[1] : text
  const objs: unknown[] = []
  try { const j = JSON.parse(body.trim()); if (Array.isArray(j)) objs.push(...j) } catch {
    for (const o of body.match(/\{[^{}]*\}/g) ?? []) { try { objs.push(JSON.parse(o)) } catch { /* incomplete object */ } }
  }
  const out: TextCandidate[] = []
  for (const o of objs) {
    if (!o || typeof o !== 'object' || out.length >= 30) continue
    const r = o as Record<string, unknown>, company = str(r.company, 120)
    if (!company) continue
    const job = str(r.job_url, 480)
    let jobUrl: string | null = null
    try { if (job) { const u = new URL(job); if (u.protocol === 'https:' && !u.username && !u.password && !u.port) jobUrl = u.href } } catch { /* not a URL */ }
    const site = str(r.website, 200)
    out.push({ company, website: site, jobUrl })
  }
  return out
}
// #1157: rebuilds the final Message from the documented event stream (platform.claude.com/docs/en/build-with-claude/streaming):
// message_start (empty content) -> per block content_block_start / _delta / _stop (server tool results arrive whole) ->
// message_delta (stop_reason; usage counts are cumulative) -> message_stop. ping and unknown event types are skipped. An error
// event, a stream that ends before message_stop, or an oversized stream throws: the caller counts the sent call as billed.
async function readMessageStream(r: Response, alive: () => void, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!r.body) throw new Error('no body')
  const reader = r.body.getReader(), decoder = new TextDecoder()
  // a stall or the overall limit ends the read itself, whatever the transport does with the aborted request
  const stop = () => { void reader.cancel().catch(() => {}) }
  if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true })
  try {
  let buffer = '', bytes = 0, message: Record<string, unknown> | null = null, stopped = false
  const content: Record<string, unknown>[] = [], partialJson = new Map<number, string>()
  const handle = (data: Record<string, unknown>) => {
    const type = data.type, index = typeof data.index === 'number' && Number.isSafeInteger(data.index) && data.index >= 0 && data.index < 1000 ? data.index : -1
    if (type === 'error') throw new Error('stream error event')
    if (type === 'message_start') { message = { ...obj(data.message) }; return }
    if (!message) throw new Error('event before message_start')
    if (type === 'content_block_start') { if (index < 0) throw new Error('bad index'); content[index] = { ...obj(data.content_block) }; return }
    if (type === 'content_block_delta') {
      const block = content[index], delta = obj(data.delta)
      if (!block) throw new Error('delta without block')
      if (delta.type === 'text_delta' && typeof delta.text === 'string') block.text = (typeof block.text === 'string' ? block.text : '') + delta.text
      else if (delta.type === 'citations_delta') block.citations = [...arr(block.citations), delta.citation]
      else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') partialJson.set(index, (partialJson.get(index) ?? '') + delta.partial_json)
      return
    }
    if (type === 'content_block_stop') {
      const block = content[index], raw = partialJson.get(index)
      if (block && raw) { try { block.input = JSON.parse(raw) } catch { /* the tool input is not read by the parser */ } }
      return
    }
    if (type === 'message_delta') {
      const delta = obj(data.delta)
      if ('stop_reason' in delta) message.stop_reason = delta.stop_reason
      if ('stop_sequence' in delta) message.stop_sequence = delta.stop_sequence
      // usage counts in message_delta are cumulative; a field it sends as null (the documented delta type allows it) is
      // "not reported here", never a reset of the count message_start carried
      if (data.usage !== undefined) message.usage = { ...obj(message.usage), ...Object.fromEntries(Object.entries(obj(data.usage)).filter(([, v]) => v !== null)) }
      return
    }
    if (type === 'message_stop') stopped = true
  }
  const dispatch = (raw: string) => {
    const data = raw.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n')
    if (data) handle(obj(JSON.parse(data)))
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    alive()
    bytes += value.byteLength
    if (bytes > MAX_STREAM_BYTES) { await reader.cancel().catch(() => {}); throw new Error('stream too large') }
    buffer += decoder.decode(value, { stream: true })
    let cut: number
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buffer.slice(0, cut), sep = /\r?\n\r?\n/.exec(buffer.slice(cut))![0]
      buffer = buffer.slice(cut + sep.length)
      dispatch(raw)
      if (stopped) { await reader.cancel().catch(() => {}); break }
    }
    if (stopped) break
  }
  if (!stopped && buffer.trim()) dispatch(buffer)
  if (!stopped || !message) throw new Error('stream ended before message_stop')
  // a block index the stream skipped is no block at all (never a hole the readers below would trip on)
  return { ...(message as Record<string, unknown>), content: Array.from(content, obj).filter(b => Object.keys(b).length > 0) }
  } finally { signal.removeEventListener('abort', stop) }
}
export interface ClaudeSearchResult {
  outcome: 'ok' | 'partial' | 'unavailable'
  citedUrls: string[]
  preferredPublisherUrls: string[]
  buyerSourceUrls?: string[]
  // company_first: cf_runner stage 1 - the companies the model listed in its <json> answer (name, own website, posting URL). Untrusted
  // hints only: a posting URL is read through the board's own API, a website must pass the crawler's homepage name proof.
  textCandidates?: TextCandidate[]
  stop: ClaudeSearchEvidenceDiagnostic['stop']
  evidenceDiagnostic: ClaudeSearchEvidenceDiagnostic
  usage: ClaudeSearchUsage
  estimate: ClaudeSearchEstimate
}

// A caller supplies one reservation spanning every applicable scan/account cap. A reservation failure means zero paid sends.
// Once sent, any unknown billing keeps the hold and returns no candidate URLs. Neither transport nor response starts a second request.
export async function runClaudeWebSearch(
  apiKey: string, prompt: string,
  reserve: (estimate: ClaudeSearchEstimate) => Promise<ClaudeSearchHold | null> | ClaudeSearchHold | null,
  fetchImpl: typeof fetch = fetch, policy?: 'company_first',
): Promise<ClaudeSearchResult> {
  if (!apiKey.trim() || !prompt.trim() || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new ClaudeSearchError('invalid_input')
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  const countPayload = { model: CLAUDE_SEARCH_MODEL, messages: [{ role: 'user', content: prompt }] }
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: claudeSearchMaxUses(policy) }]
  let input: unknown
  try {
    const r = await fetchImpl(MESSAGE + '/count_tokens', { method: 'POST', headers, body: JSON.stringify(countPayload), signal: AbortSignal.timeout(20_000), redirect: 'error' })
    if (r.status === 401 || r.status === 403) throw new ClaudeSearchError('key_rejected')
    if (!r.ok) throw new ClaudeSearchError('count_failed')
    input = obj(await r.json()).input_tokens
  } catch (e) { if (e instanceof ClaudeSearchError) throw e; throw new ClaudeSearchError('count_failed') }
  if (!count(input)) throw new ClaudeSearchError('count_failed')
  const estimate = claudeSearchEstimate(input, policy)
  const hold = await reserve(estimate)
  if (!hold) throw new ClaudeSearchError('reservation_missing')
  let r: Response
  const stall = new AbortController()
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const alive = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => stall.abort(), CLAUDE_SEARCH_STALL_MS) }
  const signal = AbortSignal.any([stall.signal, AbortSignal.timeout(CLAUDE_SEARCH_TIMEOUT_MS)])
  alive()
  try {
    r = await fetchImpl(MESSAGE, {
      // The estimate/parser only support standard rates; the API default can select legacy Priority.
      method: 'POST', headers, body: JSON.stringify({ ...countPayload, tools, max_tokens: CLAUDE_SEARCH_MAX_OUTPUT, service_tier: 'standard_only', stream: true }),
      signal, redirect: 'error',
    })
  } catch {
    clearTimeout(stallTimer)
    await hold.uncertain()
    throw new ClaudeSearchError('request_uncertain', signal.aborted ? 'timeout' : 'transport')
  }
  alive()
  if (!r.ok) clearTimeout(stallTimer)
  if (r.status === 401 || r.status === 403) {
    // Authentication/permission refusal is known, but that does not mean the vendor billed zero.
    await hold.rejected(r.status)
    throw new ClaudeSearchError('key_rejected')
  }
  if (r.status === 429) {
    // Anthropic documents this HTTP status (returned before any event is streamed) as a request rejection.
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
    json = await readMessageStream(r, alive, signal)
  } catch {
    await hold.uncertain()
    throw new ClaudeSearchError('request_uncertain', signal.aborted ? 'timeout' : 'response_unreadable')
  } finally { clearTimeout(stallTimer) }
  const checked = checkUsage(json, true)
  if ('diagnostic' in checked) { await hold.uncertain(); throw new ClaudeSearchError('usage_uncertain', checked.diagnostic, rejectedUsage(json, checked.diagnostic)) }
  const { usage } = checked
  // Known actual is always settled, even if it exceeded the soft estimate or violated the claimed output/tool limits.
  await hold.settle(usage.usd, usage)
  if (usage.searches > claudeSearchMaxUses(policy) || usage.outputTokens > CLAUDE_SEARCH_MAX_OUTPUT)
    throw new ClaudeSearchError('provider_limit_violation')
  const root = obj(json), content = arr(root.content)
  const rawStop = root.stop_reason
  const stop = rawStop === 'end_turn' || rawStop === 'pause_turn' || rawStop === 'max_tokens' ? rawStop : 'other'
  // Counters saturate; never retain provider text, tool error codes, URLs or raw labels in diagnostics.
  const bounded = (n: number) => Math.min(1000, n + 1)
  let resultBlocks = 0, nonArrayBlocks = 0, resultEntries = 0
  let emptyBlocks = 0, malformedBlocks = 0
  const resultErrors: ClaudeSearchEvidenceDiagnostic['result_errors'] = {}
  const urls = new Set<string>()
  for (const block of content.map(obj)) {
    if (block.type !== 'web_search_tool_result') continue
    resultBlocks = bounded(resultBlocks)
    if (!Array.isArray(block.content)) {
      nonArrayBlocks = bounded(nonArrayBlocks)
      const err = obj(block.content)
      if (err.type === 'web_search_tool_result_error' && typeof err.error_code === 'string') {
        const code = resultErrorCode(err.error_code)
        resultErrors[code] = bounded(resultErrors[code] ?? 0)
      } else malformedBlocks = bounded(malformedBlocks)
      continue
    }
    if (!block.content.length) emptyBlocks = bounded(emptyBlocks)
    else if (block.content.some(v => { const r = obj(v); return r.type !== 'web_search_result' || typeof r.url !== 'string' }))
      malformedBlocks = bounded(malformedBlocks)
    for (const result of block.content.map(obj)) {
      if (result.type === 'web_search_result') resultEntries = bounded(resultEntries)
      if (result.type !== 'web_search_result' || typeof result.url !== 'string' || result.url.length > 480 || /\s/.test(result.url)) continue
      try {
        const u = new URL(result.url)
        if (u.protocol === 'https:' && !u.username && !u.password && !u.port && urls.size < 20) urls.add(u.href)
      } catch { /* not a valid absolute evidence URL */ }
    }
  }
  // A real search result must be charged/recorded and subsequently fetched through the app's own public-page guard.
  const citedUrls = usage.searches > 0 ? [...urls] : []
  // Text citations can rank only exact URLs already accepted from the charged tool results.
  const preferred = new Set<string>()
  const buyerSources = new Set<string>()
  if (citedUrls.length) for (const block of content.map(obj)) {
    if (block.type !== 'text') continue
    // Untrusted text can only label exact URLs from this charged tool result.
    // The regular result ranking stays intact; this is a separate company-first hint.
    if (policy === 'company_first' && typeof block.text === 'string' && block.text.length <= 16_384) {
      for (const line of block.text.split(/\r?\n/)) {
        const m = /^BUYER_SOURCE: (https:\/\/[^\s]{1,480})$/.exec(line.trim())
        if (m && urls.has(m[1]) && buyerSources.size < 10) buyerSources.add(m[1])
      }
    }
    for (const citation of arr(block.citations).map(obj)) {
      if (citation.type !== 'web_search_result_location' || typeof citation.url !== 'string' || citation.url.length > 480 || /\s/.test(citation.url)) continue
      try { const normalized = new URL(citation.url).href; if (urls.has(normalized)) preferred.add(normalized) } catch { /* not an admitted URL */ }
    }
  }
  const textCandidates = policy === 'company_first' && citedUrls.length
    ? parseTextCandidates(content.map(obj).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('').slice(0, 65_536)) : []
  return { preferredPublisherUrls: [...preferred], ...(textCandidates.length ? { textCandidates } : {}), ...(buyerSources.size ? { buyerSourceUrls: [...buyerSources] } : {}), outcome: !citedUrls.length ? 'unavailable' : nonArrayBlocks > 0 || stop !== 'end_turn' ? 'partial' : 'ok', citedUrls, stop, usage, estimate,
    evidenceDiagnostic: { stop, result_blocks: resultBlocks, non_array_result_blocks: nonArrayBlocks, empty_result_blocks: emptyBlocks, malformed_result_blocks: malformedBlocks, result_errors: resultErrors, result_entries: resultEntries, safe_urls: citedUrls.length },
  }
}
