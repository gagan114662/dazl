// A free-trial scan has a real per-scan ceiling (DAZL_TRIAL_SCAN_RESERVE_USD: the job guard's limit, runner.ts), but the cost screen
// said "No dollar limit is set, so nothing here is a ceiling" and showed a worst case above it (staging trial-cap test, 2026-11-10).
import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateRun } from '../lib/scan/price-estimate.ts'

const trial = (extra: Record<string, unknown> = {}) => estimateRun({ budget: null, payer: 'trial', limited: true, ...extra } as never)

test('trial scan with a per-scan ceiling: the screen names it and no longer says nothing is a ceiling', () => {
  const e = trial({ trialReserveUsd: 0.3 })
  assert.match(e.verdict.message, /free trial stops each scan at \$0\.30/)
  assert.doesNotMatch(e.verdict.message, /No dollar limit|nothing here is a ceiling/)
  assert.equal(e.verdict.ok, true, 'a ceiling is not a refusal')
})

test('the worst case above the trial ceiling is called a possible early stop, not a total', () => {
  const e = trial({ trialReserveUsd: 0.3 })
  assert.ok(e.total.max > 0.3, 'precondition: the model rows can price above the ceiling')
  assert.match(e.verdict.warning ?? '', /above the trial's \$0\.30 limit per scan/)
  assert.match(e.verdict.warning ?? '', /stop early as a budget stop/)
  const high = trial({ trialReserveUsd: 5 })
  assert.equal(high.verdict.warning, null, 'worst case under the ceiling: no warning')
})

test('without a usable ceiling, or for a run on the person\'s own key, the old wording stays (no invented ceiling)', () => {
  for (const bad of [undefined, null, 0, -1, NaN, Infinity, '0.30', {}]) {
    assert.match(trial({ trialReserveUsd: bad }).verdict.message, /No dollar limit/, `reserve ${String(bad)}`)
  }
  assert.match(estimateRun({ budget: null, payer: 'you', trialReserveUsd: 0.3 } as never).verdict.message, /No dollar limit/)
})

test('the ceiling changes what the person confirms: the confirmation id differs with and without it', () => {
  assert.notEqual(trial({ trialReserveUsd: 0.3 }).ack, trial().ack)
  assert.notEqual(trial({ trialReserveUsd: 0.3 }).ack, trial({ trialReserveUsd: 0.4 }).ack)
})
