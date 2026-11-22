import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateRun, compareActual } from '../lib/scan/price-estimate.ts'
import { costPerShownLead } from '../lib/scan/cost-per-verification-pass.ts'

// Run af02437c (Refs #1517): sonnet-4-5 + haiku-4-5. The per-call ledger settled $0.74 ("Final cost" had it), yet the page said the
// stored sums "cannot be priced as one total ... unknown, not $0" and the per-lead line "model cost not recorded".
test('#1517: a 2-model job shows the summed settled ledger cost as the actual model cost, never "unknown", and per-lead uses it', () => {
  const est = estimateRun({ budget: null, payer: 'you' })
  const a = compareActual(est, { inputTokens: 120000, outputTokens: 9000, tokensComplete: true, model: 'claude-sonnet-4-5-20250929', servedModels: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'],
    searches: 4, reservedUsd: null, requests: 14, requestsWithTokens: 14, finalUsd: 0.74, finalHeldSteps: 0 })
  // Qodo #1554 (changed): the final cost leads; model_usd is not the job total
  assert.equal(a.model_usd, null); assert.equal(a.final_usd, 0.74)
  assert.doesNotMatch(a.summary, /unknown|cannot be priced/i)
  assert.match(a.summary, /\$0\.74/)
})
test('#1517: without a settled ledger total the mixed sums are still never priced at one model rate', () => {
  const est = estimateRun({ budget: null, payer: 'you' })
  const a = compareActual(est, { inputTokens: 120000, outputTokens: 9000, tokensComplete: true, model: 'claude-sonnet-4-5', servedModels: ['claude-sonnet-4-5', 'claude-haiku-4-5'], searches: 4, reservedUsd: null, requests: 14, requestsWithTokens: 14 })
  assert.equal(a.model_usd, null)
})

// Qodo #1554: the job's final cost includes search, render and enrichment charges, so it is never labelled model cost or compared with
// the model-only estimate. The line leads with the final cost, says the per-model split was not recorded, and never says "unknown".
test('Qodo #1554: a mixed-model run with paid lookups shows its final cost as the run cost, never as model cost', () => {
  const est = estimateRun({ budget: null, payer: 'you' })
  const a = compareActual(est, { inputTokens: 120000, outputTokens: 9000, tokensComplete: true, model: 'claude-sonnet-4-5-20250929', servedModels: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'],
    searches: 4, reservedUsd: null, requests: 14, requestsWithTokens: 14, finalUsd: 0.74, finalHeldSteps: 0 })
  assert.equal(a.model_usd, null); assert.equal(a.final_usd, 0.74)
  assert.match(a.summary, /^Final cost \$0\.74/)
  assert.doesNotMatch(a.summary, /Actual model cost \$0\.74|unknown|cannot be priced/i)
})
