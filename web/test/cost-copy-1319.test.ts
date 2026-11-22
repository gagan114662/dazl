// #1319 (Quest live check, prod 0bb5630, 2026-11-21): two cost lines contradicted themselves.
// 1. The run page read "Estimated $0.09 - $2.81 at start" and, in the same paragraph, "against an estimate of $0.09-$0.66": the second is
//    the MODEL part only and must say so.
// 2. The cost panel read "$3.33 left (daily limit binds)" when the run's own per-run limit was what bound the amount left.
import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateRun, compareActual, capLine } from '../lib/scan/price-estimate.ts'

test('the actual-vs-estimate line names the model estimate it compares against, never a bare "estimate"', () => {
  const est = estimateRun({ budget: { max_usd: 5 }, payer: 'you' })
  const priced = compareActual(est, { inputTokens: 20_000, outputTokens: 2_000, tokensComplete: true, model: 'claude-sonnet-4-5', searches: 3, reservedUsd: 0, requests: 4, requestsWithTokens: 4, cacheWriteTokens: 0, cacheReadTokens: 0 })
  assert.match(priced.summary, /against the model-request estimate of \$\d/)
  assert.doesNotMatch(priced.summary, /against an estimate of/)
  for (const a of [
    { inputTokens: null, outputTokens: null, tokensComplete: false, searches: 0, reservedUsd: 0, requests: 0, refusedBeforeSending: 2 },
    { inputTokens: null, outputTokens: null, tokensComplete: false, searches: 0, reservedUsd: 0, requests: 2, requestsWithTokens: 0 },
    { inputTokens: null, outputTokens: null, tokensComplete: false, searches: 0, reservedUsd: 0, requests: 0 },
  ]) {
    const s = compareActual(est, a).summary
    assert.match(s, /model-request estimate/, s)
    assert.doesNotMatch(s, /(?<!model-request )\b[Ee]stimate (was|\$)/, s)
  }
})

test('the amount left names the per-run limit when that is what binds, not the daily limit', () => {
  // the live shape: a $3.33 per-run limit under a larger daily limit with room left
  const run = estimateRun({ budget: { max_usd: 3.33 }, payer: 'you', ownerCapUsd: 10, reservedUsd: 1 })
  assert.ok(Math.abs((run.cap.remaining_usd ?? 0) - 3.33) < 1e-9)
  assert.equal(run.cap.binding, 'run')
  assert.match(capLine(run.cap, run.cap.capped_total)!, /\$3\.33 left \(this run's limit binds\)/)
  assert.doesNotMatch(capLine(run.cap, run.cap.capped_total)!, /daily limit binds/)
  // the daily limit still binds when its room is the smaller one
  const day = estimateRun({ budget: { max_usd: 3.33 }, payer: 'you', ownerCapUsd: 2, reservedUsd: 1 })
  assert.equal(day.cap.binding, 'daily'); assert.match(capLine(day.cap, day.cap.capped_total)!, /\$1\.00 left \(daily limit binds\)/)
  // a tie names the daily limit; a tighter month still names the month
  assert.equal(estimateRun({ budget: { max_usd: 1 }, payer: 'you', ownerCapUsd: 2, reservedUsd: 1 }).cap.binding, 'daily')
  assert.equal(estimateRun({ budget: { max_usd: 3.33 }, payer: 'you', ownerCapUsd: 10, reservedUsd: 1, ownerMonthCapUsd: 5, reservedMonthUsd: 4 }).cap.binding, 'monthly')
})

test('when the run limit binds under a day cap, the verdict names the run limit, not the day limit and its reservations', () => {
  const e = estimateRun({ budget: { max_usd: 0.01 }, payer: 'you', ownerCapUsd: 10, reservedUsd: 1 })
  assert.equal(e.verdict.ok, false)
  assert.match(e.verdict.message, /only \$0\.01 of your \$0\.01 limit is left\.$/)
  assert.doesNotMatch(e.verdict.message, /\$10\.00|already reserved/)
  assert.ok(e.verdict.change.some(c => /^Raise the dollar limit to at least \$0\.0\d /.test(c)), e.verdict.change.join(' | '))
})
