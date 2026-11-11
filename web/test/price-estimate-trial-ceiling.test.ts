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

// Hermes-PC review of 5fd138c1: the trial ceiling must hold when another dollar limit exists, and the assumptions must not contradict the screen.
test('trial reserve tighter than the run\'s own max_usd: the screen names the TRIAL limit, with the warning', () => {
  const e = trial({ trialReserveUsd: 0.3, budget: { max_usd: 5 } })
  assert.doesNotMatch(e.verdict.message, /fits the \$5\.00 left/)
  assert.match(e.verdict.message, /free trial stops each scan at \$0\.30/)
  assert.match(e.verdict.warning ?? '', /above the trial's \$0\.30 limit per scan/)
  assert.equal(e.verdict.ok, true)
})
test('owner cap tighter than the trial reserve: the owner cap stays the ceiling named', () => {
  const e = trial({ trialReserveUsd: 5, ownerCapUsd: 0.4 })
  assert.doesNotMatch(e.verdict.message, /free trial stops/)
  assert.match(e.verdict.message + (e.verdict.warning ?? ''), /\$0\.40/)
})
test('trial reserve with ownerCapUsd 2: trial limit is the tighter and is named', () => {
  const e = trial({ trialReserveUsd: 0.3, ownerCapUsd: 2 })
  assert.match(e.verdict.message, /free trial stops each scan at \$0\.30/)
})
test('the confirmation id changes with the reserve in every branch, including when max_usd is set', () => {
  assert.notEqual(trial({ trialReserveUsd: 0.3, budget: { max_usd: 5 } }).ack, trial({ trialReserveUsd: 0.4, budget: { max_usd: 5 } }).ack)
  assert.notEqual(trial({ trialReserveUsd: 0.3, budget: { max_usd: 5 } }).ack, trial({ budget: { max_usd: 5 } }).ack)
})
test('the assumptions agree with the screen: they name the trial\'s per-scan limit, and keep the old line otherwise', () => {
  const a = trial({ trialReserveUsd: 0.3 }).assumptions.join(' ')
  assert.match(a, /free trial's \$0\.30 limit per scan stop a run/)
  assert.doesNotMatch(a, /Only the dollar limit \(when set\) stops a run/)
  assert.match(trial().assumptions.join(' '), /Only the dollar limit \(when set\) stops a run/)
})
