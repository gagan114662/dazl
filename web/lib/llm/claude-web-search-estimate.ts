// Pure, browser-safe estimate; no config, credentials, DB modules, or network.
export const CLAUDE_SEARCH_MODEL = 'claude-sonnet-4-5-20250929'
export const CLAUDE_SEARCH_MAX_USES = 2
export const CLAUDE_SEARCH_MAX_OUTPUT = 3_000
export const CLAUDE_SEARCH_ASSUMED_INPUT_PER_SEARCH = 25_000
const INITIAL_TOKEN_FACTOR = 1.2 // Anthropic calls count_tokens an estimate; the extra margin is local, not a hard bound.
const ASSUMED_TOOL_OVERHEAD = 1_000 // count_tokens rejects server tools; local allowance for the uncounted tool prompt.
export const USD_PER_SEARCH = 0.01
export const MICROS = 1_000_000

const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const roundedUp = (usd: number) => Math.ceil(usd * MICROS) / MICROS

export type ClaudeSearchFailure = 'invalid_input' | 'count_failed' | 'reservation_missing' | 'request_uncertain' | 'rate_limited' | 'key_rejected' | 'usage_uncertain' | 'provider_limit_violation'
export type ClaudeSearchUsageDiagnostic =
  | 'usage_envelope' | 'usage_model' | 'usage_geo' | 'usage_speed' | 'usage_tier'
  | 'usage_input_count' | 'usage_output_count' | 'usage_search_count' | 'usage_other_tool'
  | 'usage_cache_totals' | 'usage_cache_split' | 'usage_cost'
type UsageFieldState = 'absent' | 'null' | 'malformed'
export type ClaudeUsageCounter = number | UsageFieldState | 'outside_diagnostic_bound'
export type ClaudeUsageSnapshot = {
  rejection: ClaudeSearchUsageDiagnostic
  usage: 'object' | UsageFieldState
  model: typeof CLAUDE_SEARCH_MODEL | 'claude-sonnet-4-5' | 'unrecognized' | UsageFieldState
  inference_geo: 'global' | 'us' | 'unrecognized' | UsageFieldState
  speed: 'standard' | 'fast' | 'unrecognized' | UsageFieldState
  service_tier: 'standard' | 'priority' | 'batch' | 'unrecognized' | UsageFieldState
  input_tokens: ClaudeUsageCounter
  output_tokens: ClaudeUsageCounter
  cache_read_input_tokens: ClaudeUsageCounter
  cache_creation_input_tokens: ClaudeUsageCounter
  cache_creation: 'object' | UsageFieldState
  ephemeral_5m_input_tokens: ClaudeUsageCounter
  ephemeral_1h_input_tokens: ClaudeUsageCounter
  server_tool_use: 'object' | UsageFieldState
  web_search_requests: ClaudeUsageCounter
  web_fetch_requests: ClaudeUsageCounter
  other_tool_counts: 'none' | 'zero_only' | 'nonzero_or_invalid'
}
type ClaudeSearchDiagnostic = 'transport' | 'timeout' | 'http_error' | 'response_unreadable' | ClaudeSearchUsageDiagnostic
const claudeSearchFailure = Symbol('Claude search failure')
// Keep our handling specific without adding a new externally reported error class.
export class ClaudeSearchError {
  readonly code: ClaudeSearchFailure
  readonly diagnostic?: ClaudeSearchDiagnostic
  readonly usageSnapshot?: ClaudeUsageSnapshot
  constructor(code: ClaudeSearchFailure, diagnostic?: ClaudeSearchDiagnostic, usageSnapshot?: ClaudeUsageSnapshot) {
    this.code = code
    return Object.assign(new Error(code), { code, diagnostic, ...(usageSnapshot ? { usageSnapshot } : {}), [claudeSearchFailure]: true })
  }
  static [Symbol.hasInstance](error: unknown): boolean {
    return error instanceof Error && (error as Error & { [claudeSearchFailure]?: boolean })[claudeSearchFailure] === true
  }
}

export interface ClaudeSearchEstimate {
  readonly model: typeof CLAUDE_SEARCH_MODEL
  readonly countedInputTokens: number
  readonly assumedSearchInputTokens: number
  readonly assumedToolOverheadTokens: number
  readonly maxOutputTokens: number
  readonly maxSearches: number
  readonly estimatedUsd: number // soft: Anthropic has no request-level billed-input ceiling for server-side search
  readonly hard: false
}

export function claudeSearchEstimate(countedInputTokens: number): ClaudeSearchEstimate {
  if (!count(countedInputTokens) || countedInputTokens === 0 || countedInputTokens > 200_000) throw new ClaudeSearchError('count_failed')
  const assumedSearchInputTokens = CLAUDE_SEARCH_MAX_USES * CLAUDE_SEARCH_ASSUMED_INPUT_PER_SEARCH
  const estimatedUsd = roundedUp(((Math.ceil(countedInputTokens * INITIAL_TOKEN_FACTOR) + ASSUMED_TOOL_OVERHEAD + assumedSearchInputTokens) * 3 + CLAUDE_SEARCH_MAX_OUTPUT * 15) / MICROS + CLAUDE_SEARCH_MAX_USES * USD_PER_SEARCH)
  return { model: CLAUDE_SEARCH_MODEL, countedInputTokens, assumedSearchInputTokens, assumedToolOverheadTokens: ASSUMED_TOOL_OVERHEAD, maxOutputTokens: CLAUDE_SEARCH_MAX_OUTPUT, maxSearches: CLAUDE_SEARCH_MAX_USES, estimatedUsd, hard: false }
}
