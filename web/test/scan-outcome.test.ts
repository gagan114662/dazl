import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanOutcome, type ReportSummary } from '../lib/scan/outcome.ts'

const rep = (o: Partial<ReportSummary> = {}): ReportSummary => ({ searches_attempted: 4, searches_ok: 4, hits_unique_urls: 0, hits_complete: true, searches_failed: null, extracted: 0, review_reasons: {}, drop_reasons: {}, ...o })
const failedNoCand = { status: 'failed', error: 'no_candidates', candidates: 0 }
test('a failed scan whose searches errored is "search failed" with the reason, not "no candidates found"', () => {
  const o = scanOutcome(failedNoCand, rep({ searches_ok: 1, hits_complete: false, searches_failed: { rate: 2, timeout: 1 } }))
  assert.equal(o.kind, 'search_failed'); assert.match(o.detail, /2 rate, 1 timeout/); assert.match(o.detail, /1 of 4 searches answered/); assert.match(o.detail, /Nothing was concluded/); assert.ok(o.next_step)
  assert.equal(scanOutcome(failedNoCand, rep({ searches_attempted: 0, searches_ok: 0, hits_complete: null })).kind, 'search_failed')
})
test('a search that answered everywhere with zero matches is "no matches"; results that matched nothing say how many', () => {
  const none = scanOutcome(failedNoCand, rep()); assert.equal(none.kind, 'no_matches'); assert.match(none.detail, /returned no results/)
  const some = scanOutcome(failedNoCand, rep({ hits_unique_urls: 6 })); assert.equal(some.kind, 'no_matches'); assert.match(some.detail, /6 result pages/)
})
test('candidates found but none qualified is "all rejected" with counts per reason (verifier drops and review lanes)', () => {
  const o = scanOutcome({ status: 'done', candidates: 6, verified: 0, needs_review: 3, dropped: 3 }, rep({ review_reasons: { outside_window: 2, blocked_by_site: 1 }, drop_reasons: { entity_mismatch: 3 } }))
  assert.equal(o.kind, 'all_rejected'); assert.deepEqual(o.reasons, { entity_mismatch: 3, 'review: outside_window': 2, 'review: blocked_by_site': 1 }); assert.match(o.detail, /6 candidates found, none passed/); assert.match(o.next_step, /review list/)
})
test('completed, queued, running, stopped and key errors each read differently; an old scan with no report says the cause is not recorded', () => {
  assert.equal(scanOutcome({ status: 'done', candidates: 2, verified: 1, needs_review: 1 }, null).kind, 'completed')
  assert.equal(scanOutcome({ status: 'pending' }, null).kind, 'queued'); assert.equal(scanOutcome({ status: 'running' }, null).kind, 'running')
  for (const e of ['budget_stopped', 'cancelled', 'scan_timeout']) assert.equal(scanOutcome({ status: 'failed', error: e }, null).kind, 'stopped', e)
  const k = scanOutcome({ status: 'failed', error: 'key_rejected' }, null); assert.equal(k.kind, 'search_failed'); assert.match(k.next_step, /model key/)
  const old = scanOutcome(failedNoCand, null); assert.equal(old.kind, 'no_candidates_unknown'); assert.match(old.detail, /not recorded/)
})
