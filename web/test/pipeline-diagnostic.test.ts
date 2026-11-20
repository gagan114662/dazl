import assert from 'node:assert/strict'
import test from 'node:test'
import { currentScanPipelineDiagnostic, nativeToolObservation, scanPipelineDiagnostic, stopHint } from '../lib/scan/pipeline-diagnostic.ts'

const empty = {
  stop: 'end_turn', result_blocks: 1, empty_result_blocks: 1, non_array_result_blocks: 0,
  malformed_result_blocks: 0, result_entries: 0, result_errors: {},
}
test('native tool errors, empty results and unknown or incomplete replies stay distinct', () => {
  assert.deepEqual(nativeToolObservation(empty), { outcome: 'empty', is_error: false, result_blocks: 1, empty_blocks: 1, error_blocks: 0, hints: [] })
  assert.equal(nativeToolObservation({ ...empty, stop: 'pause_turn' }).outcome, 'unknown')
  assert.deepEqual(nativeToolObservation({ ...empty, stop: 'pause_turn' }).hints, ['review_provider_pause_no_replay'])
  assert.equal(nativeToolObservation({ ...empty, stop: 'max_tokens' }).outcome, 'unknown')
  assert.deepEqual(nativeToolObservation({ ...empty, stop: 'max_tokens' }).hints, ['review_output_limit_no_replay'])
  assert.equal(nativeToolObservation({ ...empty, stop: 'end_turn', result_blocks: 0, empty_result_blocks: 0 }).is_error, null)
  assert.equal(nativeToolObservation({ ...empty, malformed_result_blocks: 1 }).is_error, null)
  assert.equal(nativeToolObservation({ ...empty, empty_result_blocks: 0, result_entries: 2 }).outcome, 'results')
  assert.equal(nativeToolObservation({ ...empty, empty_result_blocks: 0 }).outcome, 'unknown')
  const raw = { ...empty, result_blocks: 2, non_array_result_blocks: 1, result_errors: { unavailable: 1, private_provider_text: 99 } }
  assert.deepEqual(nativeToolObservation(raw), { outcome: 'tool_error', is_error: true, result_blocks: 2, empty_blocks: 1, error_blocks: 1,
    hints: ['review_source_availability'] })
  assert.deepEqual(nativeToolObservation({ ...raw, result_errors: Object.fromEntries([
    'too_many_requests', 'invalid_tool_input', 'max_uses_exceeded', 'query_too_long', 'request_too_large', 'unavailable', 'other',
  ].map(code => [code, 1])) }).hints, [
    'provider_rate_limited', 'review_tool_input', 'keep_tool_limit', 'shorten_request', 'reduce_request_size',
    'review_source_availability', 'inspect_recorded_stage',
  ])
})

test('reports actual distinct reads and fates; never invents quote or impression counts', () => {
  const unknown = scanPipelineDiagnostic(null, null)
  assert.equal(unknown.tinyfish_pages_read, null)
  assert.equal(unknown.native_publisher_attempted, null)
  assert.equal(unknown.verified, null)
  const actual = scanPipelineDiagnostic({
    query: 'private query', candidates: [{ company: 'private name', url: 'private URL' }],
    extraction: { requested: 5, fetched: 4, fetch_failed: 1 },
    extracted_candidates: 4, evidence: { items: 4, with_page_text: 3, snippet_only: 1 },
    search: { attempted: 1, hits_unique_urls: 5 }, news: { attempted: 0 },
    native_web_search: { evidence_diagnostic: {
      ...empty, empty_result_blocks: 0, result_entries: 6, safe_urls: 4,
      publisher_attempted: 4, publisher_returned: 3, publisher_usable: 2, evidence_items: 2, publisher_failures: { blocked: 1 },
    } },
    resolution: { candidates: 3, resolved: 0, unresolved: 3 },
    funnel: { verified: 0, needs_review: 1, dropped: 3, review_reasons: { quote_unconfirmed: 1 }, drop_reasons: { excerpt_not_on_page: 1 } },
  }, 'no_candidates', 1)
  assert.deepEqual([actual.native_results, actual.native_safe_result_urls, actual.native_publisher_attempted, actual.native_publisher_returned,
    actual.native_publisher_failures_recorded, actual.native_publisher_usable, actual.extraction_candidates,
    actual.quote_validated, actual.quote_unconfirmed_review, actual.verified, actual.held, actual.rejected, actual.shown],
  [6, 4, 4, 3, 1, 2, 4, null, 1, 0, 1, 3, null])
  assert.equal(actual.news_search_requests, 0)
  assert.equal(actual.quote_missing_rejected, 1)
  assert.equal(actual.resolution_proven, 0)
  assert.equal(actual.persisted_rows, 1)
  assert.equal(actual.native_rejected_urls, null, 'entries also include duplicates; no subtraction')
  assert.equal(actual.stop_hint, 'inspect_evidence_coverage')
  assert.doesNotMatch(JSON.stringify(actual), /private/)
})
test('terminal error overrides staged reason; unrecognized text never escapes', () => {
  assert.equal(scanPipelineDiagnostic({ stop: { code: 'no_candidates' } }, 'accounting_uncertain').stop_hint, 'review_accounting_no_replay')
  assert.equal(scanPipelineDiagnostic({ stop: { code: 'native_search_estimate_exceeded' } }, null).stop_hint, 'review_actual_cost_no_replay')
  assert.equal(stopHint('secret sent by provider'), 'inspect_recorded_stage')
  assert.equal(stopHint('__proto__'), 'inspect_recorded_stage')
  assert.equal(stopHint(null), null)
})

test('status diagnostics never borrow a previous attempt’s counts', () => {
  const older = { attempt: 1, report: { attempt: 2, search: { attempted: 4 }, stop: { code: 'no_discovery' } } }
  const current = { attempt: 2, report: { search: { attempted: 0 }, funnel: { verified: 0 } } }
  assert.equal(currentScanPipelineDiagnostic([older], 2, null).tinyfish_search_requests, null)
  assert.equal(currentScanPipelineDiagnostic([older, current], 2, null).tinyfish_search_requests, 0)
  const pending = currentScanPipelineDiagnostic([older, current], 3, null)
  assert.equal(pending.tinyfish_search_requests, null)
  assert.equal(pending.stop_hint, null)
  assert.equal(currentScanPipelineDiagnostic([older, null, current], 2, 'cancelled').stop_hint, 'stopped_by_request')
})
