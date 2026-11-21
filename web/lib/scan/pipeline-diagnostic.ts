// Counts-only projection of observations that already exist. This module does
// not inspect page text, classify lead validity, or make a provider call.
type Block = Record<string, unknown>
const obj = (value: unknown): Block => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Block : {}
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

const TOOL_HINTS = {
  too_many_requests: 'provider_rate_limited',
  invalid_tool_input: 'review_tool_input',
  max_uses_exceeded: 'keep_tool_limit',
  query_too_long: 'shorten_request',
  request_too_large: 'reduce_request_size',
  unavailable: 'review_source_availability',
  other: 'inspect_recorded_stage',
} as const
type ToolHint = typeof TOOL_HINTS[keyof typeof TOOL_HINTS] | 'review_provider_pause_no_replay' | 'review_output_limit_no_replay'

export function nativeToolObservation(value: unknown) {
  const d = obj(value)
  const errors = obj(d.result_errors)
  const hints = new Set<ToolHint>()
  let errorBlocks = 0
  for (const [code, hint] of Object.entries(TOOL_HINTS)) {
    const n = count(errors[code])
    if (n !== null && n > 0) { errorBlocks += n; hints.add(hint) }
  }
  const blocks = count(d.result_blocks), empty = count(d.empty_result_blocks)
  const nonArray = count(d.non_array_result_blocks), malformed = count(d.malformed_result_blocks)
  const entries = count(d.result_entries)
  const fullyObserved = blocks !== null && blocks > 0 && malformed === 0 && nonArray === 0 && empty !== null && empty <= blocks
  const is_error = errorBlocks > 0 ? true : fullyObserved && entries !== null && (empty === blocks ? entries === 0 : entries > 0) ? false : null
  // A provider pause or truncated reply is not a complete empty search.
  const outcome = is_error === true ? 'tool_error'
    : d.stop !== 'end_turn' || is_error === null ? 'unknown'
    : entries === 0 && empty === blocks ? 'empty'
    : entries && entries > 0 ? 'results' : 'unknown'
  if (d.stop === 'pause_turn') hints.add('review_provider_pause_no_replay')
  else if (d.stop === 'max_tokens') hints.add('review_output_limit_no_replay')
  else if (outcome === 'unknown' && blocks !== null) hints.add('inspect_recorded_stage')
  return { outcome, is_error, result_blocks: blocks, empty_blocks: empty, error_blocks: errorBlocks || (is_error === false ? 0 : null), hints: [...hints] }
}

const STOP_HINTS = {
  no_candidates: 'inspect_evidence_coverage',
  no_discovery: 'inspect_evidence_coverage',
  no_lead_source: 'review_source_availability',
  unbounded_fallback_hold: 'keep_paid_fallback_off',
  source_error: 'review_source_availability',
  search_allowance_reached: 'review_search_allowance',
  budget_stopped: 'review_budget_receipt',
  trial_budget_reached: 'review_budget_receipt',
  trial_unavailable: 'review_trial_availability',
  model_unpriced: 'review_model_setup',
  spend_count_failed: 'review_estimation',
  spend_config_invalid: 'review_budget_configuration',
  spend_refused: 'inspect_recorded_stage',
  spend_accounting_unavailable: 'review_accounting',
  accounting_failed: 'review_accounting_no_replay',
  accounting_uncertain: 'review_accounting_no_replay',
  provider_rate_limited: 'review_provider_status_no_replay',
  provider_rejected: 'review_provider_status_no_replay',
  native_search_accounting_pending: 'review_accounting_no_replay',
  native_search_provider_limit: 'review_provider_limits_no_replay',
  native_search_estimate_exceeded: 'review_actual_cost_no_replay',
  ownership_lost: 'review_attempt_ownership',
  scan_timeout: 'review_run_time',
  cancelled: 'stopped_by_request',
  key_unreadable: 'review_key_configuration',
  no_api_key: 'review_key_configuration',
  key_rejected: 'review_key_configuration',
  trial_key_invalid: 'review_trial_availability',
} as const
export function stopHint(value: unknown) {
  if (typeof value !== 'string' || !value) return null
  return Object.hasOwn(STOP_HINTS, value) ? STOP_HINTS[value as keyof typeof STOP_HINTS] : 'inspect_recorded_stage'
}

// An existing final-attempt report is optional. Its search scopes intentionally
// remain distinct: native tool result entries are not all organic search hits.
export function scanPipelineDiagnostic(report: unknown, jobError: unknown, storedRows?: unknown) {
  const r = obj(report), search = obj(r.search), extraction = obj(r.extraction), evidence = obj(r.evidence)
  const native = obj(obj(r.native_web_search).evidence_diagnostic)
  const funnel = obj(r.funnel), reviewReasons = obj(funnel.review_reasons), drops = obj(funnel.drop_reasons)
  const resolution = obj(r.resolution)
  const tool = nativeToolObservation(native)
  const readFailures = obj(native.publisher_failures)
  const sparseFetchCount = Object.keys(readFailures).length > 0
    ? Object.values(readFailures).reduce<number | null>((sum, value) => {
      const n = count(value)
      return sum === null || n === null ? null : sum + n
    }, 0) : null
  return {
    tinyfish_search_requests: count(search.attempted), tinyfish_unique_results: count(search.hits_unique_urls),
    tinyfish_pages_requested: count(extraction.requested), tinyfish_pages_read: count(extraction.fetched),
    tinyfish_page_read_failures: count(extraction.fetch_failed), news_search_requests: count(obj(r.news).attempted),
    native_results: count(native.result_entries), native_safe_result_urls: count(native.safe_urls), native_rejected_urls: null,
    native_publisher_attempted: count(native.publisher_attempted), native_publisher_returned: count(native.publisher_returned),
    native_publisher_failures_recorded: sparseFetchCount, native_publisher_usable: count(native.publisher_usable),
    native_evidence_items: count(native.evidence_items),
    evidence_items: count(evidence.items), evidence_with_page_text: count(evidence.with_page_text), evidence_snippet_only: count(evidence.snippet_only),
    extraction_candidates: count(r.extracted_candidates),
    resolution_checked: count(resolution.candidates), resolution_proven: count(resolution.resolved),
    quote_unconfirmed_review: count(reviewReasons.quote_unconfirmed), quote_missing_rejected: count(drops.excerpt_not_on_page),
    // Final verifier counts are not a quote validation count or UI impression.
    quote_validated: null, verified: count(funnel.verified), held: count(funnel.needs_review),
    rejected: count(funnel.dropped), persisted_rows: count(storedRows), shown: null, tool,
    stop_hint: stopHint(jobError ?? obj(r.stop).code),
  }
}

// readRunReportRows returns the authoritative DB attempt. A re-claimed job must never inherit
// diagnostic counts from an earlier failed or completed attempt.
export function currentScanPipelineDiagnostic(reports: unknown, attempts: unknown, jobError: unknown, storedRows?: unknown, terminal = false) {
  const attempt = count(attempts)
  const row = attempt === null || !Array.isArray(reports) ? null : reports.findLast(r => obj(r).attempt === attempt)
  // A newly claimed (non-terminal) retry can still carry the last attempt's job.error.
  // A terminal job's error was written by its current attempt, even when that attempt
  // failed before writing a report row, so it still explains the stop.
  return scanPipelineDiagnostic(obj(row).report, row || terminal ? jobError : null, storedRows)
}
