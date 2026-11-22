import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateRun, compareActual } from '../lib/scan/price-estimate.ts'

// PM 2026-11-22 (Gagan's no-hedge rule): a run whose model cost cannot be priced shows "Final cost $X." when the job has a final cost,
// otherwise nothing - never "unknown" or "not $0".
const HEDGE = /unknown|not \$0|cannot be priced|no USD cost/i
const est = estimateRun({ budget: null, payer: 'you' })
const base = { tokensComplete: true, searches: 4, reservedUsd: null, requests: 14, requestsWithTokens: 14 }
const cases = {
  'mixed models, ledger not settled': { ...base, inputTokens: 120000, outputTokens: 9000, model: 'claude-sonnet-4-5', servedModels: ['claude-sonnet-4-5', 'claude-haiku-4-5'] },
  'one unpriced model': { ...base, inputTokens: 120000, outputTokens: 9000, model: 'some-unlisted-model', servedModels: ['some-unlisted-model'] },
  'no token usage reported': { ...base, inputTokens: null, outputTokens: null, requestsWithTokens: 0, model: 'claude-sonnet-4-5', servedModels: ['claude-sonnet-4-5'] },
}
for (const [name, a] of Object.entries(cases)) {
  test(`PM no-hedge: ${name} - "Final cost $X." with a final cost`, () => {
    const r = compareActual(est, { ...a, finalUsd: 0.5, finalHeldSteps: 2 } as never)
    assert.equal(r.summary, 'Final cost $0.50.')
  })
  test(`PM no-hedge: ${name} - nothing without a final cost`, () => {
    const r = compareActual(est, { ...a, finalUsd: null, finalHeldSteps: null } as never)
    assert.equal(r.summary, '')
    assert.doesNotMatch(r.summary, HEDGE)
  })
}
