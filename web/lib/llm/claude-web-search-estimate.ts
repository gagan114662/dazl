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
const claudeSearchFailure = Symbol('Claude search failure')
// Keep our handling specific without adding a new externally reported error class.
export class ClaudeSearchError {
  readonly code: ClaudeSearchFailure
  constructor(code: ClaudeSearchFailure) {
    this.code = code
    return Object.assign(new Error(code), { code, [claudeSearchFailure]: true })
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
