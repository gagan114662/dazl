// #1157 family: one source erroring must not decide a scan's stop on its own. The stop is read from the source rows
// (fallbackStopCode) and shown through scanOutcome. The first case is the real prod job 1f40457c7831de1dd34a7195
// (austin-roofing, 2026-11-14): search:tinyfish skipped_cap, search:news error:network, the paid fallback held.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fallbackStopCode, refusalCode } from '../lib/scan/runner.ts'
import { SourceRunLedger } from '../lib/scan/source-runs.ts'
import { SpendRefused } from '../lib/llm/spend-guard.ts'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'
import { first5Of } from '../lib/scan/first5.ts'

const at = (news: string | null, tf: string | null) => { const l = new SourceRunLedger(); if (news) l.record('search:news', news); if (tf) l.record('search:tinyfish', tf); return l }
const code = (news: string | null, tf: string | null) => fallbackStopCode(at(news, tf))

test('the prod shape: web search refused by the allowance + news unreachable is the ALLOWANCE stop, through the refusal path too', () => {
  assert.equal(code('error:network', 'skipped_cap'), 'search_allowance_reached')
  assert.equal(refusalCode(new SpendRefused('research_unbounded'), at('error:network', 'skipped_cap')), 'search_allowance_reached')
})

test('one source failed, the other searched clean and found nothing: the search concluded with a source missing (no_discovery), not a failure', () => {
  for (const tf of ['empty', 'no_candidates', 'ok']) for (const news of ['error', 'error:network', 'error:model_retry', 'limited']) assert.equal(code(news, tf), 'no_discovery', `${news} + ${tf}`)
  for (const news of ['empty', 'no_candidates']) for (const tf of ['error', 'limited']) assert.equal(code(news, tf), 'no_discovery', `${news} + ${tf}`)
})

test('source_error only when a source failed and NO source ran clean', () => {
  assert.equal(code('error:network', null), 'source_error', 'news failed, the web search never ran')
  assert.equal(code('error:network', 'skipped_hold'), 'source_error')
  assert.equal(code('error', 'error'), 'source_error', 'both failed')
  assert.equal(code('limited', 'unavailable'), 'source_error', 'news throttled, the web search could not conclude')
  assert.equal(code(null, 'error'), 'source_error')
  assert.equal(code('skipped_disabled', 'error'), 'source_error')
  assert.equal(code('unavailable', 'error'), 'source_error')
})

test('the unchanged cases: clean zero, could-not-conclude, allowance without a failure', () => {
  assert.equal(code('empty', null), 'no_discovery'); assert.equal(code('skipped_disabled', 'empty'), 'no_discovery')
  assert.equal(code('unavailable', null), 'unbounded_fallback_hold'); assert.equal(code('skipped_disabled', 'skipped_hold'), 'unbounded_fallback_hold'); assert.equal(code('unavailable', 'unavailable'), 'unbounded_fallback_hold')
  assert.equal(code('empty', 'skipped_cap'), 'search_allowance_reached'); assert.equal(code('skipped_disabled', 'skipped_cap'), 'search_allowance_reached')
})

test('what the person reads: the allowance stop names the failed source beside it; a degraded search says which source was skipped; neither says "Failed"', () => {
  const failed = { status: 'failed', candidates: 0, verified: 0, needs_review: 0, failed_sources: ['News articles'] }
  const allowance = scanOutcome({ ...failed, error: 'search_allowance_reached' } as never)
  assert.equal(allowance.kind, 'stopped'); assert.equal(allowance.label, 'Stopped - the web search allowance for today was used up')
  assert.match(allowance.detail ?? '', /Also, News articles had an error and gave nothing either\.$/)
  const degraded = scanOutcome({ ...failed, error: 'no_discovery' } as never)
  assert.equal(degraded.kind, 'stopped'); assert.equal(degraded.label, 'Nothing found - News articles could not be searched')
  assert.match(degraded.detail ?? '', /skipped source may have had results/)
  const clean = scanOutcome({ ...failed, failed_sources: [], error: 'no_discovery' } as never)
  assert.equal(clean.label, 'Nothing found in the sources this run could use')
  const plain = scanOutcome({ ...failed, failed_sources: [], error: 'search_allowance_reached' } as never)
  assert.ok(!/Also,/.test(plain.detail ?? ''))
  // a real source failure with nothing clean still says Failed and names the source
  assert.equal(scanOutcome({ ...failed, error: 'source_error' } as never).label, 'Failed - News articles had an error')
})

test('a first play shows the same words: the allowance stop is not replaced by "Failed - search:news had an error"', () => {
  const progress = [{ source: 'search:news', state: 'done', status: 'failed', note: 'network', candidates: 0, accepted: 0, review: 0, rejected: 0 }, { source: 'search:tinyfish', state: 'done', status: 'skipped', note: null, candidates: 0, accepted: 0, review: 0, rejected: 0 }]
  const rec = { status: 'failed', candidates: 0, verified: 0, needs_review: 0, failed_sources: ['search:news (network)'] }
  const view = (error: string) => first5Of({ status: 'failed', leads: [], progress: progress as never, outcome: scanOutcome({ ...rec, error } as never) })
  const allowance = view('search_allowance_reached')
  assert.match(allowance.message, /^Stopped - the web search allowance for today was used up: /); assert.match(allowance.message, /Also, search:news \(network\) had an error and gave nothing either\./)
  assert.ok(!/^Failed/.test(allowance.message)); assert.notEqual(allowance.reason, 'failed'); assert.deepEqual(allowance.failed_sources, ['search:news'])
  const degraded = view('no_discovery')
  assert.match(degraded.message, /^Nothing found - search:news \(network\) could not be searched: /); assert.notEqual(degraded.reason, 'failed')
  // the shortcut still applies where it was meant: a stop that does not account for the failed source
  const held = view('unbounded_fallback_hold')
  assert.equal(held.message, 'Failed - search:news had an error. You can search wider.'); assert.equal(held.reason, 'failed')
})
